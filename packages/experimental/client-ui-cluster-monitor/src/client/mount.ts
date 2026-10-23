/** Lifecycles of the `cluster` and `clusterConfig` Remote contributions and their pages. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { ClusterWatchId, ClusterWatchRequest } from '@deepseek-ai/dsh-experimental-cluster-monitor/types'
import type {} from '@deepseek-ai/dsh-experimental-cluster-monitor/remote'
import type { ScoDefaults } from '@deepseek-ai/dsh-experimental-sco/types'
import type { ScoSourceSaveRequest } from '@deepseek-ai/dsh-experimental-sco-submit/types'
import type {} from '@deepseek-ai/dsh-experimental-sco-submit/remote'
import type { RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { ClusterIcon } from './ClusterIcon.tsx'
import { ClusterPage, type ClusterPageInjected } from './ClusterPage.tsx'
import { ConfigIcon } from './ConfigIcon.tsx'
import { ConfigPage, type ConfigPageInjected } from './ConfigPage.tsx'
import { CONFIG_NS, configEn, configZh, type ClusterConfigKey } from './config-locales.ts'
import { en, NS, zh, type ClusterMonitorKey } from './locales.ts'
import { observeJob, observeOverview, observeWatchList } from './source.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Cluster jobs page copy. */
    'cluster.monitor': ClusterMonitorKey
    /** Cluster configuration page copy. */
    'cluster.config': ClusterConfigKey
  }
}

/** Panel id of the sidebar entry and its `main` page. */
export const PANEL_ID = 'cluster-monitor'

/** Panel id of the configuration sidebar entry and its `main` page. */
export const CONFIG_PANEL_ID = 'cluster-config'

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

function registerConfigUi(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(CONFIG_NS, { zh: configZh, en: configEn }), 'cluster-config: dictionaries')
  const t = ctx.locale.bind(CONFIG_NS)
  const overview = observeOverview(ctx)
  ctx.effect(() => overview.dispose, 'cluster-config: overview stream')
  const injected: ConfigPageInjected = {
    hooks: { overview: overview.store },
    saveSource: async (request: ScoSourceSaveRequest) => outcome(await ctx.remote.clusterConfig.saveSource(request)),
    deleteSource: async (name: string) => outcome(await ctx.remote.clusterConfig.deleteSource(name)),
    saveDefaults: async (defaults: ScoDefaults) => outcome(await ctx.remote.clusterConfig.saveDefaults(defaults)),
    refreshOptions: async () => outcome(await ctx.remote.clusterConfig.refreshOptions()),
    loadVolumes: async () => {
      const result = await ctx.remote.clusterConfig.volumes()
      return result.ok ? { ok: true, value: result.value } : { ok: false, message: result.error.message }
    },
  }
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: CONFIG_PANEL_ID, locale: CONFIG_NS, inject: () => injected,
  }, ConfigPage))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: CONFIG_PANEL_ID, order: 31, locale: CONFIG_NS, label: () => t('panel'),
  }, ConfigIcon))
}

async function mountUi(
  ctx: Context, contribution: TypertRemoteContribution, namespace: string, register: (ctx: Context) => void,
): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(contribution)
  const ui = ctx.inject([`remote.${namespace}`, 'slots', 'locale'], register)
  try { await ui } catch (error) { await ui.dispose(); await disposeRemote(); throw error }
  return async () => { await ui.dispose(); await disposeRemote() }
}

/**
 * Mount the experimental `cluster` namespace and the page that reads it.
 * @param ctx - Client runtime owning the Remote, dictionaries, and slots.
 * @param contribution - generated `cluster` Remote definitions.
 * @returns disposer joining UI and Remote withdrawal.
 */
export async function mountClusterMonitor(ctx: Context, contribution: TypertRemoteContribution): Promise<() => Promise<void>> {
  return await mountUi(ctx, contribution, 'cluster', registerUi)
}

/**
 * Mount the experimental `clusterConfig` namespace and the configuration page that reads it.
 * @param ctx - Client runtime owning the Remote, dictionaries, and slots.
 * @param contribution - generated `clusterConfig` Remote definitions.
 * @returns disposer joining UI and Remote withdrawal.
 */
export async function mountClusterConfig(ctx: Context, contribution: TypertRemoteContribution): Promise<() => Promise<void>> {
  return await mountUi(ctx, contribution, 'clusterConfig', registerConfigUi)
}
