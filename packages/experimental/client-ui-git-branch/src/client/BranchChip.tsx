/**
 * The Git branch chip on the New Session screen, after the workspace and preset controls. It reads the branch of the
 * Session's working directory when the Session changes, the menu opens, or the window regains focus, and renders
 * nothing outside a Git repository.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  IconBranchOutlineRegular, IconChevronDownOutlineRegular, IconWarningOutlineRegular, Menu, Toast, type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
// Type-only: pulls the ui-conversation SlotMap merge (the hero context row).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { GitBranchRepository, GitBranchStatus, GitSwitchRequest } from '@deepseek-ai/dsh-experimental-git-branch/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import css from './BranchChip.module.css'

/** A Remote answer, or the failure message. */
export type Loaded<T> = { ok: true; value: T } | { ok: false; message: string }

/** Registration-side business face for the branch chip. */
export interface BranchChipInjected {
  /** Read the branch state of a Session's working directory. */
  status: (sessionId: SessionId) => Promise<Loaded<GitBranchStatus>>
  /** Check out a listed branch in a Session's working directory. */
  switchBranch: (sessionId: SessionId, request: GitSwitchRequest) => Promise<Loaded<GitBranchRepository>>
}

/** Full component props. */
export type BranchChipProps =
  PropsRuntime<'conversation.hero.context'>
  & PropsLocale<'git.branch'>
  & InjectFace<BranchChipInjected>

/** Duration of a switch-failure banner. */
const FAILURE_HOLD_MS = 8000

const LOCAL = 'local:'
const REMOTE = 'remote:'

/**
 * Menu entries for a repository: local branches, then remote-tracking branches, then the truncation note.
 * @param status - the repository's branch state.
 * @param t - `git.branch` translator.
 * @returns entries whose ids carry a `local:` or `remote:` prefix.
 */
export function branchEntries(status: GitBranchRepository, t: BranchChipProps['t']): MenuEntry[] {
  const entries: MenuEntry[] = []
  if (status.local.length > 0) {
    entries.push({ type: 'label', id: 'local', text: t('local') })
    for (const name of status.local) entries.push({ id: LOCAL + name, label: name })
  }
  if (status.remote.length > 0) {
    if (entries.length > 0) entries.push({ type: 'separator', id: 'remote-separator' })
    entries.push({ type: 'label', id: 'remote', text: t('remote') })
    for (const name of status.remote) entries.push({ id: REMOTE + name, label: name })
  }
  if (entries.length === 0) entries.push({ id: 'none', label: t('noBranches'), disabled: true })
  if (status.truncated) entries.push({ id: 'truncated', label: t('truncated'), disabled: true })
  return entries
}

/**
 * Render the branch chip and its switch menu.
 * @param props - composed slot props.
 * @returns the chip, a disabled chip when Git cannot be read, or null outside a repository.
 */
export function BranchChip({ sessionId, status, switchBranch, t }: BranchChipProps) {
  const [state, setState] = useState<Loaded<GitBranchStatus> | null>(null)
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
    const remote = id.startsWith(REMOTE)
    const branch = id.slice(remote ? REMOTE.length : LOCAL.length)
    const mine = ++generation.current
    setBusy(true)
    const result = await switchBranch(sessionId, remote ? { branch, remote: true } : { branch })
    setBusy(false)
    if (result.ok) {
      if (mine === generation.current) setState(result)
      return
    }
    failureSeq.current += 1
    setFailure({ seq: failureSeq.current, text: t('switchFailed', { branch, reason: result.message }) })
    void load()
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
  const repository = state.value
  if (repository.kind === 'none') return null
  const label = repository.branch ?? t('detached', { commit: repository.commit })
  return (
    <>
      <Menu
        open={open}
        onClose={() => { setOpen(false) }}
        items={branchEntries(repository, t)}
        {...(repository.branch === null ? {} : { selectedId: LOCAL + repository.branch })}
        onSelect={(id) => { void choose(id) }}
        align="start"
        portal
        className={css.menuAnchor}
        anchor={(
          <button
            type="button"
            className={css.chip}
            aria-haspopup="menu"
            aria-expanded={open}
            title={`${t('hint')} · ${repository.root}`}
            disabled={busy}
            onClick={() => {
              if (!open) void load()
              setOpen(value => !value)
            }}
          >
            <IconBranchOutlineRegular className={css.icon} />
            <span className={css.label}>{label}</span>
            <IconChevronDownOutlineRegular className={css.chevron} />
          </button>
        )}
      />
      {toast}
    </>
  )
}
