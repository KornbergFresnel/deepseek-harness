// @vitest-environment jsdom
/** The Feishu chip shows the connected chat, connects the Session to a chosen chat, and reports failures. */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { FeishuChatId, FeishuChatSummary, FeishuSessionStatus } from '@deepseek-ai/dsh-experimental-feishu-bridge/types'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterEach, expect, it, vi } from 'vitest'
import { chatEntries, FeishuChip, type FeishuChipProps, type Loaded } from '../src/client/FeishuChip.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(() => { cleanup() })
const t = makeTranslate(zh)

const team: FeishuChatSummary = { chatId: 'oc_team' as FeishuChatId, chatType: 'group', name: 'Research', sessionId: null }
const direct: FeishuChatSummary = { chatId: 'oc_dm' as FeishuChatId, chatType: 'p2p', name: null, sessionId: SessionId('other') }
const unbound: FeishuSessionStatus = { chat: null, chats: [team, direct] }

function fixture(initial: Loaded<FeishuSessionStatus>, sessionId = 's1', first?: Promise<Loaded<FeishuSessionStatus>>) {
  const status = vi.fn(async (): Promise<Loaded<FeishuSessionStatus>> => initial)
  if (first !== undefined) status.mockReturnValueOnce(first)
  const connect = vi.fn(async (session: SessionId, chatId: FeishuChatId): Promise<Loaded<FeishuSessionStatus>> => {
    const chat = { ...[team, direct].find(item => item.chatId === chatId)!, sessionId: session }
    return { ok: true, value: { chat, chats: [chat] } }
  })
  const disconnect = vi.fn(async (): Promise<Loaded<FeishuSessionStatus>> => ({ ok: true, value: unbound }))
  const props = { sessionId: SessionId(sessionId), status, connect, disconnect, t } as FeishuChipProps
  const view = render(<FeishuChip {...props} />)
  const rerender = (next: string) => { view.rerender(<FeishuChip {...props} sessionId={SessionId(next)} />) }
  return { status, connect, disconnect, rerender, view }
}

it('reports a refused connection, rereads the state, and clears the banner when it finishes', async () => {
  const { status, connect } = fixture({ ok: true, value: unbound })
  connect.mockResolvedValueOnce({ ok: false, message: 'chat is not available' })
  fireEvent.click(await screen.findByRole('button', { name: /连接飞书/ }))
  vi.useFakeTimers()
  try {
    fireEvent.click(screen.getByRole('menuitem', { name: 'Research' }))
    await act(async () => { await Promise.resolve() })
    expect(screen.getByText('飞书操作失败：chat is not available')).toBeTruthy()
    expect(status).toHaveBeenCalledTimes(3)
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000) })
    expect(screen.queryByText(/飞书操作失败/)).toBeNull()
  } finally { vi.useRealTimers() }
})

it('offers the chats, connects the Session to one, and disconnects it', async () => {
  const { status, connect, disconnect } = fixture({ ok: true, value: unbound })
  const chip = await screen.findByRole('button', { name: /连接飞书/ })
  expect(chip.title).toBe('把这个会话连接到飞书聊天')

  fireEvent.click(chip)
  await waitFor(() => { expect(status).toHaveBeenCalledTimes(2) })
  expect(screen.getByText('飞书聊天')).toBeTruthy()
  expect(screen.getByRole('menuitem', { name: '私聊 · 正在使用其他会话' })).toBeTruthy()
  fireEvent.click(screen.getByRole('menuitem', { name: 'Research' }))
  const connected = await screen.findByRole('button', { name: /Research/ })
  expect(connect).toHaveBeenCalledWith('s1', 'oc_team')
  expect(connected.title).toBe('已连接飞书聊天：Research')

  fireEvent.click(connected)
  fireEvent.click(screen.getByRole('menuitem', { name: '断开飞书' }))
  await screen.findByRole('button', { name: /连接飞书/ })
  expect(disconnect).toHaveBeenCalledWith('s1')
})

it('refreshes on window focus, rereads for a new Session, and drops an overtaken answer', async () => {
  const late = Promise.withResolvers<Loaded<FeishuSessionStatus>>()
  const { status, rerender } = fixture({ ok: true, value: unbound }, 's1', late.promise)
  rerender('s2')
  await screen.findByRole('button', { name: /连接飞书/ })
  await act(async () => { late.resolve({ ok: true, value: { chat: team, chats: [team] } }); await late.promise })
  expect(screen.queryByRole('button', { name: /Research/ })).toBeNull()
  act(() => { window.dispatchEvent(new Event('focus')) })
  await waitFor(() => { expect(status).toHaveBeenLastCalledWith('s2') })
  expect(status).toHaveBeenCalledTimes(3)
})

it('keeps a newer read over a connection answer and closes the menu on a second click or Escape', async () => {
  const pending = Promise.withResolvers<Loaded<FeishuSessionStatus>>()
  const { status, connect } = fixture({ ok: true, value: unbound })
  connect.mockReturnValueOnce(pending.promise)
  fireEvent.click(await screen.findByRole('button', { name: /连接飞书/ }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Research' }))
  act(() => { window.dispatchEvent(new Event('focus')) })
  await waitFor(() => { expect(status).toHaveBeenCalledTimes(3) })
  await act(async () => { pending.resolve({ ok: true, value: { chat: team, chats: [team] } }); await pending.promise })
  expect(screen.getByRole('button', { name: /连接飞书/ })).toBeTruthy()

  fireEvent.click(screen.getByRole('button', { name: /连接飞书/ }))
  fireEvent.click(screen.getByRole('button', { name: /连接飞书/ }))
  expect(screen.queryByRole('menuitem')).toBeNull()

  fireEvent.click(screen.getByRole('button', { name: /连接飞书/ }))
  expect(screen.getAllByRole('menuitem')).toHaveLength(2)
  fireEvent.keyDown(screen.getByRole('button', { name: /连接飞书/ }), { key: 'Escape' })
  await waitFor(() => { expect(screen.queryByRole('menuitem')).toBeNull() })
})

it('disables the chip with the reason when the connection cannot be read', async () => {
  fixture({ ok: false, message: 'feishuBridge is not mounted' })
  const chip = await screen.findByRole('button', { name: /飞书不可用/ })
  expect((chip as HTMLButtonElement).disabled).toBe(true)
  expect(chip.title).toBe('feishuBridge is not mounted')
})

it('lists a placeholder without chats and names unnamed groups', () => {
  expect(chatEntries({ chat: null, chats: [] }, SessionId('s1'), t)).toEqual([
    { type: 'label', id: 'chats', text: '飞书聊天' },
    { id: 'none', label: '先在飞书里给机器人发一条消息', disabled: true },
  ])
  const unnamed = { ...team, name: null, sessionId: SessionId('s1') }
  expect(chatEntries({ chat: unnamed, chats: [unnamed] }, SessionId('s1'), t)).toEqual([
    { type: 'label', id: 'chats', text: '飞书聊天' },
    { id: 'chat:oc_team', label: '未命名群聊' },
    { type: 'separator', id: 'actions' },
    { id: 'disconnect', label: '断开飞书', danger: true },
  ])
})
