/** The Remote namespace, dictionaries, page, and sidebar entry follow Client plugin disposal. */
import { Context, Service } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ClusterWatchId } from '@deepseek-ai/dsh-experimental-cluster-monitor/types'
import { RemoteError, type TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { expect, it, vi } from 'vitest'
import { apply as hostApply } from '../src/index.ts'
import { ClusterIcon } from '../src/client/ClusterIcon.tsx'
import { ClusterPage, type ClusterPageInjected } from '../src/client/ClusterPage.tsx'
import { inject, mountClusterMonitor, PANEL_ID } from '../src/client/mount.ts'
import { NS } from '../src/client/locales.ts'

const REMOTE: TypertRemoteContribution = { package: '@deepseek-ai/dsh-experimental-cluster-monitor', descriptors: [] }
const id = brandString<ClusterWatchId>('w1')
const disposed: string[] = []

vi.mock('../src/client/source.ts', () => ({
  observeWatchList: () => ({ store: createSnapshotStore({ value: [], connected: true, error: null }), dispose: async () => { disposed.push('list') } }),
  observeJob: (_ctx: unknown, watchId: string) => ({
    store: createSnapshotStore({ value: null, connected: false, error: null }), dispose: async () => { disposed.push(watchId) },
  }),
}))

function isInjected(value: object): value is ClusterPageInjected {
  return 'openJob' in value && 'watch' in value && 'unwatch' in value && 'refresh' in value && 'hooks' in value
}

async function fixture(fail = false) {
  const ctx = new Context(), unmount = vi.fn(async () => {})
  class Remote extends Service {
    constructor() { super(ctx, 'remote') }
    async $mount(contribution: TypertRemoteContribution) {
      expect(contribution).toBe(REMOTE)
      return unmount
    }
  }
  new Remote()
  const ok = { ok: true, value: {} }
  const cluster = { watch: vi.fn(async () => ok), unwatch: vi.fn(async () => ok), refresh: vi.fn(async () => ok) }
  ctx.provide('remote.cluster', cluster)
  ctx.provide('locale', new LocaleRuntime(ctx))
  await ctx.plugin(SlotRegistry)
  ctx.slots.register({ name: 'root', children: {
    'main': { kind: 'keyed', scope: 'root' },
    'sidebar.panellist': { kind: 'list', scope: 'root' },
  } } as never, () => null)
  if (fail) vi.spyOn(ctx.slots, 'inject').mockImplementationOnce(() => { throw new Error('slot failed') })
  return { ctx, unmount, cluster }
}

it('registers the localized page and sidebar entry, maps Remote results, and withdraws everything on disposal', async () => {
  hostApply()
  const b = await fixture()
  try {
    const fiber = b.ctx.plugin({ inject: [...inject], apply: ctx => mountClusterMonitor(ctx, REMOTE) })
    await fiber
    const page = b.ctx.slots.entries('main').find(item => item.component === ClusterPage)!
    expect(page).toMatchObject({ locale: NS, options: { key: PANEL_ID } })
    const panel = b.ctx.slots.entries('sidebar.panellist').find(item => item.component === ClusterIcon)!
    expect(panel).toMatchObject({ locale: NS, options: { id: PANEL_ID, order: 30 } })
    const label = panel.options.label
    expect(typeof label === 'function' ? label() : label).toBe('Cluster jobs')

    const actions = page.inject!()
    expect(isInjected(actions)).toBe(true)
    if (!isInjected(actions)) return
    expect(actions.hooks.watchList.getSnapshot()).toEqual({ value: [], connected: true, error: null })
    const job = actions.openJob(id)
    await job.dispose()
    expect(await actions.watch({ name: 'job-wbt' })).toBeNull()
    expect(b.cluster.watch).toHaveBeenCalledWith({ name: 'job-wbt' })
    expect(await actions.refresh(id)).toBeNull()
    b.cluster.unwatch.mockResolvedValueOnce({ ok: false, error: new RemoteError('cluster/not-found', 'gone', { watchId: id }) } as never)
    expect(await actions.unwatch(id)).toBe('gone')

    await fiber.dispose()
    expect(disposed).toEqual(['w1', 'list'])
    expect(b.ctx.slots.entries('main')).toHaveLength(0)
    expect(b.ctx.slots.entries('sidebar.panellist')).toHaveLength(0)
    expect(b.unmount).toHaveBeenCalledOnce()
  } finally { await b.ctx.fiber.dispose() }
})

it('rolls back the Remote contribution when the slot registration fails', async () => {
  const b = await fixture(true)
  try {
    await expect(mountClusterMonitor(b.ctx, REMOTE)).rejects.toThrow('slot failed')
    expect(b.unmount).toHaveBeenCalledOnce()
  } finally { await b.ctx.fiber.dispose() }
})
