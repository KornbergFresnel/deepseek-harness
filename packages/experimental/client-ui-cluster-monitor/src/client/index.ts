/** Browser entry for the experimental `cluster` and `clusterConfig` Remote contributions and their pages. */
import type { Context } from '@deepseek-ai/cordis'
import clusterRemote from '@deepseek-ai/dsh-experimental-cluster-monitor/remote'
import clusterConfigRemote from '@deepseek-ai/dsh-experimental-sco-submit/remote'
import { mountClusterConfig, mountClusterMonitor } from './mount.ts'

export { inject } from './mount.ts'

/**
 * Activate the Cluster jobs and Cluster configuration pages.
 * @param ctx - Client runtime.
 * @returns complete UI and Remote disposer.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const disposeMonitor = await mountClusterMonitor(ctx, clusterRemote)
  let disposeConfig: () => Promise<void>
  try { disposeConfig = await mountClusterConfig(ctx, clusterConfigRemote) } catch (error) { await disposeMonitor(); throw error }
  return async () => { await disposeConfig(); await disposeMonitor() }
}
