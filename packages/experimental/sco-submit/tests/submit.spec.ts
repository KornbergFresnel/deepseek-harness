import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ScoGateway from '@deepseek-ai/dsh-experimental-sco'
import type { Config as ScoConfig } from '@deepseek-ai/dsh-experimental-sco'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import ScoSubmit, { workloadSpec } from '../src/index.ts'
import type { Config, ScoCodeSource, ScoJobSubmitted, ScoJobTemplate, ScoSource } from '../src/index.ts'
import { machineTypes, mentions, queueIds, resolveSubmission, validSource } from '../src/resolve.ts'
import { fakeSco } from '../../sco/tests/fake-sco.ts'
import type { FakeSco } from '../../sco/tests/fake-sco.ts'

const cleanup: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true })
})

const DATA: ScoSource = { kind: 'data', volume: { type: 'afs', id: 'vol-data' }, path: 'datasets/lafan', mountPath: '/data/motion', description: 'LAFAN1' }
const CODE: ScoCodeSource = { kind: 'code', volume: { type: 'afs', id: 'vol-code' }, root: 'code/rlh', mountPath: '/workspace/code', defaultRef: 'main', setup: 'pip install -e . --no-deps' }
const OUTPUT: ScoSource = { kind: 'output', volume: { type: 'afs', id: 'vol-out' }, root: 'outputs/wbt' }

const TEMPLATES: Record<string, ScoJobTemplate> = {
  'wbt-train': {
    description: 'whole_body_tracking training',
    image: 'registry/rlh:wbt',
    code: 'rlh',
    data: ['motion'],
    output: 'outputs',
    command: 'python scripts/train.py --headless',
    env: { WANDB_MODE: 'offline', SEED: '1' },
    gpuCount: 8,
    machineType: 'h1ls.rp.k60a',
  },
}

async function boot(options: { sco?: ScoConfig; noWorkspace?: boolean; submit?: Config; root?: string; fake?: FakeSco } = {}) {
  const root = options.root ?? await realpath(await mkdtemp(join(tmpdir(), 'dsh-sco-submit-')))
  if (options.root === undefined) cleanup.push(root)
  const fake = options.fake ?? await fakeSco()
  if (options.fake === undefined) cleanup.push(fake.root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(ScoGateway, { command: fake.command, ...options.noWorkspace === true ? {} : { workspace: 'team-a' }, ...options.sco })
  const submit = ctx.plugin(ScoSubmit, { templates: TEMPLATES, ...options.submit })
  await submit
  return { ctx, fake, root, submit }
}

describe('source registry', () => {
  it('adds, updates, lists, and removes sources that survive a restart', async () => {
    const first = await boot()
    await first.ctx.scoSubmit.addSource('motion', DATA)
    await first.ctx.scoSubmit.addSource('rlh', CODE)
    await expect(first.ctx.scoSubmit.addSource('motion', DATA)).rejects.toThrow('source "motion" is already registered')
    await first.ctx.scoSubmit.updateSource('motion', { ...DATA, path: 'datasets/lafan-v2' })
    await expect(first.ctx.scoSubmit.updateSource('absent', DATA)).rejects.toThrow('no source named "absent" is registered')
    await expect(first.ctx.scoSubmit.addSource('Bad_Name', DATA)).rejects.toThrow('source name "Bad_Name" must use lowercase letters')
    const restarted = first.ctx
    contexts.splice(contexts.indexOf(restarted), 1)
    await restarted.fiber.dispose()

    const second = await boot({ root: first.root, fake: first.fake })
    expect(await second.ctx.scoSubmit.sources()).toEqual({ motion: { ...DATA, path: 'datasets/lafan-v2' }, rlh: CODE })
    await second.ctx.scoSubmit.removeSource('rlh')
    await expect(second.ctx.scoSubmit.removeSource('rlh')).rejects.toThrow('no source named "rlh" is registered')
    expect(Object.keys(await second.ctx.scoSubmit.sources())).toEqual(['motion'])
    expect(second.ctx.scoSubmit.listTemplates()).toEqual(TEMPLATES)
    expect(second.ctx.scoSubmit.outputPath).toBe('/outputs')
  })

  it('rejects locations that could not form a mount or a startup command', () => {
    const afs = { type: 'afs', id: 'vol' } as const
    for (const [source, text] of [
      [{ ...DATA, volume: { type: 'afs', id: 'a:b' } }, 'volume id "a:b"'],
      [{ ...DATA, volume: { type: 'aoss', bucket: 'Bucket', endpoint: 'oss.local' } }, 'bucket "Bucket"'],
      [{ ...DATA, volume: { type: 'aoss', bucket: 'bucket', endpoint: 'oss.local:9000' } }, 'endpoint "oss.local:9000"'],
      [{ ...DATA, path: '../escape' }, 'path "../escape"'],
      [{ ...DATA, mountPath: 'relative' }, 'mountPath "relative"'],
      [{ ...DATA, mountPath: '/data/$(id)' }, 'mountPath "/data/$(id)"'],
      [{ ...CODE, root: 'a//b' }, 'root "a//b"'],
      [{ ...CODE, root: 'with space/x' }, 'root "with space/x"'],
      [{ ...CODE, defaultRef: 'a/b' }, 'defaultRef "a/b"'],
      [{ ...CODE, setup: ' ' }, 'setup must not be empty'],
      [{ kind: 'output', volume: afs, root: 'a/../b' }, 'root "a/../b"'],
    ] as [ScoSource, string][]) {
      expect(() => validSource(source)).toThrow(text)
    }
    const aoss: ScoSource = { kind: 'data', volume: { type: 'aoss', bucket: 'motion', endpoint: 'oss.local' }, mountPath: '/data' }
    expect(validSource(aoss)).toEqual(aoss)
    expect(validSource({ ...DATA, path: ' /datasets/lafan/ ' })).toEqual(DATA)
    const { path: _path, ...whole } = DATA
    expect(validSource({ ...DATA, path: '/' })).toEqual(whole)
    expect(validSource({ ...CODE, root: '/code/rlh' })).toEqual(CODE)
    expect(validSource({ kind: 'output', volume: afs, root: '/' })).toEqual({ kind: 'output', volume: afs, root: '' })
    const { setup: _setup, ...bare } = CODE
    expect(validSource(bare)).toMatchObject({ kind: 'code' })
  })

  it('fails loud on invalid configuration', async () => {
    for (const [submit, text] of [
      [{ templates: { 'Bad Name': {} } }, 'template name "Bad Name"'],
      [{ templates: { ok: { code: 'Code!' } } }, 'source name in template "ok" "Code!"'],
      [{ templates: { ok: { data: ['ok', 'x y'] } } }, 'source name in template "ok" "x y"'],
      [{ outputMountPath: 'outputs' }, 'outputMountPath "outputs"'],
    ] as [Config, string][]) {
      await expect(boot({ submit })).rejects.toThrow(text)
    }
  })
})

describe('submission expansion', () => {
  const context = {
    sources: new Map<string, ScoSource>([
      ['motion', DATA],
      ['rlh', CODE],
      ['outputs', OUTPUT],
      ['bucket', { kind: 'data', volume: { type: 'aoss', bucket: 'motion', endpoint: 'oss.local' }, path: 'npz', mountPath: '/data/bucket' }],
      ['raw', { kind: 'data', volume: { type: 'aoss', bucket: 'raw', endpoint: 'oss.local' }, mountPath: '/data/raw' }],
      ['whole', { kind: 'data', volume: { type: 'afs', id: 'vol-whole' }, mountPath: '/data/whole' }],
      ['plain', { kind: 'code', volume: { type: 'afs', id: 'vol-code' }, root: 'code/plain', mountPath: '/code', defaultRef: 'v1' }],
    ]),
    templates: TEMPLATES,
    outputMountPath: '/outputs',
  }

  it('merges the template, mounts sources, and runs the command in the code directory', () => {
    expect(resolveSubmission({ name: 'job-wbt', template: 'wbt-train', ref: 'abc123', extraArgs: '--seed 2', env: { SEED: '2' }, gpuCount: 4, displayName: 'wbt', queueId: '/q', workspace: 'team-b', dryRun: true }, context)).toEqual({
      request: {
        name: 'job-wbt',
        displayName: 'wbt',
        image: 'registry/rlh:wbt',
        gpuCount: 4,
        machineType: 'h1ls.rp.k60a',
        args: 'cd /workspace/code && pip install -e . --no-deps && python scripts/train.py --headless --seed 2',
        queueId: '/q',
        workspace: 'team-b',
        env: { WANDB_MODE: 'offline', SEED: '2' },
        volumeMounts: [
          'PV_AFS:vol-data:/data/motion:/datasets/lafan',
          'PV_AFS:vol-code:/workspace/code:/code/rlh/abc123',
          'PV_AFS:vol-out:/outputs:/outputs/wbt/job-wbt',
        ],
        dryRun: true,
      },
      template: 'wbt-train',
      code: { name: 'rlh', ref: 'abc123' },
      data: ['motion'],
      output: 'outputs',
    })
  })

  it('composes without a template and covers every mount form', () => {
    expect(resolveSubmission({ name: 'job-x', image: 'img', command: 'run', code: 'plain', data: ['bucket', 'raw', 'whole'] }, context)).toEqual({
      request: {
        name: 'job-x',
        image: 'img',
        args: 'cd /code && run',
        volumeMounts: ['PV_AOSS:motion:/data/bucket:oss.local:/npz', 'PV_AOSS:raw:/data/raw:oss.local', 'PV_AFS:vol-whole:/data/whole', 'PV_AFS:vol-code:/code:/code/plain/v1'],
      },
      code: { name: 'plain', ref: 'v1' },
      data: ['bucket', 'raw', 'whole'],
    })
    expect(resolveSubmission({ name: 'job-y', image: 'img', command: 'echo hi' }, context)).toEqual({ request: { name: 'job-y', image: 'img', args: 'echo hi' }, data: [] })
  })

  it('rejects missing, mistyped, and conflicting references', () => {
    const base = { name: 'job-x', image: 'img', command: 'run' }
    expect(() => resolveSubmission({ ...base, template: 'absent' }, context)).toThrow('no template named "absent" is configured')
    expect(() => resolveSubmission({ name: 'job-x', command: 'run' }, context)).toThrow('image is required')
    expect(() => resolveSubmission({ name: 'job-x', image: 'img' }, context)).toThrow('command is required')
    expect(() => resolveSubmission({ ...base, command: ' ' }, context)).toThrow('command must not be empty')
    expect(() => resolveSubmission({ ...base, data: ['absent'] }, context)).toThrow('no data source named "absent" is registered')
    expect(() => resolveSubmission({ ...base, code: 'motion' }, context)).toThrow('source "motion" is a data source, not a code source')
    expect(() => resolveSubmission({ ...base, data: ['motion', 'motion'] }, context)).toThrow('two sources mount at /data/motion')
    expect(() => resolveSubmission({ ...base, ref: 'main' }, context)).toThrow('ref needs a code source')
    expect(() => resolveSubmission({ ...base, code: 'rlh', ref: '../x' }, context)).toThrow('ref "../x"')
  })

  it('finds queue ids and machine types in untyped CLI JSON', () => {
    const id = '/subscriptions/s/resourceGroups/r/regions/cn/clusters/c1/queues/gpu-a'
    const other = '/subscriptions/s/resourceGroups/r/regions/cn/clusters/c2/queues/cpu-b'
    const entry = { id, n: 1, ok: true, none: null }
    expect(queueIds({ refs: [id, other], items: [entry, { id, alias: true }, [id], 'unrelated'] })).toEqual([
      { id, cluster: 'c1', queue: 'gpu-a', detail: entry },
      { id: other, cluster: 'c2', queue: 'cpu-b', detail: { id: other } },
    ])
    expect(mentions({ workloads: [{ spec_code: 'h1' }, 3] }, 'h1')).toBe(true)
    expect(mentions({ workloads: [{ spec_code: 'h1' }, null] }, 'h2')).toBe(false)
  })
})

describe('resource options and submission', () => {
  async function registered(options: Parameters<typeof boot>[0] = {}) {
    const booted = await boot(options)
    for (const [name, source] of [['motion', DATA], ['rlh', CODE], ['outputs', OUTPUT]] as const) await booted.ctx.scoSubmit.addSource(name, source)
    return booted
  }

  it('caches queue options per workspace and queries again only on refresh', async () => {
    const { ctx, fake } = await boot({ sco: { profile: 'pjlab' } })
    const options = await ctx.scoSubmit.resourceOptions()
    expect(options.workspace).toBe('team-a')
    expect(options.queues.map(queue => [queue.id.split('/clusters/')[1], queue.cluster, queue.queue, machineTypes(queue.detail)])).toEqual([
      ['c1/queues/gpu-a', 'c1', 'gpu-a', ['h1ls.rp.k60a']],
      ['c2/queues/cpu-b', 'c2', 'cpu-b', ['c6.large']],
    ])
    expect(await ctx.scoSubmit.resourceOptions()).toEqual(options)
    await ctx.scoSubmit.resourceOptions({ refresh: true })
    expect((await fake.calls()).map(argv => argv.slice(2, 4))).toEqual([
      ['workspaces', 'list-queues'], ['workspaces', 'list-queues'],
    ])
  })

  it('fails with a listing excerpt when the queue listing holds no queue ids', async () => {
    const { ctx } = await boot()
    await expect(ctx.scoSubmit.resourceOptions({ workspace: 'ws-empty' }))
      .rejects.toThrow('no queue resource ids (/subscriptions/…/clusters/<cluster>/queues/<queue>) in sco ssp workspaces list-queues ws-empty output: {"items":[{"name":"gpu-a","cluster":"c1"}]}')
  })

  it('needs a workspace for resource options', async () => {
    const { ctx } = await boot({ noWorkspace: true })
    await expect(ctx.scoSubmit.resourceOptions()).rejects.toThrow('resource options need a workspace')
  })

  it('dry-runs and submits from a template, emitting the composition', async () => {
    const { ctx, fake } = await registered()
    const submitted: ScoJobSubmitted[] = []
    ctx.on('sco/job-submitted', (event) => { submitted.push(event) })
    const dryRun = await ctx.scoSubmit.submit({ name: 'job-wbt', template: 'wbt-train', dryRun: true })
    expect(dryRun).toMatchObject({ kind: 'dry-run', job: { name: 'job-wbt', spec: {} }, resolved: { dryRun: true } })
    const created = await ctx.scoSubmit.submit({ name: 'job-wbt', template: 'wbt-train' })
    expect(created).toMatchObject({ kind: 'created', name: 'job-wbt', output: 'created job-wbt' })
    await ctx.scoSubmit.submit({ name: 'job-bare', image: 'img', command: 'run' })
    expect(submitted).toEqual([
      { name: 'job-wbt', workspace: 'team-a', template: 'wbt-train', code: { name: 'rlh', ref: 'main' }, data: ['motion'], output: 'outputs' },
      { name: 'job-bare', workspace: 'team-a', data: [] },
    ])
    expect((await fake.calls())[1]).toContain('--volume-mount=PV_AFS:vol-out:/outputs:/outputs/wbt/job-wbt')
    expect((await ctx.scoSubmit.resolve({ name: 'job-wbt', template: 'wbt-train' })).request.args).toContain('cd /workspace/code')
  })

  it('checks machine types against cached options before the CLI runs', async () => {
    const { ctx, fake } = await registered()
    await ctx.scoSubmit.resourceOptions()
    await expect(ctx.scoSubmit.submit({ name: 'job-wbt', template: 'wbt-train', machineType: 'h1ls.rp.k60a,a100.x' }))
      .rejects.toThrow('machine type a100.x is not among the resource options cached for workspace team-a')
    expect((await ctx.scoSubmit.submit({ name: 'job-wbt', template: 'wbt-train', dryRun: true })).kind).toBe('dry-run')
    expect((await fake.calls()).filter(argv => argv.includes('create'))).toHaveLength(1)
  })

  it('refreshes options when the CLI blames a resource field, and passes other failures through', async () => {
    const { ctx, fake } = await registered()
    await expect(ctx.scoSubmit.submit({ name: 'job-x', image: 'img', command: 'run', machineType: 'retired.spec', gpuCount: 1 }))
      .rejects.toThrow('machine type retired.spec is not offered by the queue; resource options for workspace team-a were refreshed')
    expect((await fake.calls()).some(argv => argv.includes('list-queues'))).toBe(true)
    await expect(ctx.scoSubmit.submit({ name: 'job-fail', image: 'img', command: 'run' })).rejects.toThrow(/job not found$/)
    await expect(ctx.scoSubmit.submit({ name: 'job-silent-fail', image: 'img', command: 'run', workspace: 'ws-fail' }))
      .rejects.toThrow('quota exceeded; refreshing resource options also failed: sco ssp workspaces list-queues failed (5): workspace not found')
  })

  it('passes resource failures through unchanged when no workspace resolves', async () => {
    const { ctx, fake } = await boot({ noWorkspace: true })
    await expect(ctx.scoSubmit.submit({ name: 'job-silent-fail', image: 'img', command: 'run', machineType: 'h1' })).rejects.toThrow(/quota exceeded$/)
    const submitted: ScoJobSubmitted[] = []
    ctx.on('sco/job-submitted', (event) => { submitted.push(event) })
    await ctx.scoSubmit.submit({ name: 'job-ok', image: 'img', command: 'run', machineType: 'h1' })
    expect(submitted).toEqual([{ name: 'job-ok', data: [] }])
    expect((await fake.calls()).map(argv => argv[2])).toEqual(['create', 'create'])
  })
})

describe('clusterConfig Remote namespace', () => {
  it('serves an overview that follows source and option changes, and edits sources', async () => {
    const { ctx } = await boot({ sco: { profile: 'pjlab', queueId: '/queues/default' } })
    const abort = new AbortController()
    const stream = ctx.scoSubmit.follow(abort.signal)[Symbol.asyncIterator]()
    const first = await stream.next()
    expect(first.value).toEqual({
      profile: 'pjlab', workspace: 'team-a', queueId: '/queues/default', configured: { workspace: 'team-a', queueId: '/queues/default' }, saved: {},
      outputMountPath: '/outputs', sources: [], templates: [{ name: 'wbt-train', template: TEMPLATES['wbt-train'] }], configs: [],
    })
    const pending = stream.next()
    await ctx.scoSubmit.saveSource({ name: 'rlh', source: CODE })
    expect((await pending).value).toMatchObject({ sources: [{ name: 'rlh', source: CODE }] })
    await ctx.scoSubmit.saveSource({ name: 'motion', source: DATA })
    await ctx.scoSubmit.saveSource({ name: 'rlh', source: { ...CODE, defaultRef: 'v2' }, replace: true })
    await ctx.scoSubmit.refreshOptions()
    const latest = await stream.next()
    expect(latest.value).toMatchObject({
      sources: [{ name: 'motion' }, { name: 'rlh', source: { defaultRef: 'v2' } }],
      options: { workspace: 'team-a', queues: [{ queue: 'gpu-a', machineTypes: ['h1ls.rp.k60a'] }, { queue: 'cpu-b', machineTypes: ['c6.large'] }] },
    })
    await ctx.scoSubmit.deleteSource('motion')
    expect((await stream.next()).value).toMatchObject({ sources: [{ name: 'rlh' }] })
    await expect(ctx.scoSubmit.deleteSource('motion')).rejects.toThrow('no source named "motion" is registered')
    expect((await ctx.scoSubmit.volumes()).map(volume => volume.id)).toEqual(['vol-a', 'vol-b', 'vol-c', 'vol-d'])
    const waiting = stream.next()
    abort.abort()
    expect(await waiting).toEqual({ done: true, value: undefined })
  })

  it('saves page defaults per profile, applies them at start, and withdraws them on disposal', async () => {
    const queue = '/subscriptions/s/resourceGroups/r/regions/cn/clusters/c1/queues/gpu-a'
    const first = await boot({ sco: { profile: 'pjlab' }, noWorkspace: true })
    const abort = new AbortController()
    const stream = first.ctx.scoSubmit.follow(abort.signal)[Symbol.asyncIterator]()
    await stream.next()
    await expect(first.ctx.scoSubmit.saveDefaults({ queueId: 'gpu-a' })).rejects.toThrow('queueId "gpu-a" must be a full queue resource id')
    await first.ctx.scoSubmit.saveDefaults({ workspace: ' team-b ', queueId: queue })
    expect((await stream.next()).value).toMatchObject({ workspace: 'team-b', queueId: queue, configured: {}, saved: { workspace: 'team-b', queueId: queue } })
    abort.abort()
    await first.ctx.fiber.dispose()

    const second = await boot({ sco: { profile: 'pjlab' }, noWorkspace: true, root: first.root, fake: first.fake })
    await vi.waitFor(() => { expect([second.ctx.sco.workspaceOf({}), second.ctx.sco.queueId]).toEqual(['team-b', queue]) })
    await second.ctx.scoSubmit.saveDefaults({ workspace: '', queueId: ' ' })
    expect(await second.ctx.scoSubmit.overview()).toMatchObject({ saved: {} })
    expect(second.ctx.sco.workspaceOf({})).toBeUndefined()
    await second.ctx.scoSubmit.saveDefaults({ workspace: 'team-c' })
    const sco = second.ctx.sco
    await second.submit.dispose()
    expect(sco.workspaceOf({})).toBeUndefined()
  })

  it('omits gateway defaults and options that are not configured', async () => {
    const { ctx } = await boot({ noWorkspace: true })
    const abort = new AbortController()
    abort.abort()
    expect(await ctx.scoSubmit.follow(abort.signal)[Symbol.asyncIterator]().next()).toEqual({ done: true, value: undefined })
    expect(await ctx.scoSubmit.overview()).toEqual({
      configured: {}, saved: {}, outputMountPath: '/outputs', sources: [], templates: [{ name: 'wbt-train', template: TEMPLATES['wbt-train'] }], configs: [],
    })
    expect(machineTypes([{ spec_code: 'a' }, { nested: { machine_type: 'b', other: 'c' } }, { spec_code: 'a' }, { spec_code: 1 }, null])).toEqual(['a', 'b'])
  })
})

describe('saved configurations and configuration forms', () => {
  const QUEUE = '/subscriptions/s/resourceGroups/r/regions/cn/clusters/c1/queues/gpu-a'

  async function nextForms(ctx: Context) {
    const lifetime = new AbortController()
    const next = await ctx.scoSubmit.followForms(lifetime.signal)[Symbol.asyncIterator]().next()
    lifetime.abort()
    return next.done === true ? [] : next.value
  }

  it('trims workload settings and rejects invalid ones', () => {
    expect(workloadSpec({ image: ' img ', command: '  ', data: [' motion ', ''], env: { A: '1' }, gpuCount: 0, queueId: QUEUE })).toEqual({
      image: 'img', data: ['motion'], env: { A: '1' }, gpuCount: 0, queueId: QUEUE,
    })
    expect(workloadSpec({ data: [' '] })).toEqual({})
    expect(() => workloadSpec({ gpuCount: -1 })).toThrow('invalid workload settings')
    expect(() => workloadSpec({ podCount: 0 })).toThrow('invalid workload settings')
    expect(() => workloadSpec({ queueId: 'gpu-a' })).toThrow('queueId "gpu-a" must be a full queue resource id')
    expect(() => workloadSpec({ code: 'Bad_Name' })).toThrow('source name in workload settings "Bad_Name"')
  })

  it('saves, replaces, lists, and deletes configurations that survive a restart', async () => {
    const first = await boot()
    const abort = new AbortController()
    const stream = first.ctx.scoSubmit.follow(abort.signal)[Symbol.asyncIterator]()
    await stream.next()
    await first.ctx.scoSubmit.saveConfig({ name: ' wbt-8gpu ', kind: 'job', description: ' WBT ', spec: { image: 'img', gpuCount: 8 } })
    expect((await stream.next()).value).toMatchObject({ configs: [{ name: 'wbt-8gpu', config: { kind: 'job', description: 'WBT', spec: { image: 'img', gpuCount: 8 } } }] })
    await expect(first.ctx.scoSubmit.saveConfig({ name: 'wbt-8gpu', kind: 'job', spec: {} })).rejects.toThrow('configuration "wbt-8gpu" already exists')
    await expect(first.ctx.scoSubmit.saveConfig({ name: 'Bad Name', kind: 'job', spec: {} })).rejects.toThrow('configuration name "Bad Name"')
    const created = (await first.ctx.scoSubmit.configs())['wbt-8gpu']!
    await new Promise(resolve => setTimeout(resolve, 5))
    await first.ctx.scoSubmit.saveConfig({ name: 'wbt-8gpu', kind: 'job', description: ' ', spec: { image: 'img2' }, replace: true })
    const replaced = (await first.ctx.scoSubmit.configs())['wbt-8gpu']!
    expect(replaced).toEqual({ kind: 'job', spec: { image: 'img2' }, createdAt: created.createdAt, updatedAt: expect.any(String) as string })
    expect(replaced.updatedAt > created.updatedAt).toBe(true)
    await first.ctx.scoSubmit.saveConfig({ name: 'dev-a100', kind: 'devmachine', spec: { gpuCount: 1 } })
    abort.abort()
    contexts.splice(contexts.indexOf(first.ctx), 1)
    await first.ctx.fiber.dispose()

    const second = await boot({ root: first.root, fake: first.fake })
    expect(Object.keys(await second.ctx.scoSubmit.configs())).toEqual(['wbt-8gpu', 'dev-a100'])
    expect((await second.ctx.scoSubmit.overview()).configs.map(entry => entry.name)).toEqual(['dev-a100', 'wbt-8gpu'])
    await second.ctx.scoSubmit.deleteConfig('dev-a100')
    await expect(second.ctx.scoSubmit.deleteConfig('dev-a100')).rejects.toThrow('no configuration named "dev-a100" is saved')
    expect(Object.keys(await second.ctx.scoSubmit.configs())).toEqual(['wbt-8gpu'])
  })

  it('keeps a form open until it is answered, saves on request, and records the configuration it loaded', async () => {
    const { ctx } = await boot()
    await ctx.scoSubmit.saveConfig({ name: 'wbt-8gpu', kind: 'job', spec: { image: 'img', gpuCount: 8 } })
    expect(await nextForms(ctx)).toEqual([])
    const callId = ToolCallId('call-1')
    const lifetime = new AbortController()
    const answer = ctx.scoSubmit.askForm({ callId, kind: 'job', initial: { image: ' img ' }, suggested: 'wbt-8gpu' }, lifetime.signal)
    await vi.waitFor(async () => { expect(await nextForms(ctx)).toHaveLength(1) })
    expect(await nextForms(ctx)).toEqual([{ callId, kind: 'job', initial: { image: 'img' }, suggested: 'wbt-8gpu', openedAt: expect.any(String) as string }])
    await expect(ctx.scoSubmit.askForm({ callId, kind: 'job', initial: {} }, lifetime.signal)).rejects.toThrow('already open')
    await expect(ctx.scoSubmit.answerForm(callId, { kind: 'confirmed', spec: {}, save: { name: 'Bad Name' } })).rejects.toThrow('configuration name "Bad Name"')
    expect(await nextForms(ctx)).toHaveLength(1)
    await ctx.scoSubmit.answerForm(callId, {
      kind: 'confirmed', spec: { image: 'img', gpuCount: 4, queueId: QUEUE }, loaded: 'wbt-8gpu', save: { name: ' wbt-4gpu ', description: '4 GPUs' },
    })
    expect(await answer).toEqual({ kind: 'confirmed', workload: 'job', spec: { image: 'img', gpuCount: 4, queueId: QUEUE }, loaded: 'wbt-8gpu', savedAs: 'wbt-4gpu' })
    const configs = await ctx.scoSubmit.configs()
    expect(configs['wbt-8gpu']!.lastUsedAt).toEqual(expect.any(String))
    await ctx.scoSubmit.saveConfig({ name: 'wbt-8gpu', kind: 'job', spec: { image: 'img', gpuCount: 6 }, replace: true })
    expect((await ctx.scoSubmit.configs())['wbt-8gpu']!.lastUsedAt).toBe(configs['wbt-8gpu']!.lastUsedAt)
    expect(configs['wbt-4gpu']).toMatchObject({ kind: 'job', description: '4 GPUs', spec: { gpuCount: 4 } })
    expect(await nextForms(ctx)).toEqual([])

    const plain = ToolCallId('call-2')
    const plainAnswer = ctx.scoSubmit.askForm({ callId: plain, kind: 'devmachine', initial: {} }, lifetime.signal)
    await vi.waitFor(async () => { expect(await nextForms(ctx)).toHaveLength(1) })
    await ctx.scoSubmit.answerForm(plain, { kind: 'confirmed', spec: { gpuCount: 1 }, loaded: 'deleted-meanwhile' })
    expect(await plainAnswer).toEqual({ kind: 'confirmed', workload: 'devmachine', spec: { gpuCount: 1 }, loaded: 'deleted-meanwhile' })
  })

  it('rejects forms whose call is cancelled, already cancelled, or outlives the service', async () => {
    const { ctx, submit } = await boot()
    const dead = new AbortController()
    dead.abort(new Error('already stopped'))
    await expect(ctx.scoSubmit.askForm({ callId: ToolCallId('dead'), kind: 'job', initial: {} }, dead.signal)).rejects.toThrow('already stopped')
    await expect(ctx.scoSubmit.askForm({ callId: ToolCallId('x'), kind: 'job', initial: {}, suggested: 'absent' }, new AbortController().signal))
      .rejects.toThrow('no configuration named "absent" is saved')
    await expect(ctx.scoSubmit.askForm({ callId: ToolCallId('y'), kind: 'job', initial: { gpuCount: -1 } }, new AbortController().signal))
      .rejects.toThrow('invalid workload settings')
    const lifetime = new AbortController()
    const cancelled = ctx.scoSubmit.askForm({ callId: ToolCallId('cancel'), kind: 'job', initial: {} }, lifetime.signal)
    lifetime.abort(new Error('turn stopped'))
    await expect(cancelled).rejects.toThrow('turn stopped')
    const orphan = ctx.scoSubmit.askForm({ callId: ToolCallId('orphan'), kind: 'job', initial: {} }, new AbortController().signal)
    const failed = expect(orphan).rejects.toThrow('sco-submit disposed')
    await vi.waitFor(async () => { expect(await nextForms(ctx)).toHaveLength(1) })
    await submit.dispose()
    await failed
  })
})
