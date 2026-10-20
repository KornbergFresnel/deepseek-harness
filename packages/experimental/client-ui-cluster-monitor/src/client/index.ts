/** Browser entry for the experimental `cluster` Remote contribution and the Cluster jobs page. */
import type { Context } from '@deepseek-ai/cordis'
import clusterRemote from '@deepseek-ai/dsh-experimental-cluster-monitor/remote'
import { mountClusterMonitor } from './mount.ts'

export { inject } from './mount.ts'

/**
 * Activate the Cluster jobs page.
 * @param ctx - Client runtime.
 * @returns complete UI and Remote disposer.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  return await mountClusterMonitor(ctx, clusterRemote)
}
