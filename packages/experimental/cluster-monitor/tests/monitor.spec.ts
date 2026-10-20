import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ScoGateway from '@deepseek-ai/dsh-experimental-sco'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { brandString } from '@deepseek-ai/dsh-brand'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import ClusterMonitor from '../src/index.ts'
import type { ClusterJobDetail, ClusterWatchId, Config } from '../src/index.ts'
import { fakeSco, type FakeSco } from './fake-sco.ts'

const contexts: Context[] = []
const roots: string[] = []
const fakes: FakeSco[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const fake of fakes.splice(0)) await fake.remove()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

const SLOW = { runningPollMs: 600_000, pendingPollMs: 600_000 }

async function storageRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cluster-store-'))
  roots.push(root)
  return root
}

async function boot(fake: FakeSco, root: string, config: Partial<Config> = {}): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(ScoGateway, { command: fake.command })
  await ctx.plugin(ClusterMonitor, { ...ClusterMonitor.Config(), ...SLOW, ...config })
  return ctx
}

async function setup(config: Partial<Config> = {}) {
  const fake = await fakeSco()
  fakes.push(fake)
  const root = await storageRoot()
  const ctx = await boot(fake, root, config)
  return { ctx, fake, root }
}

async function until<T>(read: () => T, accept: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const value = read()
    if (accept(value)) return value
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('condition not reached')
}

const TABLE = (step: number, loss: number) => `INFO\nmetric      value\n----------  -----\nstep        ${step}\ntrain/loss  ${loss}\n`

describe('cluster monitor', () => {
  it('watches a job, reads its state and one log round, and parses training curves', async () => {
    const { ctx, fake } = await setup()
    await fake.job('job-wbt', { name: 'job-wbt', state: 'RUNNING', create_time: 'c', status: { start_time: '2026-10-20T01:00:00Z' } })
    await fake.logs('job-wbt', TABLE(10, 0.5) + TABLE(20, 0.25) + '[step=20]  train/reward=3\n[step=20]  train/reward=4\n')
    const row = await ctx.clusterMonitor.watch({ name: ' job-wbt ', workspace: 'team-a' })
    expect(row).toMatchObject({ name: 'job-wbt', workspace: 'team-a', origin: 'manual', phase: 'unknown', latest: {} })
    expect((await ctx.clusterMonitor.watch({ name: 'job-wbt', workspace: 'team-a' })).id).toBe(row.id)
    const detail = await until(() => ctx.clusterMonitor.detail(row.id), job => job.checkedAt !== undefined)
    expect(detail).toMatchObject({
      phase: 'running', rawState: 'RUNNING', createdAt: 'c', startedAt: '2026-10-20T01:00:00Z', step: 20,
      latest: { 'train/loss': 0.25, 'train/reward': 4 },
      series: [
        { name: 'train/loss', points: [{ step: 10, value: 0.5 }, { step: 20, value: 0.25 }] },
        { name: 'train/reward', points: [{ step: 20, value: 4 }] },
      ],
    })
    expect(detail.logTail).toContain('train/loss  0.25')
    expect(JSON.parse(detail.describe!)).toMatchObject({ name: 'job-wbt' })
    expect(ctx.clusterMonitor.list().map(item => item.id)).toEqual([row.id])
    expect(await fake.calls()).toEqual([
      ['ssp', 'jobs', 'describe', 'job-wbt', '--workspace-name=team-a', '--format=json'],
      ['ssp', 'jobs', 'stream-logs', 'job-wbt', '--workspace-name=team-a'],
    ])
  })

  it('appends only newer steps, reads logs once more when the job ends, and stops polling', async () => {
    const { ctx, fake } = await setup()
    await fake.job('job-a', { state: 'Running' })
    await fake.logs('job-a', TABLE(10, 1))
    const { id } = await ctx.clusterMonitor.watch({ name: 'job-a' })
    await until(() => ctx.clusterMonitor.detail(id), job => job.step === 10)
    await fake.job('job-a', { state: 'Succeeded', end_time: 'e' })
    await fake.logs('job-a', TABLE(10, 1) + '[step=30]  train/reward=2')
    await ctx.clusterMonitor.refresh(id)
    const ended = ctx.clusterMonitor.detail(id)
    expect(ended).toMatchObject({ phase: 'succeeded', finishedAt: 'e', step: 30, latest: { 'train/reward': 2 } })
    expect(ended.latest).not.toHaveProperty('train/loss')
    expect(ended.series.map(series => series.points.map(point => point.step))).toEqual([[10], [30]])
    await fake.logs('job-a', undefined)
    await ctx.clusterMonitor.refresh(id)
    expect(ctx.clusterMonitor.detail(id).phase).toBe('succeeded')
    expect(ctx.clusterMonitor.detail(id).logError).toContain('unavailable')
    expect((await fake.calls()).filter(call => call[2] === 'stream-logs')).toHaveLength(3)
  })

  it('keeps the last state and reports failures of describe and log reads', async () => {
    const { ctx, fake } = await setup()
    await fake.job('job-b', { state: 'Pending' })
    const { id } = await ctx.clusterMonitor.watch({ name: 'job-b' })
    await until(() => ctx.clusterMonitor.detail(id), job => job.phase === 'pending')
    await fake.job('job-b', undefined)
    await ctx.clusterMonitor.refresh(id)
    const failed = ctx.clusterMonitor.detail(id)
    expect(failed.phase).toBe('pending')
    expect(failed.error).toContain('describe job-b unavailable')
    expect(failed.logError).toContain('stream-logs job-b unavailable')
    await fake.job('job-b', { state: 'Pending' })
    await fake.logs('job-b', 'hello\n')
    await ctx.clusterMonitor.refresh(id)
    const recovered = ctx.clusterMonitor.detail(id)
    expect(recovered.error).toBeUndefined()
    expect(recovered.logError).toBeUndefined()
    expect(recovered.logTail).toBe('hello\n')
  })

  it('thins long series, keeping the newest point', async () => {
    const { ctx, fake } = await setup({ maxPointsPerSeries: 16 })
    await fake.job('job-c', { state: 'Running' })
    await fake.logs('job-c', Array.from({ length: 17 }, (_, index) => `[step=${index + 1}]  loss=${index}`).join('\n'))
    const { id } = await ctx.clusterMonitor.watch({ name: 'job-c' })
    const detail = await until(() => ctx.clusterMonitor.detail(id), job => job.step === 17)
    const steps = detail.series[0]!.points.map(point => point.step)
    expect(steps).toHaveLength(9)
    expect(steps.at(-1)).toBe(17)
  })

  it('rejects invalid references and unknown ids with typed codes', async () => {
    const { ctx } = await setup()
    const failure = (promise: Promise<unknown>) => promise.then(() => undefined, (error: unknown) => remoteErrorOf(error))
    expect(await failure(ctx.clusterMonitor.watch({ name: 'Job With Spaces' }))).toMatchObject({ code: 'cluster/invalid-job', details: { reason: 'name' } })
    expect(await failure(ctx.clusterMonitor.watch({ name: 'job-a', workspace: ' ' }))).toMatchObject({ code: 'cluster/invalid-job', details: { reason: 'workspace' } })
    const missing = brandString<ClusterWatchId>('cw-missing')
    expect(remoteErrorOf((() => { try { ctx.clusterMonitor.detail(missing) } catch (error) { return error } })()))
      .toMatchObject({ code: 'cluster/not-found', details: { watchId: 'cw-missing' } })
    expect(await failure(ctx.clusterMonitor.unwatch(missing))).toMatchObject({ code: 'cluster/not-found' })
    expect(await failure(ctx.clusterMonitor.refresh(missing))).toMatchObject({ code: 'cluster/not-found' })
  })

  it('streams the list and one job until the watch is removed', async () => {
    const { ctx, fake } = await setup()
    await fake.job('job-d', { state: 'Running' })
    await fake.logs('job-d', TABLE(5, 2))
    const lifetime = new AbortController()
    const list = ctx.clusterMonitor.follow(lifetime.signal)[Symbol.asyncIterator]()
    expect((await list.next()).value).toEqual([])
    const { id } = await ctx.clusterMonitor.watch({ name: 'job-d' })
    expect((await list.next()).value).toMatchObject([{ id }])
    const frames: ClusterJobDetail[] = []
    const jobStream = (async () => {
      for await (const frame of ctx.clusterMonitor.followJob(id, lifetime.signal)) frames.push(frame)
    })()
    await until(() => frames.at(-1), frame => frame?.step === 5)
    await ctx.clusterMonitor.unwatch(id)
    await jobStream
    expect(ctx.clusterMonitor.list()).toEqual([])
    expect((await list.next()).value).toEqual([])
    const waiting = list.next()
    lifetime.abort()
    expect((await waiting).done).toBe(true)
    const dead = new AbortController()
    dead.abort()
    expect((await ctx.clusterMonitor.follow(dead.signal)[Symbol.asyncIterator]().next()).done).toBe(true)
  })

  it('watches jobs the sco gateway creates unless disabled', async () => {
    const { ctx, fake } = await setup()
    await fake.job('job-new', { state: 'Pending' })
    ctx.emit('sco/job-created', { name: 'job-new', workspace: 'team-a' })
    ctx.emit('sco/job-created', { name: 'Bad Name' })
    const [row] = await until(() => ctx.clusterMonitor.list(), rows => rows.length === 1)
    expect(row).toMatchObject({ name: 'job-new', workspace: 'team-a', origin: 'created' })
    const off = await setup({ watchCreatedJobs: false })
    off.ctx.emit('sco/job-created', { name: 'job-new' })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(off.ctx.clusterMonitor.list()).toEqual([])
  })

  it('resumes stored watches after a restart and polls only unfinished jobs', async () => {
    const { ctx, fake, root } = await setup()
    await fake.job('job-run', { state: 'Running' })
    await fake.job('job-done', { state: 'Failed' })
    const running = await ctx.clusterMonitor.watch({ name: 'job-run' })
    const done = await ctx.clusterMonitor.watch({ name: 'job-done' })
    await until(() => ctx.clusterMonitor.list(), rows => rows.every(item => item.checkedAt !== undefined))
    await ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(ctx), 1)
    const before = (await fake.calls()).length
    const again = await boot(fake, root)
    await until(() => again.clusterMonitor.list(), rows => rows.length === 2)
    const resumed = await until(() => again.clusterMonitor.detail(running.id), job => job.checkedAt !== undefined)
    expect(resumed.phase).toBe('running')
    await new Promise(resolve => setTimeout(resolve, 300))
    const describes = (await fake.calls()).slice(before).filter(call => call[2] === 'describe').map(call => call[3])
    expect(describes).toEqual(['job-run'])
    expect(again.clusterMonitor.detail(done.id).phase).toBe('failed')
  })

  it('queues sco calls beyond the concurrency limit and abandons queued calls on disposal', async () => {
    const { ctx, fake } = await setup({ maxConcurrentCalls: 1 })
    await fake.job('job-x', { state: 'Pending' })
    await fake.job('job-y', { state: 'Pending' })
    const x = await ctx.clusterMonitor.watch({ name: 'job-x' })
    const y = await ctx.clusterMonitor.watch({ name: 'job-y' })
    await until(() => ctx.clusterMonitor.list(), rows => rows.every(item => item.phase === 'pending'))
    const pending = [ctx.clusterMonitor.refresh(x.id), ctx.clusterMonitor.refresh(y.id)]
    await ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(ctx), 1)
    await expect(Promise.all(pending)).resolves.toEqual([undefined, undefined])
  })
})
