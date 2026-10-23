// @vitest-environment jsdom
/** The Session jobs tab and guide card list only the jobs of the Session on screen and open a job's detail. */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ClusterJobDetail, ClusterWatchId, ClusterWatchRow } from '@deepseek-ai/dsh-experimental-cluster-monitor/types'
import { afterEach, expect, it, vi } from 'vitest'
import {
  SessionJobsGuide, SessionJobsTab, SessionJobsTitle, sessionRows, type SessionJobsGuideProps, type SessionJobsTabProps,
} from '../src/client/SessionJobs.tsx'
import type { Mirror } from '../src/client/source.ts'
import { zh } from '../src/client/locales.ts'

afterEach(() => { cleanup() })
const t = makeTranslate(zh)
const session = brandString<SessionId>('s1')
const other = brandString<SessionId>('s2')
const row = (id: string, extra: Partial<ClusterWatchRow> = {}): ClusterWatchRow => ({
  id: brandString<ClusterWatchId>(id), name: `job-${id}`, sessionId: session, origin: 'created', phase: 'running', rawState: 'Running',
  watchedAt: 't', latest: {}, ...extra,
})
const rows = [
  row('a', { workspace: 'ws', step: 120, latest: { loss: 0.123456, reward: 3, extra: 1 } }),
  row('b', { phase: 'pending', error: 'describe failed' }),
  row('c', { phase: 'succeeded' }),
  row('d', { phase: 'pending' }),
  row('x', { sessionId: other }),
  row('y', { sessionId: undefined }),
]

function actions() {
  const openJob = vi.fn((watchId: ClusterWatchId) => ({
    store: createSnapshotStore<Mirror<ClusterJobDetail>>({
      value: { ...rows.find(item => item.id === watchId)!, series: [], logTail: '', describe: null }, connected: true, error: null,
    }),
    dispose: vi.fn(async () => {}),
  }))
  return { openJob, refresh: vi.fn(async () => null as string | null), unwatch: vi.fn(async () => null as string | null) }
}

const tabInfo = (openTab = vi.fn()) => () => ({ tab: { title: 'Session jobs', actions: { openTab } } })

it('selects the rows of one Session', () => {
  expect(sessionRows(null, session)).toBeNull()
  expect(sessionRows(rows, session)?.map(item => item.name)).toEqual(['job-a', 'job-b', 'job-c', 'job-d'])
})

it('lists the Session jobs, opens one job, and returns to the list', () => {
  const store = createSnapshotStore<Mirror<ClusterWatchRow[]>>({ value: null, connected: false, error: null })
  const act$ = actions()
  const props = { sessionId: session, useWatchList: bindSnapshotSelector(store), ...act$, t } as SessionJobsTabProps
  render(<SessionJobsTab {...props} />)
  expect(screen.getByText(zh['list.loading'])).toBeTruthy()
  act(() => { store.set({ value: [rows[4]!], connected: false, error: 'lost' }) })
  expect(screen.getByText(zh['session.empty'])).toBeTruthy()
  expect(screen.getByText(zh['list.disconnected'])).toBeTruthy()
  act(() => { store.set({ value: rows, connected: true, error: null }) })
  expect(screen.getByText('4 个作业 · 1 个运行中 · 2 个排队')).toBeTruthy()
  const list = screen.getByRole('list', { name: zh['session.aria'] })
  expect(within(list).getAllByRole('button')).toHaveLength(4)
  expect(screen.getByText('ws · 第 120 步 · loss 0.1235 · reward 3')).toBeTruthy()
  expect(screen.getByText('⚠')).toBeTruthy()
  fireEvent.click(screen.getByText('job-a'))
  expect(act$.openJob).toHaveBeenCalledWith('a')
  expect(screen.getByRole('heading', { name: 'job-a' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: zh['session.back'] }))
  expect(screen.getByRole('list', { name: zh['session.aria'] })).toBeTruthy()
  fireEvent.click(screen.getByText('job-b'))
  fireEvent.click(screen.getByRole('button', { name: zh['detail.unwatch'] }))
  fireEvent.click(screen.getByRole('button', { name: zh['detail.unwatchConfirm'] }))
  return vi.waitFor(() => { expect(screen.getByRole('list', { name: zh['session.aria'] })).toBeTruthy() })
})

it('summarizes the Session jobs on the guide card and opens the tab', () => {
  const store = createSnapshotStore<Mirror<ClusterWatchRow[]>>({ value: [], connected: true, error: null })
  const openTab = vi.fn()
  const props = {
    sessionId: session, entryId: 'jobs', kind: 'cluster-session-jobs', title: '本会话作业', useTabInfo: tabInfo(openTab),
    useWatchList: bindSnapshotSelector(store), ...actions(), t,
  } as SessionJobsGuideProps
  render(<SessionJobsGuide {...props} />)
  expect(screen.getByText(zh['session.guideDescription'])).toBeTruthy()
  expect(screen.queryByRole('list')).toBeNull()
  act(() => { store.set({ value: rows, connected: true, error: null }) })
  expect(screen.getByText('4 个作业 · 1 个运行中 · 2 个排队')).toBeTruthy()
  expect(within(screen.getByRole('list')).getAllByRole('button').map(button => button.textContent)).toEqual([
    expect.stringContaining('job-a'), expect.stringContaining('job-b'), expect.stringContaining('job-c'), '还有 1 个作业',
  ])
  fireEvent.click(screen.getByText('job-b'))
  fireEvent.click(screen.getByText('还有 1 个作业'))
  fireEvent.click(screen.getByText('本会话作业'))
  expect(openTab).toHaveBeenCalledTimes(3)
  expect(openTab).toHaveBeenCalledWith('cluster-session-jobs', { replaceTab: true })
  act(() => { store.set({ value: null, connected: false, error: null }) })
  expect(screen.getByText(zh['session.guideDescription'])).toBeTruthy()
})

it('titles the tab with its glyph', () => {
  const props = { useTabInfo: tabInfo() } as Parameters<typeof SessionJobsTitle>[0]
  render(<span data-testid="title"><SessionJobsTitle {...props} /></span>)
  expect(screen.getByTestId('title').textContent).toBe('Session jobs')
})
