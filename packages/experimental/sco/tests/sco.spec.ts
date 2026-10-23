import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import ScoGateway from '../src/index.ts'
import type { Config, CreateScoJobRequest } from '../src/index.ts'
import { createArgv, listArgv, logsArgv } from '../src/argv.ts'
import { fakeSco } from './fake-sco.ts'
import type { FakeSco } from './fake-sco.ts'

let ctx: Context | undefined
let fake: FakeSco | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (fake !== undefined) await rm(fake.root, { recursive: true, force: true })
  fake = undefined
})

async function gateway(config: Config = {}): Promise<{ ctx: Context; fake: FakeSco }> {
  fake = await fakeSco()
  ctx = new Context()
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(ScoGateway, { command: fake.command, ...config })
  return { ctx, fake }
}

describe('SSP job operations through the sco CLI', () => {
  it('lists, describes, and reads workers as parsed JSON with profile and workspace flags', async () => {
    const { ctx, fake } = await gateway({ profile: 'pjlab', workspace: 'team-a' })
    expect(await ctx.sco.listJobs({ pageSize: 5, skip: 0, filters: [{ field: 'state', value: 'RUNNING' }], orderBy: '-created_at' }))
      .toEqual({ jobs: [{ name: 'job-a', state: 'RUNNING' }] })
    expect(await ctx.sco.describeJob('job-wbt', { workspace: 'team-b' })).toEqual({ name: 'job-wbt', state: 'RUNNING' })
    expect(await ctx.sco.listWorkers('job-wbt')).toEqual([{ name: 'job-wbt-worker-0' }])
    expect(await fake.calls()).toEqual([
      ['--profile=pjlab', 'ssp', 'jobs', 'list', '--page-size=5', '--skip=0', '--filter=Name=state,Values=RUNNING', '--order-by=-created_at', '--workspace-name=team-a', '--format=json'],
      ['--profile=pjlab', 'ssp', 'jobs', 'describe', 'job-wbt', '--workspace-name=team-b', '--format=json'],
      ['--profile=pjlab', 'ssp', 'jobs', 'get-workers', 'job-wbt', '--workspace-name=team-a', '--format=json'],
    ])
  })

  it('defers workspace and queue to the sco profile when neither request nor config names them', async () => {
    const { ctx, fake } = await gateway()
    const created: unknown[] = []
    ctx.on('sco/job-created', (event) => { created.push(event) })
    await ctx.sco.listJobs()
    await ctx.sco.describeJob('job-wbt')
    await ctx.sco.listWorkers('job-wbt')
    await ctx.sco.readLogs('job-wbt')
    await ctx.sco.stopJobs(['job-wbt'])
    await ctx.sco.createJob({ name: 'job-wbt', image: 'img', args: 'run' }, undefined, {
      sessionId: brandString<SessionId>('session-1'), description: 'Train the G1 tracking policy',
    })
    expect(created).toEqual([{ name: 'job-wbt', sessionId: 'session-1', description: 'Train the G1 tracking policy' }])
    expect(await fake.calls()).toEqual([
      ['ssp', 'jobs', 'list', '--format=json'],
      ['ssp', 'jobs', 'describe', 'job-wbt', '--format=json'],
      ['ssp', 'jobs', 'get-workers', 'job-wbt', '--format=json'],
      ['ssp', 'jobs', 'stream-logs', 'job-wbt'],
      ['ssp', 'jobs', 'stop', 'job-wbt'],
      ['ssp', 'jobs', 'create', 'job-wbt', '--image=img', '--args=run'],
    ])
  })

  it('reads one log round, keeping only the tail when output exceeds the limit', async () => {
    const { ctx, fake } = await gateway({ maxOutputBytes: 1024 })
    expect(await ctx.sco.readLogs('job-wbt', { worker: 'job-wbt-worker-0', container: 'main' })).toEqual({ text: 'step 1 loss=0.5\n', truncated: false })
    const flood = await ctx.sco.readLogs('job-flood')
    expect(flood.truncated).toBe(true)
    expect(flood.text.length).toBeLessThanOrEqual(1024)
    await expect(ctx.sco.describeJob('job-flood')).rejects.toThrow('output exceeds maxOutputBytes')
    expect((await fake.calls())[0]).toEqual(['ssp', 'jobs', 'stream-logs', 'job-wbt', '--worker-name=job-wbt-worker-0', '--container-name=main'])
  })

  it('lets runtime defaults override the configured workspace and queue until replaced', async () => {
    const { ctx, fake } = await gateway({ workspace: 'team-a', queueId: '/queues/default' })
    expect(ctx.sco.configuredDefaults).toEqual({ workspace: 'team-a', queueId: '/queues/default' })
    ctx.sco.setDefaults({ workspace: 'team-b', queueId: '/queues/page' })
    expect([ctx.sco.workspaceOf({}), ctx.sco.workspaceOf({ workspace: 'team-c' }), ctx.sco.queueId]).toEqual(['team-b', 'team-c', '/queues/page'])
    await ctx.sco.createJob({ name: 'job-wbt', image: 'img', args: 'run', dryRun: true })
    expect((await fake.calls())[0]).toEqual(expect.arrayContaining(['--queue-id=/queues/page', '--workspace-name=team-b']))
    ctx.sco.setDefaults({ queueId: '/queues/page' })
    expect(ctx.sco.workspaceOf({})).toBe('team-a')
    expect(() => { ctx.sco.setDefaults({ workspace: ' ' }) }).toThrow('sco: default workspace must not be empty')
    expect(ctx.sco.queueId).toBe('/queues/page')
    ctx.sco.setDefaults({})
    expect(ctx.sco.queueId).toBe('/queues/default')
  })

  it('creates jobs from flags, returning the merged spec for a dry run and the CLI output otherwise', async () => {
    const { ctx, fake } = await gateway({ queueId: '/queues/default' })
    expect(ctx.sco.queueId).toBe('/queues/default')
    const created: unknown[] = []
    ctx.on('sco/job-created', (event) => { created.push(event) })
    const request: CreateScoJobRequest = {
      name: 'job-wbt', displayName: 'wbt', image: 'registry/rlh:wbt', imageType: 'PRIVATE', args: 'python -m train --flag=-1',
      framework: 'PYTORCH_DDP', podCount: 1, gpuCount: 8, cpuCount: 64, memoryGib: 512, machineType: 'h1ls.rp.k60a', rdmaName: 'rdma0',
      shmSizeGib: 64, priority: 'HIGH', env: { WANDB_MODE: 'offline' }, volumeMounts: ['PV_AFS:0000:/data:/train'], maxAttempts: 0,
      enableQueuing: true, tensorboardLogPath: '/data/tb',
    }
    expect(await ctx.sco.createJob({ ...request, dryRun: true })).toEqual({ kind: 'dry-run', job: { name: 'job-wbt', spec: {} } })
    expect(await ctx.sco.createJob({ ...request, queueId: '/queues/override', workspace: 'team-a' }))
      .toEqual({ kind: 'created', name: 'job-wbt', output: 'created job-wbt' })
    expect(created).toEqual([{ name: 'job-wbt', workspace: 'team-a' }])
    const flags = [
      'create', 'job-wbt', '--display-name=wbt', '--image=registry/rlh:wbt', '--image-type=PRIVATE', '--args=python -m train --flag=-1',
      '--framework=PYTORCH_DDP', '--pod-count=1', '--gpu-count=8', '--cpu-count=64', '--memory-gib=512', '--machine-type=h1ls.rp.k60a',
      '--rdma-name=rdma0', '--shm-size-gib=64',
    ]
    const tail = ['--priority=HIGH', '--env=WANDB_MODE=offline', '--volume-mount=PV_AFS:0000:/data:/train', '--max-attempts=0', '--enable-queuing', '--tensorboard-log-path=/data/tb']
    expect(await fake.calls()).toEqual([
      ['ssp', 'jobs', ...flags, '--queue-id=/queues/default', ...tail, '--dry-run', '--format=json'],
      ['ssp', 'jobs', ...flags, '--queue-id=/queues/override', ...tail, '--workspace-name=team-a'],
    ])
  })

  it('stops jobs and reports the CLI confirmation', async () => {
    const { ctx, fake } = await gateway()
    expect(await ctx.sco.stopJobs(['job-a', 'job-b'], { workspace: 'team-a' })).toEqual({ names: ['job-a', 'job-b'], output: 'stopped' })
    expect(await fake.calls()).toEqual([['ssp', 'jobs', 'stop', 'job-a', 'job-b', '--workspace-name=team-a']])
    await expect(ctx.sco.stopJobs([])).rejects.toThrow('1 to 100 job names')
    await expect(ctx.sco.stopJobs(Array.from({ length: 101 }, (_, index) => `job-${index}`))).rejects.toThrow('1 to 100 job names')
  })

  it('reports CLI failures with stderr, falling back to stdout, and rejects non-JSON output', async () => {
    const { ctx } = await gateway()
    await expect(ctx.sco.describeJob('job-fail')).rejects.toThrow('sco ssp jobs describe failed (3): job not found')
    await expect(ctx.sco.stopJobs(['job-silent-fail'])).rejects.toThrow('sco ssp jobs stop failed (4): quota exceeded')
    await expect(ctx.sco.listWorkers('job-garbage')).rejects.toThrow('returned non-JSON output: not json')
  })

  it('times out, honors caller cancellation, and aborts work when the service is disposed', async () => {
    const { ctx } = await gateway({ timeoutMs: 200, graceMs: 50 })
    await expect(ctx.sco.describeJob('job-hang')).rejects.toThrow()
    const controller = new AbortController()
    controller.abort(new Error('caller stopped'))
    await expect(ctx.sco.describeJob('job-a', {}, controller.signal)).rejects.toThrow('caller stopped')
    const pending = ctx.sco.listWorkers('job-hang', {})
    const disposed = expect(pending).rejects.toThrow('sco gateway disposed')
    await new Promise(resolve => setTimeout(resolve, 50))
    await ctx.fiber.dispose()
    await disposed
  })

  it('lists workspace queues and reads one queue, requiring a resolvable workspace', async () => {
    const { ctx, fake } = await gateway({ profile: 'pjlab' })
    expect(ctx.sco.profile).toBe('pjlab')
    await expect(ctx.sco.listQueues()).rejects.toThrow('listing queues needs a workspace')
    expect(await ctx.sco.listQueues({ workspace: 'team-a' })).toHaveLength(3)
    expect(await ctx.sco.describeQueue('c1', 'gpu-a')).toEqual({ name: 'gpu-a', workloads: [{ spec_code: 'h1ls.rp.k60a' }] })
    await expect(ctx.sco.listQueues({ workspace: 'ws-fail' })).rejects.toThrow('sco ssp workspaces list-queues failed (5): workspace not found')
    await expect(ctx.sco.describeQueue('--help', 'q')).rejects.toThrow('cluster "--help" must start with a letter or digit')
    expect(await fake.calls()).toEqual([
      ['--profile=pjlab', 'ssp', 'workspaces', 'list-queues', 'team-a', '--format=json'],
      ['--profile=pjlab', 'ssp', 'queues', 'get', 'c1', 'gpu-a', '--format=json'],
      ['--profile=pjlab', 'ssp', 'workspaces', 'list-queues', 'ws-fail', '--format=json'],
    ])
    expect(ctx.sco.workspaceOf({})).toBeUndefined()
  })

  it('lists AFS volumes and one volume\'s directory quota rules as the CLI\'s JSON', async () => {
    const { ctx, fake } = await gateway({ profile: 'pjlab' })
    expect(await ctx.sco.listVolumes()).toEqual([
      { id: 'vol-a', type: 'OCEANSTOR', totalCapacity: '51200GB', usedCapacity: '43TB', usedPercent: 86, state: 'ACTIVE' },
      { id: 'vol-b', name: 'afs-team', type: 'OCEANSTOR', totalCapacity: '500GB', usedCapacity: '16GB', usedPercent: 3.2, state: 'ACTIVE' },
      { id: 'vol-c', name: 'shared data', type: 'OCEANSTOR', totalCapacity: '0GB', usedCapacity: '0GB', state: 'ACTIVE' },
      { id: 'vol-d' },
    ])
    const srm = (token: number) => ['--profile=pjlab', 'srm', 'resources', 'list', `--page-token=${token}`, '--page-size=100', '--format=json']
    expect((await fake.calls()).slice(1)).toEqual([srm(1), srm(2)])
    expect(ctx.sco.queueId).toBeUndefined()
    await writeFile(join(fake.root, 'volumes.json'), JSON.stringify({ volumes: [] }))
    await expect(ctx.sco.listVolumes()).rejects.toThrow('returned JSON that is not an array')
    await writeFile(join(fake.root, 'volumes.json'), JSON.stringify([{ ID: '' }]))
    await expect(ctx.sco.listVolumes()).rejects.toThrow('returned an entry without a string ID: {"ID":""}')
    await writeFile(join(fake.root, 'volumes.json'), JSON.stringify(['note']))
    await expect(ctx.sco.listVolumes()).rejects.toThrow('without a string ID: "note"')
    await writeFile(join(fake.root, 'volumes.json'), JSON.stringify([{ ID: 'vol-a', Name: 'named' }]))
    expect(await ctx.sco.listVolumes()).toEqual([{ id: 'vol-a', name: 'named' }])
    await rm(join(fake.root, 'volumes.json'))
    expect(await ctx.sco.listDirectoryQuotas('vol-a')).toEqual([{ volume: 'vol-a', dir: '/data', limit: '10TB' }])
    await expect(ctx.sco.listDirectoryQuotas('-h')).rejects.toThrow('volume "-h" must start with a letter or digit')
    expect((await fake.calls()).slice(3)).toEqual([
      ...Array.from({ length: 4 }, () => ['--profile=pjlab', 'afs', 'volumes', 'list', '--page-size=1000', '--format=json']),
      ['--profile=pjlab', 'afs', 'volumes', 'list-dir-quota', '--instance=vol-a', '--format=json'],
    ])
  })

  it('stops paging SRM on a repeated page and fails on SRM output it cannot read', async () => {
    const { ctx, fake } = await gateway()
    await writeFile(join(fake.root, 'srm-repeat'), '')
    expect(ctx.sco.configuredDefaults).toEqual({})
    expect((await ctx.sco.listVolumes()).map(volume => volume.name)).toEqual([undefined, undefined, undefined, undefined])
    expect((await fake.calls()).filter(argv => argv.includes('srm'))).toHaveLength(2)
    await writeFile(join(fake.root, 'srm.json'), JSON.stringify({ items: [] }))
    await expect(ctx.sco.listVolumes()).rejects.toThrow('sco srm resources list returned JSON that is not an array')
    await writeFile(join(fake.root, 'srm.json'), JSON.stringify([[]]))
    await expect(ctx.sco.listVolumes()).rejects.toThrow('sco srm resources list returned a non-object entry: []')
    await writeFile(join(fake.root, 'srm.json'), JSON.stringify([]))
    expect(await ctx.sco.listVolumes()).toHaveLength(4)
  })

  it('fails loud on invalid configuration', async () => {
    fake = await fakeSco()
    for (const [config, message] of [
      [{ command: ' ' }, 'command must not be empty'],
      [{ workspace: '' }, 'workspace must not be empty'],
      [{ timeoutMs: 0 }, 'timeoutMs must be a positive integer'],
      [{ maxOutputBytes: 1.5 }, 'maxOutputBytes must be a positive integer'],
    ] as const) {
      const local = new Context()
      await local.plugin(LocalSubprocessRuntime)
      const fiber = local.plugin(ScoGateway, config)
      await expect(fiber).rejects.toThrow(message)
      await local.fiber.dispose()
    }
  })
})

describe('argv validation', () => {
  it('rejects names, values, and numbers the CLI would refuse or misread', () => {
    const base = { name: 'job-wbt', image: 'img', args: 'run' }
    expect(() => createArgv({ ...base, name: '--help' }, undefined)).toThrow('must start with "job-"')
    expect(() => createArgv({ ...base, name: 'job-UPPER' }, undefined)).toThrow('must start with "job-"')
    expect(() => createArgv({ ...base, name: `job-${'a'.repeat(29)}` }, undefined)).toThrow('at most 32 characters')
    expect(() => createArgv({ ...base, image: ' ' }, undefined)).toThrow('image must not be empty')
    expect(() => createArgv({ ...base, gpuCount: -1 }, undefined)).toThrow('gpuCount must be an integer from 0')
    expect(() => createArgv({ ...base, podCount: 0 }, undefined)).toThrow('podCount must be an integer from 1')
    expect(() => createArgv({ ...base, env: { 'BAD-NAME': 'x' } }, undefined)).toThrow('environment variable name "BAD-NAME" is invalid')
    expect(() => createArgv({ ...base, env: { A: 'x,y' } }, undefined)).toThrow('must not contain ","')
    expect(() => createArgv({ ...base, volumeMounts: ['/data'] }, undefined)).toThrow('PV_AFS:... or PV_AOSS:...')
    expect(() => createArgv({ ...base, volumeMounts: ['PV_AFS:a:/x,PV_AFS:b:/y'] }, undefined)).toThrow('PV_AFS:... or PV_AOSS:...')
    expect(() => createArgv(base, ' ')).toThrow('queueId must not be empty')
    expect(createArgv({ ...base, enableQueuing: false, dryRun: false }, undefined)).toEqual(['create', 'job-wbt', '--image=img', '--args=run'])
    expect(() => listArgv({ pageSize: 101 })).toThrow('pageSize must be an integer from 1 to 100')
    expect(() => listArgv({ skip: -1 })).toThrow('skip must be an integer from 0')
    expect(() => listArgv({ filters: [{ field: 'name', value: 'a,b' }] })).toThrow('filter value must not contain ","')
    expect(() => listArgv({ filters: [{ field: 'name', value: '' }] })).toThrow('filter value must not be empty')
    expect(() => listArgv({ orderBy: 'name' })).toThrow('orderBy must list created_at or duration')
    expect(listArgv({ orderBy: '+duration,-created_at' })).toEqual(['list', '--order-by=+duration,-created_at'])
    expect(() => logsArgv('job-wbt', { worker: '' })).toThrow('worker must not be empty')
  })

  it('rejects an empty per-request workspace', async () => {
    const { ctx } = await gateway()
    await expect(ctx.sco.listJobs({ workspace: ' ' })).rejects.toThrow('workspace must not be empty')
  })
})
