// @vitest-environment jsdom
/** The Job configurations page lists saved configurations, shows one, and creates, edits, and deletes them. */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ScoConfigOverview } from '@deepseek-ai/dsh-experimental-sco-submit/types'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { afterEach, expect, it, vi } from 'vitest'
import { PresetsIcon } from '../src/client/PresetsIcon.tsx'
import { SavedConfigsPage, type SavedConfigsPageProps } from '../src/client/SavedConfigsPage.tsx'
import type { Mirror } from '../src/client/source.ts'
import { workloadZh as zh } from '../src/client/workload-locales.ts'

afterEach(() => { cleanup() })
const t = makeTranslate(zh)

const overview: ScoConfigOverview = {
  configured: {}, saved: {}, outputMountPath: '/o', sources: [], templates: [],
  configs: [
    { name: 'dev-a100', config: { kind: 'devmachine', spec: {}, createdAt: 't', updatedAt: 'not a time' } },
    {
      name: 'wbt-8gpu',
      config: {
        kind: 'job', description: 'eight GPUs', spec: { image: 'img:8', gpuCount: 8 },
        createdAt: '2026-10-20T00:00:00.000Z', updatedAt: '2026-10-21T00:00:00.000Z', lastUsedAt: '2026-10-22T00:00:00.000Z',
      },
    },
  ],
}

function page(initial: Mirror<ScoConfigOverview>) {
  const store = createSnapshotStore(initial)
  const saveConfig = vi.fn(async () => null as string | null)
  const deleteConfig = vi.fn(async () => null as string | null)
  const props = { useOverview: bindSnapshotSelector(store), saveConfig, deleteConfig, t } as SavedConfigsPageProps
  return { ...render(<SavedConfigsPage {...props} />), store, saveConfig, deleteConfig }
}

const list = () => screen.getByRole('list', { name: zh['presets.aria'] })

it('shows loading, disconnected, and empty states', () => {
  const b = page({ value: null, connected: false, error: null })
  expect(screen.getByText(zh['presets.loading'])).toBeTruthy()
  expect(screen.getByText(zh['presets.select'])).toBeTruthy()
  act(() => { b.store.set({ value: { ...overview, configs: [] }, connected: false, error: 'lost' }) })
  expect(screen.getByText(zh['presets.empty'])).toBeTruthy()
  expect(screen.getByText(zh['presets.disconnected'])).toBeTruthy()
})

it('shows the first configuration, then the selected one, with its settings and use times', () => {
  page({ value: overview, connected: true, error: null })
  expect(within(list()).getAllByRole('button').map(button => button.getAttribute('aria-current'))).toEqual(['true', 'false'])
  expect(screen.getByRole('heading', { name: 'dev-a100' })).toBeTruthy()
  expect(screen.getByText(zh['presets.emptySpec'])).toBeTruthy()
  expect(screen.getAllByText(/更新于 not a time/)).toHaveLength(2)
  expect(screen.getByText(/还没有加载过/)).toBeTruthy()
  fireEvent.click(within(list()).getByText('wbt-8gpu'))
  expect(screen.getByRole('heading', { name: 'wbt-8gpu' })).toBeTruthy()
  expect(screen.getAllByText('eight GPUs')).toHaveLength(2)
  expect(screen.getByText(/上次加载于/)).toBeTruthy()
  expect(screen.getByText('img:8')).toBeTruthy()
  expect(screen.getByText(zh['presets.raw'])).toBeTruthy()
})

it('edits a configuration under its locked name and returns to its detail', async () => {
  const b = page({ value: overview, connected: true, error: null })
  fireEvent.click(within(list()).getByText('wbt-8gpu'))
  fireEvent.click(screen.getByRole('button', { name: zh['presets.edit'] }))
  expect(screen.getByRole('heading', { name: '编辑配置 wbt-8gpu' })).toBeTruthy()
  expect(screen.getByLabelText<HTMLInputElement>(zh['save.name']).disabled).toBe(true)
  fireEvent.change(screen.getByLabelText(zh['field.gpuCount']), { target: { value: '4' } })
  b.saveConfig.mockResolvedValueOnce('rejected')
  fireEvent.click(screen.getByRole('button', { name: zh['form.save'] }))
  await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('操作失败：rejected') })
  fireEvent.click(screen.getByRole('button', { name: zh['form.save'] }))
  await waitFor(() => { expect(screen.getByRole('heading', { name: 'wbt-8gpu' })).toBeTruthy() })
  expect(b.saveConfig).toHaveBeenLastCalledWith({ name: 'wbt-8gpu', kind: 'job', spec: { image: 'img:8', gpuCount: 4 }, replace: true, description: 'eight GPUs' })
  fireEvent.click(screen.getByRole('button', { name: zh['presets.edit'] }))
  fireEvent.change(screen.getByLabelText(zh['save.description']), { target: { value: '' } })
  fireEvent.click(screen.getByRole('button', { name: zh['form.cancel'] }))
  expect(screen.getByRole('heading', { name: 'wbt-8gpu' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: zh['presets.edit'] }))
  fireEvent.change(screen.getByLabelText(zh['save.description']), { target: { value: '' } })
  fireEvent.click(screen.getByRole('button', { name: zh['form.save'] }))
  await waitFor(() => { expect(b.saveConfig).toHaveBeenLastCalledWith({ name: 'wbt-8gpu', kind: 'job', spec: { image: 'img:8', gpuCount: 8 }, replace: true }) })
  fireEvent.click(within(list()).getByText('dev-a100'))
  fireEvent.click(screen.getByRole('button', { name: zh['presets.edit'] }))
  expect(screen.getByLabelText<HTMLInputElement>(zh['save.description']).value).toBe('')
})

it('creates job and development machine configurations', async () => {
  const b = page({ value: overview, connected: true, error: null })
  fireEvent.click(screen.getByRole('button', { name: '新建开发机配置' }))
  expect(screen.getByRole('heading', { name: '新建开发机配置' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: zh['form.cancel'] }))
  expect(screen.getByRole('heading', { name: 'dev-a100' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '新建SSP 训练任务配置' }))
  fireEvent.change(screen.getByLabelText(zh['save.name']), { target: { value: 'new-job' } })
  fireEvent.change(screen.getByLabelText(zh['save.description']), { target: { value: 'fresh' } })
  fireEvent.change(screen.getByLabelText(zh['field.image']), { target: { value: 'img' } })
  b.saveConfig.mockResolvedValueOnce('exists')
  fireEvent.click(screen.getByRole('button', { name: zh['form.save'] }))
  await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('操作失败：exists') })
  fireEvent.change(screen.getByLabelText(zh['save.description']), { target: { value: '' } })
  fireEvent.click(screen.getByRole('button', { name: zh['form.save'] }))
  await waitFor(() => { expect(b.saveConfig).toHaveBeenLastCalledWith({ name: 'new-job', kind: 'job', spec: { image: 'img' } }) })
  expect(b.saveConfig).toHaveBeenCalledWith({ name: 'new-job', kind: 'job', spec: { image: 'img' }, description: 'fresh' })
  await waitFor(() => { expect(screen.getByText(zh['presets.select'])).toBeTruthy() })
})

it('deletes a configuration after confirmation and reports a failure', async () => {
  const b = page({ value: overview, connected: true, error: null })
  fireEvent.click(screen.getByRole('button', { name: zh['presets.delete'] }))
  b.deleteConfig.mockResolvedValueOnce('in use')
  fireEvent.click(screen.getByRole('button', { name: zh['presets.deleteConfirm'] }))
  await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('操作失败：in use') })
  fireEvent.click(screen.getByRole('button', { name: zh['presets.deleteConfirm'] }))
  await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
  expect(b.deleteConfig).toHaveBeenCalledWith('dev-a100')
})

it('renders the sidebar glyph at the requested size', () => {
  const { container } = render(<PresetsIcon {...{ size: 18 } as PropsRuntime<'sidebar.panellist'>} />)
  expect(container.querySelector('svg')?.getAttribute('width')).toBe('18')
})
