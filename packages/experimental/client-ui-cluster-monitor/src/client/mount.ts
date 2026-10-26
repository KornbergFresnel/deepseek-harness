/** Lifecycles of the `cluster` and `clusterConfig` Remote contributions and their pages. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import { brandString } from '@deepseek-ai/dsh-brand'
import { IconChecklistOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { ClusterWatchChanges, ClusterWatchId, ClusterWatchRequest } from '@deepseek-ai/dsh-experimental-cluster-monitor/types'
import type {} from '@deepseek-ai/dsh-experimental-cluster-monitor/remote'
import type { ScoDefaults } from '@deepseek-ai/dsh-experimental-sco/types'
import type { ScoConfigFormAnswer, ScoConfigSaveRequest, ScoSourceSaveRequest } from '@deepseek-ai/dsh-experimental-sco-submit/types'
import type {} from '@deepseek-ai/dsh-experimental-sco-submit/remote'
import type { RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { ClusterIcon } from './ClusterIcon.tsx'
import { ClusterPage, type ClusterPageInjected } from './ClusterPage.tsx'
import { ConfigIcon } from './ConfigIcon.tsx'
import { ConfigPage, type ConfigPageInjected } from './ConfigPage.tsx'
import { CONFIG_NS, configEn, configZh, type ClusterConfigKey } from './config-locales.ts'
import { FormToolRow, type FormRowInjected } from './FormToolRow.tsx'
import { en, NS, zh, type ClusterMonitorKey } from './locales.ts'
import { PresetsIcon } from './PresetsIcon.tsx'
import { SavedConfigsPage, type SavedConfigsInjected } from './SavedConfigsPage.tsx'
import { SessionJobsGuide, SessionJobsTab, SessionJobsTitle, type SessionJobsInjected } from './SessionJobs.tsx'
import { observeForms, observeJob, observeOverview, observeWatchList } from './source.ts'
import { WORKLOAD_NS, workloadEn, workloadZh, type ClusterWorkloadKey } from './workload-locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Cluster jobs page copy. */
    'cluster.monitor': ClusterMonitorKey
    /** Cluster configuration page copy. */
    'cluster.config': ClusterConfigKey
    /** Configuration form, its chat row, and Job configurations page copy. */
    'cluster.workload': ClusterWorkloadKey
  }
}

/** Panel id of the sidebar entry and its `main` page. */
export const PANEL_ID = 'cluster-monitor'

/** Panel id of the configuration sidebar entry and its `main` page. */
export const CONFIG_PANEL_ID = 'cluster-config'

/** Panel id of the Job configurations sidebar entry and its `main` page. */
export const PRESETS_PANEL_ID = 'cluster-presets'

/** Right-sidebar tab type of the Session jobs page; also the key of its body, title, and guide card. */
export const SESSION_TAB_ID = '@deepseek-ai/dsh-experimental-client-ui-cluster-monitor/session-jobs'

/** Tab kind of the Session jobs page. */
export const SESSION_TAB_KIND = 'cluster-session-jobs'

/** Tool whose chat row renders the configuration form. */
export const FORM_TOOL = 'sco_config_form'

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
    configure: async (watchId: ClusterWatchId, changes: ClusterWatchChanges) =>
      outcome(await ctx.remote.cluster.configure(watchId, changes)),
    metricSources: async () => {
      const result = await ctx.remote.cluster.metricSources()
      return result.ok ? { kinds: result.value } : { error: result.error.message }
    },
  }
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: PANEL_ID, locale: NS, inject: () => injected,
  }, ClusterPage))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: PANEL_ID, order: 30, locale: NS, label: () => t('panel'),
  }, ClusterIcon))
  const session: SessionJobsInjected = {
    hooks: { watchList: list.store }, openJob: injected.openJob, refresh: injected.refresh, unwatch: injected.unwatch,
    configure: injected.configure, metricSources: injected.metricSources,
  }
  ctx.inject(['sidebarRightTabs'], (ctx) => {
    ctx.effect(() => ctx.sidebarRightTabs.register({
      id: SESSION_TAB_ID,
      kind: SESSION_TAB_KIND,
      title: () => t('session.tab'),
      guide: [{
        id: 'jobs', order: 5, title: () => t('session.tab'), description: () => t('session.guideDescription'), icon: IconChecklistOutlineRegular,
      }],
    }), 'cluster-monitor: Session jobs tab type')
  })
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: SESSION_TAB_ID, locale: NS, inject: () => session,
  }, SessionJobsTab))
  ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab.title', key: SESSION_TAB_ID,
  }, SessionJobsTitle))
  ctx.slots.inject('sidebar.right.tab.guide.entry', () => ctx.slots.register({
    name: 'sidebar.right.tab.guide.entry', key: SESSION_TAB_ID, locale: NS, inject: () => session,
  }, SessionJobsGuide))
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
  registerWorkloadUi(ctx, overview.store)
}

function registerWorkloadUi(ctx: Context, overview: FormRowInjected['hooks']['overview']): void {
  ctx.effect(() => ctx.locale.register(WORKLOAD_NS, { zh: workloadZh, en: workloadEn }), 'cluster-workload: dictionaries')
  const t = ctx.locale.bind(WORKLOAD_NS)
  const forms = observeForms(ctx)
  ctx.effect(() => forms.dispose, 'cluster-workload: form stream')
  const saveConfig = async (request: ScoConfigSaveRequest) => outcome(await ctx.remote.clusterConfig.saveConfig(request))
  const row: FormRowInjected = {
    hooks: { forms: forms.store, overview },
    answer: async (callId: string, answer: ScoConfigFormAnswer) =>
      outcome(await ctx.remote.clusterConfig.answerForm(brandString<ToolCallId>(callId), answer)),
    saveConfig,
  }
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview', key: FORM_TOOL, locale: WORKLOAD_NS, inject: () => row,
  }, FormToolRow))
  const presets: SavedConfigsInjected = {
    hooks: { overview },
    saveConfig,
    deleteConfig: async (name: string) => outcome(await ctx.remote.clusterConfig.deleteConfig(name)),
  }
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: PRESETS_PANEL_ID, locale: WORKLOAD_NS, inject: () => presets,
  }, SavedConfigsPage))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: PRESETS_PANEL_ID, order: 32, locale: WORKLOAD_NS, label: () => t('presets.panel'),
  }, PresetsIcon))
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
