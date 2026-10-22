// @vitest-environment jsdom
/** The branch chip shows the checked-out branch, lists branches to switch to, and reports failed switches. */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { GitBranchRepository, GitBranchStatus, GitSwitchRequest } from '@deepseek-ai/dsh-experimental-git-branch/types'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterEach, expect, it, vi } from 'vitest'
import { BranchChip, branchEntries, type BranchChipProps, type Loaded } from '../src/client/BranchChip.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(() => { cleanup() })
const t = makeTranslate(zh)

const repository: GitBranchRepository = {
  kind: 'repository', cwd: '/work/vllm-omni', root: '/work/vllm-omni', branch: 'main', commit: 'abc1234',
  local: ['main', 'feature'], remote: ['origin/release'], truncated: false,
}

function fixture(initial: Loaded<GitBranchStatus>, sessionId = 's1', first?: Promise<Loaded<GitBranchStatus>>) {
  const status = vi.fn(async (): Promise<Loaded<GitBranchStatus>> => initial)
  if (first !== undefined) status.mockReturnValueOnce(first)
  const switchBranch = vi.fn(async (_sessionId: SessionId, request: GitSwitchRequest): Promise<Loaded<GitBranchRepository>> => ({
    ok: true, value: { ...repository, branch: request.remote === true ? 'release' : request.branch },
  }))
  const props = { sessionId: SessionId(sessionId), status, switchBranch, t } as BranchChipProps
  const view = render(<BranchChip {...props} />)
  const rerender = (next: string) => { view.rerender(<BranchChip {...props} sessionId={SessionId(next)} />) }
  return { status, switchBranch, rerender, view }
}

it('renders nothing outside a repository', async () => {
  const { status, view } = fixture({ ok: true, value: { kind: 'none', cwd: '/tmp' } })
  await waitFor(() => { expect(status).toHaveBeenCalledWith('s1') })
  expect(view.container.innerHTML).toBe('')
})

it('shows the branch and switches to a local and a remote-tracking branch from the menu', async () => {
  const { status, switchBranch } = fixture({ ok: true, value: repository })
  const chip = await screen.findByRole('button', { name: /main/ })
  expect(chip.title).toBe('切换 Git 分支 · /work/vllm-omni')

  fireEvent.click(chip)
  await waitFor(() => { expect(status).toHaveBeenCalledTimes(2) })
  expect(screen.getByText('本地分支')).toBeTruthy()
  expect(screen.getByText('远程分支')).toBeTruthy()
  fireEvent.click(screen.getByRole('menuitem', { name: 'feature' }))
  await screen.findByRole('button', { name: /feature/ })
  expect(switchBranch).toHaveBeenCalledWith('s1', { branch: 'feature' })

  fireEvent.click(screen.getByRole('button', { name: /feature/ }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'origin/release' }))
  await screen.findByRole('button', { name: /release/ })
  expect(switchBranch).toHaveBeenLastCalledWith('s1', { branch: 'origin/release', remote: true })

  fireEvent.click(screen.getByRole('button', { name: /release/ }))
  fireEvent.click(screen.getByRole('button', { name: /release/ }))
  expect(screen.queryByRole('menuitem')).toBeNull()
})

it('reports a refused switch, rereads the branch, and clears the banner when it finishes', async () => {
  const { status, switchBranch } = fixture({ ok: true, value: repository })
  switchBranch.mockResolvedValueOnce({ ok: false, message: 'local changes would be overwritten' })
  fireEvent.click(await screen.findByRole('button', { name: /main/ }))
  vi.useFakeTimers()
  try {
    fireEvent.click(screen.getByRole('menuitem', { name: 'feature' }))
    await act(async () => { await Promise.resolve() })
    expect(screen.getByText('无法切换到 feature：local changes would be overwritten')).toBeTruthy()
    expect(status).toHaveBeenCalledTimes(3)
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000) })
    expect(screen.queryByText(/无法切换到/)).toBeNull()
  } finally { vi.useRealTimers() }
})

it('shows a detached HEAD, refreshes on window focus, and rereads for a new Session', async () => {
  const { status, rerender } = fixture({ ok: true, value: { ...repository, branch: null } })
  expect(await screen.findByRole('button', { name: /分离于 abc1234/ })).toBeTruthy()
  act(() => { window.dispatchEvent(new Event('focus')) })
  await waitFor(() => { expect(status).toHaveBeenCalledTimes(2) })
  rerender('s2')
  await waitFor(() => { expect(status).toHaveBeenLastCalledWith('s2') })
})

it('drops an answer that a newer read overtook', async () => {
  const late = Promise.withResolvers<Loaded<GitBranchStatus>>()
  const { rerender } = fixture({ ok: true, value: repository }, 's1', late.promise)
  rerender('s2')
  await screen.findByRole('button', { name: /main/ })
  await act(async () => { late.resolve({ ok: true, value: { ...repository, branch: 'stale' } }); await late.promise })
  expect(screen.queryByRole('button', { name: /stale/ })).toBeNull()
})

it('keeps a newer read over a switch answer and closes the menu on Escape', async () => {
  const pending = Promise.withResolvers<Loaded<GitBranchRepository>>()
  const { status, switchBranch } = fixture({ ok: true, value: repository })
  switchBranch.mockReturnValueOnce(pending.promise)
  fireEvent.click(await screen.findByRole('button', { name: /main/ }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'feature' }))
  act(() => { window.dispatchEvent(new Event('focus')) })
  await waitFor(() => { expect(status).toHaveBeenCalledTimes(3) })
  await act(async () => { pending.resolve({ ok: true, value: { ...repository, branch: 'feature' } }); await pending.promise })
  expect(screen.getByRole('button', { name: /main/ })).toBeTruthy()

  fireEvent.click(screen.getByRole('button', { name: /main/ }))
  expect(screen.getAllByRole('menuitem')).toHaveLength(3)
  fireEvent.keyDown(screen.getByRole('button', { name: /main/ }), { key: 'Escape' })
  await waitFor(() => { expect(screen.queryByRole('menuitem')).toBeNull() })
})

it('disables the chip with the reason when Git cannot be read', async () => {
  fixture({ ok: false, message: 'git: command not found' })
  const chip = await screen.findByRole('button', { name: /无法读取分支/ })
  expect((chip as HTMLButtonElement).disabled).toBe(true)
  expect(chip.title).toBe('git: command not found')
})

it('lists a placeholder without branches and notes truncation', () => {
  expect(branchEntries({ ...repository, local: [], remote: [], truncated: true }, t)).toEqual([
    { id: 'none', label: '没有可切换的分支', disabled: true },
    { id: 'truncated', label: '只列出最近提交的分支', disabled: true },
  ])
  expect(branchEntries({ ...repository, local: [] }, t).map(entry => entry.id)).toEqual(['remote', 'remote:origin/release'])
})
