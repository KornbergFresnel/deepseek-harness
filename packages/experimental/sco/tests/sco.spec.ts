import { rm } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import ScoGateway from '../src/index.ts'
import type { Config } from '../src/index.ts'
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
    await ctx.sco.listJobs()
    await ctx.sco.describeJob('job-wbt')
    await ctx.sco.listWorkers('job-wbt')
    await ctx.sco.readLogs('job-wbt')
    await ctx.sco.stopJobs(['job-wbt'])
    await ctx.sco.createJob({ name: 'job-wbt', image: 'img', args: 'run' })
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
    const request = {
      name: 'job-wbt', displayName: 'wbt', image: 'registry/rlh:wbt', imageType: 'PRIVATE', args: 'python -m train --flag=-1',
      framework: 'PYTORCH_DDP', podCount: 1, gpuCount: 8, cpuCount: 64, memoryGib: 512, machineType: 'h1ls.rp.k60a', rdmaName: 'rdma0',
      shmSizeGib: 64, priority: 'HIGH', env: { WANDB_MODE: 'offline' }, volumeMounts: ['PV_AFS:0000:/data:/train'], maxAttempts: 0,
      enableQueuing: true, tensorboardLogPath: '/data/tb',
    } as const
    expect(await ctx.sco.createJob({ ...request, dryRun: true })).toEqual({ kind: 'dry-run', job: { name: 'job-wbt', spec: {} } })
    expect(await ctx.sco.createJob({ ...request, queueId: '/queues/override', workspace: 'team-a' }))
      .toEqual({ kind: 'created', name: 'job-wbt', output: 'created job-wbt' })
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
