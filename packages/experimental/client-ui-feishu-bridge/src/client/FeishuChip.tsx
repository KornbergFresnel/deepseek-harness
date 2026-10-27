/**
 * The Feishu chip in the Session header. It reads the Session's Feishu connection when the Session changes, the menu
 * opens, or the window regains focus, and connects the Session to a chosen chat or disconnects it from the menu.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  IconChevronDownOutlineRegular, IconLinkOutlineRegular, IconWarningOutlineRegular, Menu, Toast, type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
// Type-only: pulls the ui-conversation SlotMap merge (the Session header utilities).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { FeishuChatId, FeishuChatSummary, FeishuSessionStatus } from '@deepseek-ai/dsh-experimental-feishu-bridge/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import css from './FeishuChip.module.css'

/** A Remote answer, or the failure message. */
export type Loaded<T> = { ok: true; value: T } | { ok: false; message: string }

/** Registration-side business face for the Feishu chip. */
export interface FeishuChipInjected {
  /** Read a Session's Feishu connection and the chats it can connect to. */
  status: (sessionId: SessionId) => Promise<Loaded<FeishuSessionStatus>>
  /** Connect a Session to a listed chat. */
  connect: (sessionId: SessionId, chatId: FeishuChatId) => Promise<Loaded<FeishuSessionStatus>>
  /** Disconnect a Session from its chat. */
  disconnect: (sessionId: SessionId) => Promise<Loaded<FeishuSessionStatus>>
}

/** Full component props. */
export type FeishuChipProps =
  PropsRuntime<'conversation.session.header.utilities'>
  & PropsLocale<'feishu.bridge'>
  & InjectFace<FeishuChipInjected>

/** Duration of a failure banner. */
const FAILURE_HOLD_MS = 8000

const CHAT = 'chat:'
const DISCONNECT = 'disconnect'

/**
 * A chat's display name: the group name, or a generic label.
 * @param chat - the chat.
 * @param t - `feishu.bridge` translator.
 * @returns the label.
 */
export function chatLabel(chat: FeishuChatSummary, t: FeishuChipProps['t']): string {
  return chat.name ?? t(chat.chatType === 'p2p' ? 'direct' : 'unnamed')
}

/**
 * Menu entries: the chats, a placeholder without any, and the disconnect action while connected.
 * @param status - the Session's connection.
 * @param sessionId - the open Session.
 * @param t - `feishu.bridge` translator.
 * @returns entries whose chat ids carry a `chat:` prefix.
 */
export function chatEntries(status: FeishuSessionStatus, sessionId: SessionId, t: FeishuChipProps['t']): MenuEntry[] {
  const entries: MenuEntry[] = [{ type: 'label', id: 'chats', text: t('chats') }]
  for (const chat of status.chats) {
    const busy = chat.sessionId !== null && chat.sessionId !== sessionId
    entries.push({ id: CHAT + chat.chatId, label: busy ? `${chatLabel(chat, t)} · ${t('inUse')}` : chatLabel(chat, t) })
  }
  if (status.chats.length === 0) entries.push({ id: 'none', label: t('noChats'), disabled: true })
  if (status.chat !== null) {
    entries.push({ type: 'separator', id: 'actions' })
    entries.push({ id: DISCONNECT, label: t('disconnect'), danger: true })
  }
  return entries
}

/**
 * Render the Feishu chip and its chat menu.
 * @param props - composed slot props.
 * @returns the chip, or a disabled chip when the connection cannot be read.
 */
export function FeishuChip({ sessionId, status, connect, disconnect, t }: FeishuChipProps) {
  const [state, setState] = useState<Loaded<FeishuSessionStatus> | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<{ seq: number; text: string } | null>(null)
  const failureSeq = useRef(0)
  // Answers for an earlier Session, or overtaken by a newer read, are dropped.
  const generation = useRef(0)

  const load = useCallback(async () => {
    const mine = ++generation.current
    const next = await status(sessionId)
    if (mine === generation.current) setState(next)
  }, [sessionId, status])

  useEffect(() => {
    setState(null)
    void load()
    const onFocus = () => { void load() }
    window.addEventListener('focus', onFocus)
    return () => {
      generation.current += 1
      window.removeEventListener('focus', onFocus)
    }
  }, [load])

  const choose = async (id: string) => {
    setOpen(false)
    const mine = ++generation.current
    setBusy(true)
    const result = id === DISCONNECT
      ? await disconnect(sessionId)
      : await connect(sessionId, id.slice(CHAT.length) as FeishuChatId)
    setBusy(false)
    if (!result.ok) {
      failureSeq.current += 1
      setFailure({ seq: failureSeq.current, text: t('failed', { reason: result.message }) })
      void load()
    } else if (mine === generation.current) {
      setState(result)
    }
  }

  if (state === null) return null
  const toast = failure !== null && (
    <Toast
      key={failure.seq}
      text={failure.text}
      icon={<IconWarningOutlineRegular />}
      holdMs={FAILURE_HOLD_MS}
      anchor={document.querySelector<HTMLElement>('[data-composer-card]')}
      onDone={() => { setFailure(null) }}
    />
  )
  if (!state.ok) {
    return (
      <>
        <button type="button" className={css.chip} disabled title={state.message}>
          <IconWarningOutlineRegular className={css.icon} />
          <span className={css.label}>{t('unavailable')}</span>
        </button>
        {toast}
      </>
    )
  }
  const connection = state.value
  const bound = connection.chat
  return (
    <>
      <Menu
        open={open}
        onClose={() => { setOpen(false) }}
        items={chatEntries(connection, sessionId, t)}
        {...(bound === null ? {} : { selectedId: CHAT + bound.chatId })}
        onSelect={(id) => { void choose(id) }}
        align="end"
        portal
        className={css.menuAnchor}
        anchor={(
          <button
            type="button"
            className={bound === null ? css.chip : `${css.chip} ${css.connected}`}
            aria-haspopup="menu"
            aria-expanded={open}
            title={bound === null ? t('hint') : t('connected', { name: chatLabel(bound, t) })}
            disabled={busy}
            onClick={() => {
              if (!open) void load()
              setOpen(value => !value)
            }}
          >
            <IconLinkOutlineRegular className={css.icon} />
            <span className={css.label}>{bound === null ? t('connect') : chatLabel(bound, t)}</span>
            <IconChevronDownOutlineRegular className={css.chevron} />
          </button>
        )}
      />
      {toast}
    </>
  )
}
