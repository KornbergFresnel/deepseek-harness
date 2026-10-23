/** Watch-list and job mirrors follow their Host streams, keep the last value on carrier loss, and stay quiet on disposal. */
import { Context } from '@deepseek-ai/cordis'
import type { RemoteStreamOptions } from '@deepseek-ai/dsh-api-gateway/client'
import { RemoteStreamCarrierError } from '@deepseek-ai/dsh-api-gateway/client'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ClusterWatchId, ClusterWatchRow } from '@deepseek-ai/dsh-experimental-cluster-monitor/types'
import { expect, it, onTestFinished, vi } from 'vitest'
import { observeForms, observeJob, observeOverview, observeWatchList } from '../src/client/source.ts'

const id = brandString<ClusterWatchId>('w1')
const row: ClusterWatchRow = { id, name: 'job-wbt', origin: 'manual', phase: 'running', rawState: 'Running', watchedAt: 't', latest: {} }

function fixture(failure?: unknown) {
  const abort = new AbortController(), release = Promise.withResolvers<undefined>(), accept = vi.fn()
  const opened: RemoteStreamOptions<unknown>[] = []
  const follow = vi.fn(), followJob = vi.fn(), followConfig = vi.fn(), followForms = vi.fn()
  const stream = {
    signal: abort.signal,
    async *[Symbol.asyncIterator]() {
      yield { value: [row], accept }
      await release.promise
      if (failure !== undefined) { abort.abort(); throw failure }
    },
    dispose: async () => { abort.abort(); release.resolve(undefined) },
  }
  // Only the Gateway-owned transport is replaced; the mirror publication remains real.
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  ctx.provide('remote', { cluster: { follow, followJob }, clusterConfig: { follow: followConfig, followForms },
    $stream: (options: RemoteStreamOptions<unknown>) => { opened.push(options); return stream },
  })
  return { ctx, opened, follow, followJob, followConfig, followForms, accept, release }
}

it('publishes each Host value, opens the matching stream, and reports a carrier loss without dropping the value', async () => {
  const b = fixture()
  const list = observeWatchList(b.ctx)
  await vi.waitFor(() => { expect(list.store.getSnapshot()).toEqual({ value: [row], connected: true, error: null }) })
  expect(b.accept).toHaveBeenCalledOnce()
  const signal = new AbortController().signal
  b.opened[0]!.open(signal)
  expect(b.follow).toHaveBeenCalledWith(signal)
  expect(b.opened[0]!.ended(true)).toBeInstanceOf(RemoteStreamCarrierError)
  b.opened[0]!.carrierFailed?.(new RemoteStreamCarrierError('connection lost'))
  expect(list.store.getSnapshot()).toEqual({ value: [row], connected: false, error: 'connection lost' })
  await list.dispose()

  const job = observeJob(b.ctx, id)
  b.opened[1]!.open(signal)
  expect(b.followJob).toHaveBeenCalledWith(id, signal)
  expect(b.opened[1]!.name).toBe('Cluster job w1')
  await job.dispose()

  const overview = observeOverview(b.ctx)
  b.opened[2]!.open(signal)
  expect(b.followConfig).toHaveBeenCalledWith(signal)
  expect(b.opened[2]!.name).toBe('Cluster configuration')
  await overview.dispose()

  const forms = observeForms(b.ctx)
  b.opened[3]!.open(signal)
  expect(b.followForms).toHaveBeenCalledWith(signal)
  expect(b.opened[3]!.name).toBe('Cluster configuration forms')
  await forms.dispose()
})

it.each([new Error('invalid row'), 'invalid row'])('reports a terminal stream failure', async (failure) => {
  const b = fixture(failure)
  const list = observeWatchList(b.ctx)
  b.release.resolve(undefined)
  await vi.waitFor(() => { expect(list.store.getSnapshot()).toMatchObject({ connected: false, error: 'invalid row' }) })
  await list.dispose()
})

it('does not publish a disposal rejection as a Host failure', async () => {
  const b = fixture(new Error('disposed'))
  const list = observeWatchList(b.ctx)
  await vi.waitFor(() => { expect(list.store.getSnapshot().connected).toBe(true) })
  await list.dispose()
  expect(list.store.getSnapshot().error).toBeNull()
})
