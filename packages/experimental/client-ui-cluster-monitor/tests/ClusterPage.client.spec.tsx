// @vitest-environment jsdom
/** The page lists watched jobs, adds and removes watches, and renders the selected job's curves, logs, and failures. */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ClusterJobDetail, ClusterWatchId, ClusterWatchRow } from '@deepseek-ai/dsh-experimental-cluster-monitor/types'
import { afterEach, expect, it, vi } from 'vitest'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { ClusterIcon } from '../src/client/ClusterIcon.tsx'
import { ClusterPage, MetricChart, type ClusterPageProps } from '../src/client/ClusterPage.tsx'
import type { Mirror, MirrorHandle } from '../src/client/source.ts'
import { zh } from '../src/client/locales.ts'

afterEach(() => { cleanup() })
const t = makeTranslate(zh)
const first = brandString<ClusterWatchId>('w1'), second = brandString<ClusterWatchId>('w2')
const rows: ClusterWatchRow[] = [
  { id: first, name: 'job-wbt', workspace: 'team-a', origin: 'created', phase: 'running', rawState: 'Running', watchedAt: 't', step: 20, latest: { loss: 0.25 } },
  { id: second, name: 'job-old', origin: 'manual', phase: 'failed', rawState: 'Failed', watchedAt: 't', error: 'describe failed', latest: {} },
]
const detail = (row: ClusterWatchRow, extra: Partial<ClusterJobDetail> = {}): ClusterJobDetail => ({
  ...row, series: [], logTail: '', describe: null, ...extra,
})

function fixture(initial: Mirror<ClusterWatchRow[]>) {
  const list = createSnapshotStore(initial)
  const jobs = new Map<ClusterWatchId, MirrorHandle<ClusterJobDetail>>()
  const openJob = vi.fn((watchId: ClusterWatchId) => {
    const store = createSnapshotStore<Mirror<ClusterJobDetail>>({ value: null, connected: false, error: null })
    const handle = { store, dispose: vi.fn(async () => {}) }
    jobs.set(watchId, handle)
    return handle
  })
  const watch = vi.fn(async () => null as string | null)
  const unwatch = vi.fn(async () => null as string | null)
  const refresh = vi.fn(async () => null as string | null)
  const props = { useWatchList: bindSnapshotSelector(list), openJob, watch, unwatch, refresh, t } as ClusterPageProps
  return { ...render(<ClusterPage {...props} />), list, jobs, openJob, watch, unwatch, refresh }
}

it('shows loading, empty, and disconnected list states', () => {
  const b = fixture({ value: null, connected: false, error: null })
  expect(screen.getAllByText(zh['list.loading'])).toHaveLength(1)
  expect(screen.getByText(zh['detail.empty'])).toBeTruthy()
  act(() => { b.list.set({ value: [], connected: false, error: 'lost' }) })
  expect(screen.getByText(zh['list.empty'])).toBeTruthy()
  expect(screen.getByText(zh['list.disconnected'])).toBeTruthy()
})

it('adds a trimmed watch, keeps the name on failure, and ignores a blank name', async () => {
  const b = fixture({ value: [], connected: true, error: null })
  const name = screen.getByLabelText<HTMLInputElement>(zh['watch.name'])
  const form = name.closest('form')!
  fireEvent.submit(form)
  expect(b.watch).not.toHaveBeenCalled()
  fireEvent.change(name, { target: { value: ' job-wbt ' } })
  fireEvent.change(screen.getByLabelText(zh['watch.workspace']), { target: { value: ' team-a ' } })
  b.watch.mockResolvedValueOnce('job not found')
  fireEvent.submit(form)
  await screen.findByText('操作失败：job not found')
  expect(b.watch).toHaveBeenLastCalledWith({ name: 'job-wbt', workspace: 'team-a' })
  expect(name.value).toBe(' job-wbt ')
  fireEvent.change(screen.getByLabelText(zh['watch.workspace']), { target: { value: '' } })
  fireEvent.submit(form)
  await waitFor(() => { expect(name.value).toBe('') })
  expect(b.watch).toHaveBeenLastCalledWith({ name: 'job-wbt' })
  expect(screen.queryByRole('alert')).toBeNull()
})

it('selects the first job, switches jobs, and renders facts, curves, logs, and the job object', async () => {
  const b = fixture({ value: rows, connected: true, error: null })
  const list = screen.getByRole('list', { name: zh['list.aria'] })
  expect(within(list).getByText('team-a · 第 20 步')).toBeTruthy()
  expect(within(list).getByText('· ⚠')).toBeTruthy()
  expect(b.openJob).toHaveBeenLastCalledWith(first)
  expect(screen.getAllByText(zh['list.loading'])).toHaveLength(1)
  act(() => {
    b.jobs.get(first)!.store.set({ connected: true, error: null, value: detail(rows[0]!, {
      startedAt: '2026-10-20T01:00:00Z', checkedAt: 'not a time',
      series: [{ name: 'loss', points: [{ step: 10, value: 0.5 }, { step: 20, value: 0.25 }] }],
      logTail: 'step 20\n', describe: '{"state":"Running"}',
    }) })
  })
  const section = screen.getByRole('region', { name: 'job-wbt' })
  expect(within(section).getByText('Running')).toBeTruthy()
  expect(within(section).getByText(zh['origin.created'])).toBeTruthy()
  expect(within(section).getByText('not a time')).toBeTruthy()
  expect(within(section).getByText(new Date('2026-10-20T01:00:00Z').toLocaleString())).toBeTruthy()
  expect(within(section).getByRole('img', { name: 'loss' })).toBeTruthy()
  expect(within(section).getByText('最新 0.25')).toBeTruthy()
  expect(within(section).getAllByText('step 20')).toHaveLength(1)
  expect(within(section).getByText('{"state":"Running"}')).toBeTruthy()

  fireEvent.click(within(list).getByText('job-old'))
  expect(b.jobs.get(first)!.dispose).toHaveBeenCalledOnce()
  act(() => {
    b.jobs.get(second)!.store.set({ connected: true, error: null, value: detail(rows[1]!, { rawState: null, logError: 'logs unavailable' }) })
  })
  expect(screen.getByText('sco 调用失败：describe failed')).toBeTruthy()
  expect(screen.getByText('读取日志失败：logs unavailable')).toBeTruthy()
  expect(screen.getByText(zh['metrics.empty'])).toBeTruthy()
  expect(screen.getByText(zh['logs.empty'])).toBeTruthy()
  expect(screen.getByText(zh['origin.manual'])).toBeTruthy()
  expect(screen.getAllByText('—').length).toBeGreaterThan(0)
})

it('refreshes, confirms before unwatching, and returns to the first job after removal', async () => {
  const b = fixture({ value: rows, connected: true, error: null })
  fireEvent.click(within(screen.getByRole('list')).getByText('job-old'))
  act(() => { b.jobs.get(second)!.store.set({ connected: true, error: null, value: detail(rows[1]!) }) })
  b.refresh.mockResolvedValueOnce('sco unavailable')
  fireEvent.click(screen.getByRole('button', { name: zh['detail.refresh'] }))
  await screen.findByText('操作失败：sco unavailable')
  fireEvent.click(screen.getByRole('button', { name: zh['detail.refresh'] }))
  await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
  expect(b.refresh).toHaveBeenCalledWith(second)
  fireEvent.click(screen.getByRole('button', { name: zh['detail.unwatch'] }))
  expect(b.unwatch).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: zh['detail.unwatchConfirm'] }))
  await waitFor(() => { expect(b.unwatch).toHaveBeenCalledWith(second) })
  act(() => { b.list.set({ value: [rows[0]!], connected: true, error: null }) })
  await waitFor(() => { expect(b.openJob).toHaveBeenLastCalledWith(first) })
})

it('renders nothing for a series without points, and a decorative sidebar glyph', () => {
  const { container } = render(<MetricChart series={{ name: 'loss', points: [] }} t={t} />)
  expect(container.innerHTML).toBe('')
  const icon = render(<ClusterIcon {...{ size: 20 } as PropsRuntime<'sidebar.panellist'>} />)
  expect(icon.container.querySelector('svg')).toBeTruthy()
})
