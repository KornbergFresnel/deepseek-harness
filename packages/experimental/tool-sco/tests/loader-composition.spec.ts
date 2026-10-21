import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import ScoGateway from '@deepseek-ai/dsh-experimental-sco'
import ScoSubmit from '@deepseek-ai/dsh-experimental-sco-submit'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as ToolSco from '../src/index.ts'
import { fakeSco } from '../../sco/tests/fake-sco.ts'
import type { FakeSco } from '../../sco/tests/fake-sco.ts'

let context: Context | undefined
let root: string | undefined
let fake: FakeSco | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  for (const path of [root, fake?.root]) if (path !== undefined) await rm(path, { recursive: true, force: true })
  root = undefined
  fake = undefined
})

async function boot(toolConfig: string[] = [], submit = false): Promise<{ ctx: Context; agent: Agent }> {
  root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-tool-sco-loader-')))
  fake = await fakeSco()
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-user-approval', ApprovalService],
    ['@deepseek-ai/dsh-subprocess-local', LocalSubprocessRuntime],
    ['@deepseek-ai/dsh-experimental-sco', ScoGateway],
    ...submit
      ? [
        ['@deepseek-ai/dsh-storage', Storage],
        ['@deepseek-ai/dsh-storage-json', StorageJson],
        ['@deepseek-ai/dsh-storage-domain', StorageDomain],
        ['@deepseek-ai/dsh-experimental-sco-submit', ScoSubmit],
      ] as const
      : [],
    ['@deepseek-ai/dsh-experimental-tool-sco', ToolSco],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop],
  ])
  const config = [...modules.keys()].flatMap(name => [
    `- name: 'cordis:${name}'`,
    ...name === '@deepseek-ai/dsh-experimental-sco' ? ['  config:', `    command: '${fake!.command}'`, '    workspace: team-a', '    maxOutputBytes: 2048'] : [],
    ...name === '@deepseek-ai/dsh-experimental-tool-sco' && toolConfig.length > 0 ? ['  config:', ...toolConfig.map(line => `    ${line}`)] : [],
    ...name === '@deepseek-ai/dsh-agent-loop' ? ['  config:', '    agents: []'] : [],
    ...name === '@deepseek-ai/dsh-storage-json' ? ['  config:', `    root: '${join(root!, 'store')}'`] : [],
    ...name === '@deepseek-ai/dsh-storage-domain' ? ['  config:', '    backend: json'] : [],
    ...name === '@deepseek-ai/dsh-experimental-sco-submit'
      ? ['  config:', '    templates:', '      wbt-train:', '        image: registry/rlh:wbt', '        code: rlh', '        output: outputs', '        command: python train.py']
      : [],
  ]).join('\n') + '\n'
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, config)
  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  for (const [specifier, plugin] of modules) ctx.loader.builtins[specifier] = plugin
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  const agent = await ctx.agentLoop.create(SessionId('tool-sco-loader'), {}, { cwd: root })
  // Approval audit events must be enclosed by a turn.
  agent.session.append('turn/start', { turn: 1 })
  return { ctx, agent }
}

function call(ctx: Context, agent: Agent, name: string, args: Record<string, JsonValue>) {
  return ctx.tools.execute({ name, callId: ToolCallId(`${name}-${Math.random()}`), arguments: args, agent, signal: new AbortController().signal })
}

function text(result: { content: readonly { type: string; text?: string }[] }): string {
  return result.content.flatMap(block => block.type === 'text' && block.text !== undefined ? [block.text] : []).join('\n')
}

describe('SSP job tools through real Loader composition', () => {
  it('reads jobs, asks before submission and stop, and unregisters on disposal', async () => {
    const { ctx, agent } = await boot()
    const asked: ApprovalRequest[] = []
    let outcome: ApprovalOutcome = 'rejected'
    ctx.on('approval/request', (request) => {
      asked.push(request)
      return Promise.resolve(outcome)
    })

    const list = await call(ctx, agent, 'sco_job_list', { filters: [{ field: 'state', value: 'RUNNING' }] })
    expect(list.value).toEqual({ jobs: [{ name: 'job-a', state: 'RUNNING' }] })
    expect(text(list)).toBe(JSON.stringify(list.value))
    expect((await call(ctx, agent, 'sco_job_describe', { name: 'job-wbt' })).value).toEqual({ name: 'job-wbt', state: 'RUNNING' })
    expect((await call(ctx, agent, 'sco_job_workers', { name: 'job-wbt' })).value).toEqual([{ name: 'job-wbt-worker-0' }])
    const logs = await call(ctx, agent, 'sco_job_logs', { name: 'job-wbt', worker: 'job-wbt-worker-0' })
    expect(logs.value).toEqual({ text: 'step 1 loss=0.5\n', truncated: false })
    expect(text(logs)).toBe('step 1 loss=0.5\n')

    const spec = { name: 'job-wbt', image: 'registry/rlh:wbt', args: 'python train.py', gpuCount: 8, machineType: 'h1', env: { WANDB_MODE: 'offline' } }
    const dryRun = await call(ctx, agent, 'sco_job_create', { ...spec, dryRun: true })
    expect(dryRun.value).toEqual({ kind: 'dry-run', job: { name: 'job-wbt', spec: {} } })
    expect(asked).toHaveLength(0)

    const rejected = await call(ctx, agent, 'sco_job_create', spec)
    expect(rejected.isError).toBe(true)
    expect(asked.map(request => [request.toolName, request.reason])).toEqual([['sco_job_create', 'submit SSP training job job-wbt']])
    outcome = 'allowed-once'
    const created = await call(ctx, agent, 'sco_job_create', spec)
    expect(created.value).toEqual({ kind: 'created', name: 'job-wbt', output: 'created job-wbt' })
    const stopped = await call(ctx, agent, 'sco_job_stop', { names: ['job-wbt'] })
    expect(stopped.value).toEqual({ names: ['job-wbt'], output: 'stopped' })
    expect(asked.map(request => request.reason)).toEqual([
      'submit SSP training job job-wbt', 'submit SSP training job job-wbt', 'stop SSP training jobs job-wbt',
    ])

    const calls = (await fake!.calls()).map(argv => argv.slice(1, 3))
    expect(calls).toEqual([
      ['jobs', 'list'], ['jobs', 'describe'], ['jobs', 'get-workers'], ['jobs', 'stream-logs'],
      ['jobs', 'create'], ['jobs', 'create'], ['jobs', 'stop'],
    ])
    expect((await fake!.calls())[0]).toContain('--order-by=-created_at')
    expect((await fake!.calls())[0]).toContain('--workspace-name=team-a')

    const badEnv = await call(ctx, agent, 'sco_job_create', { ...spec, env: { COUNT: 1 }, dryRun: true })
    expect(text(badEnv)).toContain('env.COUNT must be a string')
    const flood = await call(ctx, agent, 'sco_job_logs', { name: 'job-flood' })
    expect(text(flood)).toMatch(/^\[earlier output truncated\]\nx+$/)

    const tool = (name: string) => (args: Record<string, JsonValue>) => ctx.tools.get(name)!.presentCall!(args)
    expect(tool('sco_job_list')({})).toEqual({ card: 'generic', title: 'sco_job_list', kind: 'search', rawInput: {} })
    expect(tool('sco_job_describe')({ name: 'job-a' })).toMatchObject({ title: 'sco_job_describe job-a', kind: 'read' })
    expect(tool('sco_job_workers')({ name: 'job-a' })).toMatchObject({ title: 'sco_job_workers job-a', kind: 'read' })
    expect(tool('sco_job_logs')({ name: 'job-a' })).toMatchObject({ title: 'sco_job_logs job-a', kind: 'read' })
    expect(tool('sco_job_create')({ ...spec, dryRun: true })).toMatchObject({ title: 'sco_job_create job-wbt (dry run)' })
    expect(tool('sco_job_create')(spec)).toMatchObject({ title: 'sco_job_create job-wbt' })
    expect(tool('sco_job_stop')({ names: ['job-a', 'job-b'] })).toMatchObject({ title: 'sco_job_stop job-a job-b' })

    const entry = [...ctx.loader.entries()].find(candidate => candidate.options.name === 'cordis:@deepseek-ai/dsh-experimental-tool-sco')
    await entry!.fiber!.dispose()
    expect(ctx.tools.schemas().some(schema => schema.name.startsWith('sco_'))).toBe(false)
  })

  it('lists AFS volumes with used percentages and reads directories and quota rules without asking', async () => {
    const { ctx, agent } = await boot()
    let asked = 0
    ctx.on('approval/request', () => {
      asked += 1
      return Promise.resolve<ApprovalOutcome>('rejected')
    })
    const volumes = await call(ctx, agent, 'sco_volumes_list', {})
    const listed = (volumes.value as { volumes: Record<string, JsonValue>[] }).volumes
    expect(listed[0]).toMatchObject({ id: '019fc675-8a27-7a12-abad-47a872e18d81', totalcapacity: '51200GB', usedcapacity: '43TB' })
    expect(listed.map(volume => volume.usedPercent)).toEqual([86, 3.2, undefined, undefined])
    expect(text(volumes)).toBe(JSON.stringify(volumes.value))
    const ls = await call(ctx, agent, 'sco_volume_ls', { volume: 'vol-a', directory: '/data' })
    expect(ls.value).toBe('volumes ls -i vol-a -d /data')
    expect(text(ls)).toBe('volumes ls -i vol-a -d /data')
    expect((await call(ctx, agent, 'sco_volume_quota', { volume: 'vol-a' })).value).toBe('dir-quota list -i vol-a')
    expect(text(await call(ctx, agent, 'sco_volume_ls', { volume: 'vol-a', directory: 'data' }))).toContain('must be an absolute path')
    expect(asked).toBe(0)

    const tool = (name: string) => (args: Record<string, JsonValue>) => ctx.tools.get(name)!.presentCall!(args)
    expect(tool('sco_volumes_list')({})).toMatchObject({ title: 'sco_volumes_list', kind: 'search' })
    expect(tool('sco_volume_ls')({ volume: 'vol-a', directory: '/data' })).toMatchObject({ title: 'sco_volume_ls vol-a/data', kind: 'read' })
    expect(tool('sco_volume_quota')({ volume: 'vol-a' })).toMatchObject({ title: 'sco_volume_quota vol-a', kind: 'read' })
  })

  it('submits without asking when mutation confirmation is off, and keeps a downstream denial', async () => {
    const { ctx, agent } = await boot(['confirmMutations: false'])
    let asked = 0
    ctx.on('approval/request', () => {
      asked += 1
      return Promise.resolve<ApprovalOutcome>('rejected')
    })
    const created = await call(ctx, agent, 'sco_job_create', { name: 'job-auto', image: 'img', args: 'run', cpuCount: 4, memoryGib: 16 })
    expect(created.value).toEqual({ kind: 'created', name: 'job-auto', output: 'created job-auto' })
    expect(asked).toBe(0)
  })

  it('passes a later listener\'s denial through instead of asking', async () => {
    const { ctx, agent } = await boot()
    let asked = 0
    ctx.on('approval/request', () => {
      asked += 1
      return Promise.resolve<ApprovalOutcome>('allowed-once')
    })
    ctx.on('tools/pre-execute', async () => ({ kind: 'deny', reason: 'cluster access disabled' }))
    const denied = await call(ctx, agent, 'sco_job_stop', { names: ['job-a'] })
    expect(denied.isError).toBe(true)
    expect(text(denied)).toContain('cluster access disabled')
    expect(asked).toBe(0)
  })

  it('registers sources, reads resource options, and submits from a template with approval', async () => {
    const { ctx, agent } = await boot([], true)
    const asked: ApprovalRequest[] = []
    ctx.on('approval/request', (request) => {
      asked.push(request)
      return Promise.resolve<ApprovalOutcome>('allowed-once')
    })
    const code = { name: 'rlh', kind: 'code', volumeType: 'afs', volumeId: 'vol-code', root: 'code/rlh', mountPath: '/workspace/code', defaultRef: 'main', setup: 'pip install -e .' }
    expect((await call(ctx, agent, 'sco_source_add', code)).value).toEqual({
      name: 'rlh', source: { kind: 'code', volume: { type: 'afs', id: 'vol-code' }, root: 'code/rlh', mountPath: '/workspace/code', defaultRef: 'main', setup: 'pip install -e .' },
    })
    await call(ctx, agent, 'sco_source_add', { name: 'outputs', kind: 'output', volumeType: 'afs', volumeId: 'vol-out', root: 'outputs', description: 'checkpoints' })
    await call(ctx, agent, 'sco_source_add', { name: 'motion', kind: 'data', volumeType: 'aoss', bucket: 'motion', endpoint: 'oss.local', mountPath: '/data', path: 'npz' })
    await call(ctx, agent, 'sco_source_add', { name: 'raw', kind: 'data', volumeType: 'afs', volumeId: 'vol-raw', mountPath: '/raw' })
    expect((await call(ctx, agent, 'sco_source_update', { name: code.name, kind: code.kind, volumeType: code.volumeType, volumeId: code.volumeId, root: code.root, mountPath: code.mountPath, defaultRef: 'v2' })).value).toMatchObject({ source: { defaultRef: 'v2' } })
    expect((await call(ctx, agent, 'sco_source_remove', { name: 'raw' })).value).toEqual({ removed: 'raw' })
    const listed = await call(ctx, agent, 'sco_sources_list', {})
    expect(listed.value).toMatchObject({ sources: { rlh: { defaultRef: 'v2' }, outputs: { kind: 'output' }, motion: { kind: 'data' } }, templates: { 'wbt-train': { image: 'registry/rlh:wbt' } }, outputMountPath: '/outputs' })
    expect(Object.keys((listed.value as { sources: object }).sources)).toEqual(['rlh', 'outputs', 'motion'])

    expect(text(await call(ctx, agent, 'sco_source_add', { name: 'x', kind: 'data', volumeType: 'afs', mountPath: '/x' }))).toContain('volumeId is required for this source')
    expect(text(await call(ctx, agent, 'sco_source_add', { name: 'x', kind: 'output', volumeType: 'afs', volumeId: 'v', root: 'o', mountPath: '/x' }))).toContain('mountPath does not apply to output sources')
    expect(text(await call(ctx, agent, 'sco_source_add', { name: 'x', kind: 'data', volumeType: 'aoss', bucket: 'b', mountPath: '/x' }))).toContain('endpoint is required for this source')

    const options = await call(ctx, agent, 'sco_resource_options', {})
    expect(options.value).toMatchObject({ workspace: 'team-a', queues: [{ cluster: 'c1', queue: 'gpu-a' }, { cluster: 'c2', queue: 'cpu-b' }] })

    const dryRun = await call(ctx, agent, 'sco_job_submit', { name: 'job-wbt', template: 'wbt-train', data: ['motion'], machineType: 'h1ls.rp.k60a', gpuCount: 8, env: { SEED: '1' }, dryRun: true })
    expect(dryRun.value).toMatchObject({ kind: 'dry-run', resolved: { args: 'cd /workspace/code && python train.py', env: { SEED: '1' } } })
    expect(asked).toHaveLength(0)
    const created = await call(ctx, agent, 'sco_job_submit', { name: 'job-wbt', template: 'wbt-train', machineType: 'h1ls.rp.k60a', gpuCount: 8 })
    expect(created.value).toMatchObject({ kind: 'created', name: 'job-wbt', output: 'created job-wbt' })
    expect(asked.map(request => [request.toolName, request.reason])).toEqual([['sco_job_submit', 'submit SSP training job job-wbt']])
    expect(text(await call(ctx, agent, 'sco_job_submit', { name: 'job-wbt', template: 'wbt-train', env: { N: 1 }, dryRun: true }))).toContain('env.N must be a string')

    const tool = (name: string) => (args: Record<string, JsonValue>) => ctx.tools.get(name)!.presentCall!(args)
    expect(tool('sco_sources_list')({})).toMatchObject({ title: 'sco_sources_list', kind: 'search' })
    expect(tool('sco_source_add')(code)).toMatchObject({ title: 'sco_source_add rlh' })
    expect(tool('sco_source_update')(code)).toMatchObject({ title: 'sco_source_update rlh' })
    expect(tool('sco_source_remove')({ name: 'rlh' })).toMatchObject({ title: 'sco_source_remove rlh' })
    expect(tool('sco_resource_options')({})).toMatchObject({ title: 'sco_resource_options' })
    expect(tool('sco_resource_options')({ refresh: true })).toMatchObject({ title: 'sco_resource_options (refresh)' })
    expect(tool('sco_job_submit')({ name: 'job-a', dryRun: true })).toMatchObject({ title: 'sco_job_submit job-a (dry run)' })
    expect(tool('sco_job_submit')({ name: 'job-a' })).toMatchObject({ title: 'sco_job_submit job-a' })

    const entry = [...ctx.loader.entries()].find(candidate => candidate.options.name === 'cordis:@deepseek-ai/dsh-experimental-sco-submit')
    await entry!.fiber!.dispose()
    expect(ctx.tools.schemas().map(schema => schema.name).filter(name => name.startsWith('sco_'))).toEqual([
      'sco_job_list', 'sco_job_describe', 'sco_job_workers', 'sco_job_logs', 'sco_job_create', 'sco_job_stop',
      'sco_volumes_list', 'sco_volume_ls', 'sco_volume_quota',
    ])
  })
})
