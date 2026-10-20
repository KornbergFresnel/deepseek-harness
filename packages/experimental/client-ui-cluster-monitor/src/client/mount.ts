/** Lifecycle of the `cluster` Remote contribution and the Cluster jobs page. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { ClusterWatchId, ClusterWatchRequest } from '@deepseek-ai/dsh-experimental-cluster-monitor/types'
import type {} from '@deepseek-ai/dsh-experimental-cluster-monitor/remote'
import type { RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { ClusterIcon } from './ClusterIcon.tsx'
import { ClusterPage, type ClusterPageInjected } from './ClusterPage.tsx'
import { en, NS, zh, type ClusterMonitorKey } from './locales.ts'
import { observeJob, observeWatchList } from './source.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Cluster jobs page copy. */
    'cluster.monitor': ClusterMonitorKey
  }
}

/** Panel id of the sidebar entry and its `main` page. */
export const PANEL_ID = 'cluster-monitor'

/** Services the page registration reads. */
export const inject = ['remote', 'slots', 'locale']

/** Map a Remote result to a failure message, or null on success. */
function outcome<T>(result: RemoteResult<T>): string | null {
  return result.ok ? null : result.error.message
}

function registerUi(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'cluster-monitor: dictionaries')
  const t = ctx.locale.bind(NS)
  const list = observeWatchList(ctx)
  ctx.effect(() => list.dispose, 'cluster-monitor: watch list stream')
  const injected: ClusterPageInjected = {
    hooks: { watchList: list.store },
    openJob: (watchId: ClusterWatchId) => observeJob(ctx, watchId),
    watch: async (request: ClusterWatchRequest) => outcome(await ctx.remote.cluster.watch(request)),
    unwatch: async (watchId: ClusterWatchId) => outcome(await ctx.remote.cluster.unwatch(watchId)),
    refresh: async (watchId: ClusterWatchId) => outcome(await ctx.remote.cluster.refresh(watchId)),
  }
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: PANEL_ID, locale: NS, inject: () => injected,
  }, ClusterPage))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: PANEL_ID, order: 30, locale: NS, label: () => t('panel'),
  }, ClusterIcon))
}

/**
 * Mount the experimental `cluster` namespace and the page that reads it.
 * @param ctx - Client runtime owning the Remote, dictionaries, and slots.
 * @param contribution - generated `cluster` Remote definitions.
 * @returns disposer joining UI and Remote withdrawal.
 */
export async function mountClusterMonitor(ctx: Context, contribution: TypertRemoteContribution): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(contribution)
  const ui = ctx.inject(['remote.cluster', 'slots', 'locale'], registerUi)
  try { await ui } catch (error) { await ui.dispose(); await disposeRemote(); throw error }
  return async () => { await ui.dispose(); await disposeRemote() }
}
