/** Reconnecting browser mirrors of the Host watch list, of one watched job, and of the gateway configuration overview. */

import type { Context } from '@deepseek-ai/cordis'
import { RemoteStreamCarrierError } from '@deepseek-ai/dsh-api-gateway/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ClusterJobDetail, ClusterWatchId, ClusterWatchRow } from '@deepseek-ai/dsh-experimental-cluster-monitor/types'
import type {} from '@deepseek-ai/dsh-experimental-cluster-monitor/remote'
import type { ScoConfigOverview } from '@deepseek-ai/dsh-experimental-sco-submit/types'
import type {} from '@deepseek-ai/dsh-experimental-sco-submit/remote'

/** Latest value of one Host stream with its carrier state; a carrier loss keeps the last value. */
export interface Mirror<T> {
  readonly value: T | null
  readonly connected: boolean
  readonly error: string | null
}

/** A mirror and the disposer that closes its stream. */
export interface MirrorHandle<T> {
  readonly store: SnapshotStore<Mirror<T>>
  readonly dispose: () => Promise<void>
}

function mirror<T>(ctx: Context, name: string, open: (signal: AbortSignal) => AsyncIterable<T>): MirrorHandle<T> {
  const store = createSnapshotStore<Mirror<T>>({ value: null, connected: false, error: null })
  let disposed = false
  const isDisposed = (): boolean => disposed
  const fail = (error: unknown): void => {
    store.set({ ...store.getSnapshot(), connected: false, error: error instanceof Error ? error.message : String(error) })
  }
  const stream = ctx.remote.$stream<T>({
    name, open, ended: () => new RemoteStreamCarrierError(`${name} ended`), carrierFailed: fail,
  })
  const observing = (async () => {
    try {
      for await (const item of stream) {
        store.set({ value: item.value, connected: true, error: null })
        item.accept()
      }
    } catch (error) {
      if (!isDisposed()) fail(error)
    }
  })()
  return { store, dispose: async () => { disposed = true; await stream.dispose(); await observing } }
}

/**
 * Mirror the complete watch list.
 * @param ctx - Client context with the mounted `cluster` namespace.
 * @returns the list mirror and its disposer.
 */
export function observeWatchList(ctx: Context): MirrorHandle<ClusterWatchRow[]> {
  return mirror(ctx, 'Cluster watch list', signal => ctx.remote.cluster.follow(signal))
}

/**
 * Mirror one watched job's detail until the caller disposes it or the watch is removed.
 * @param ctx - Client context with the mounted `cluster` namespace.
 * @param watchId - watched job.
 * @returns the detail mirror and its disposer.
 */
export function observeJob(ctx: Context, watchId: ClusterWatchId): MirrorHandle<ClusterJobDetail> {
  return mirror(ctx, `Cluster job ${watchId}`, signal => ctx.remote.cluster.followJob(watchId, signal))
}

/**
 * Mirror the gateway configuration overview.
 * @param ctx - Client context with the mounted `clusterConfig` namespace.
 * @returns the overview mirror and its disposer.
 */
export function observeOverview(ctx: Context): MirrorHandle<ScoConfigOverview> {
  return mirror(ctx, 'Cluster configuration', signal => ctx.remote.clusterConfig.follow(signal))
}
