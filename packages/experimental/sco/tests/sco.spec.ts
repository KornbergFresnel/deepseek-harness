import { rm } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import ScoGateway from '../src/index.ts'
import type { Config, CreateScoJobRequest } from '../src/index.ts'
import { createArgv, listArgv, logsArgv, volumeArgv } from '../src/argv.ts'
import { parseTable } from '../src/table.ts'
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
    await ctx.sco.createJob({ name: 'job-wbt', image: 'img', args: 'run' })
    expect(created).toEqual([{ name: 'job-wbt' }])
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

  it('creates jobs from flags, returning the merged spec for a dry run and the CLI output otherwise', async () => {
    const { ctx, fake } = await gateway({ queueId: '/queues/default' })
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
    expect(await ctx.sco.listQueues({ workspace: 'team-a' })).toHaveProperty('queues')
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

  it('lists AFS volumes from the CLI table and reads directories and quota rules as text', async () => {
    const { ctx, fake } = await gateway({ profile: 'pjlab' })
    expect(await ctx.sco.listVolumes()).toEqual([
      { id: '019fc675-8a27-7a12-abad-47a872e18d81', totalcapacity: '51200GB', usedcapacity: '43TB', createtime: '2026-08-03 +0000 UTC', state: 'ACTIVE' },
      { name: 'team', id: '019fad51-5ed2-7e37-84d1-d6f19f904219', totalcapacity: '500GB', usedcapacity: '16GB', createtime: '2026-07-29', state: 'ACTIVE' },
      { name: 'new', id: '019f8d42-d97f-7cce-82cf-b6413fd0d314', usedcapacity: '1GB', createtime: '2026-07-23', state: 'ACTIVE' },
      { name: 'zero', id: '019f8dc9-4464-757d-ab49-2744c08e2ff4', totalcapacity: '0GB', usedcapacity: '0GB', createtime: '2026-07-23', state: 'ACTIVE' },
    ])
    expect(await ctx.sco.listVolumeDirectory('vol-a')).toBe('volumes ls -i vol-a')
    expect(await ctx.sco.listVolumeDirectory('vol-a', '/data/npz')).toBe('volumes ls -i vol-a -d /data/npz')
    expect(await ctx.sco.listDirectoryQuotas('vol-a', '/data')).toBe('dir-quota list -i vol-a -d /data')
    await expect(ctx.sco.listDirectoryQuotas('vol-fail')).rejects.toThrow('sco afs dir-quota list failed (7): volume not found')
    expect(await fake.calls()).toEqual([
      ['--profile=pjlab', 'afs', 'volumes', 'list'],
      ['--profile=pjlab', 'afs', 'volumes', 'ls', '-i', 'vol-a'],
      ['--profile=pjlab', 'afs', 'volumes', 'ls', '-i', 'vol-a', '-d', '/data/npz'],
      ['--profile=pjlab', 'afs', 'dir-quota', 'list', '-i', 'vol-a', '-d', '/data'],
      ['--profile=pjlab', 'afs', 'dir-quota', 'list', '-i', 'vol-fail'],
    ])
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
    expect(() => volumeArgv('-h')).toThrow('volume "-h" must start with a letter or digit')
    expect(() => volumeArgv('vol-a', 'data')).toThrow('directory "data" must be an absolute path inside the volume')
  })

  it('rejects an empty per-request workspace', async () => {
    const { ctx } = await gateway()
    await expect(ctx.sco.listJobs({ workspace: ' ' })).rejects.toThrow('workspace must not be empty')
  })
})

describe('sco table parsing', () => {
  const border = '+----+-----+'
  it('merges wrapped header and row lines, strips colors, and ignores text outside the table', () => {
    const table = ['note: cached', border, '| ID | USED |', '|    | CAP  |', border, '| \u001b[32ma\u001b[0m  | 1TB |', '|    | 2   |', border].join('\n')
    expect(parseTable(table, 'id')).toEqual([{ id: 'a', usedcap: '1TB 2' }])
    expect(parseTable(' \n', 'id')).toEqual([])
  })

  it('rejects output it cannot read as rows', () => {
    expect(() => parseTable('permission denied', 'id')).toThrow('expected a table but got: permission denied')
    expect(() => parseTable([border, '| ID | X |', border, '| a |'].join('\n'), 'id')).toThrow('table row has 1 cells but the header has 2')
    expect(() => parseTable([border, '| NAME |', border, '| a |'].join('\n'), 'id')).toThrow('table has no id column: NAME')
    expect(() => parseTable([border, '| ID | X |', border, '|  | b |'].join('\n'), 'id')).toThrow('table row starts with an empty id cell')
  })
})
