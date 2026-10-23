/** The right-sidebar Session jobs tab and its guide card: watched jobs whose Session is the one on screen. */
import { useState, type ReactNode } from 'react'
import { IconChecklistOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { ClusterWatchId, ClusterWatchRow } from '@deepseek-ai/dsh-experimental-cluster-monitor/types'
import { JobDetail, PhaseTag, type ClusterPageInjected } from './ClusterPage.tsx'
import type { Mirror } from './source.ts'
import css from './SessionJobs.module.css'

/** Host mirror and job actions shared by the Session jobs tab and its guide card. */
export interface SessionJobsInjected extends Pick<ClusterPageInjected, 'openJob' | 'refresh' | 'unwatch'> {
  readonly hooks: { readonly watchList: HostObservable<Mirror<ClusterWatchRow[]>> }
}

/** Tab body props derived from the tab seat, the injected face, and the plugin dictionary. */
export type SessionJobsTabProps = PropsRuntime<'sidebar.right.pane.tab'> & InjectFace<SessionJobsInjected> & PropsLocale<'cluster.monitor'>

/** Guide card props derived from the guide entry seat, the injected face, and the plugin dictionary. */
export type SessionJobsGuideProps =
  & PropsRuntime<'sidebar.right.tab.guide.entry'>
  & InjectFace<SessionJobsInjected>
  & PropsLocale<'cluster.monitor'>

type Translate = SessionJobsTabProps['t']

/** Rows the guide card lists before it summarizes the rest. */
const GUIDE_ROWS = 3

/**
 * Select the watched jobs of one Session, newest first as the Host lists them.
 * @param rows - every watched job, or null before the first snapshot.
 * @param sessionId - Session on screen.
 * @returns the Session's rows, or null before the first snapshot.
 */
export function sessionRows(rows: readonly ClusterWatchRow[] | null, sessionId: string): ClusterWatchRow[] | null {
  return rows === null ? null : rows.filter(row => row.sessionId === sessionId)
}

function RowMeta({ row, t }: { row: ClusterWatchRow; t: Translate }) {
  const metrics = Object.entries(row.latest).slice(0, 2).map(([name, value]) => `${name} ${Number(value.toPrecision(4))}`)
  const parts = [
    ...row.workspace === undefined ? [] : [row.workspace],
    ...row.step === undefined ? [] : [t('list.step', { step: row.step })],
    ...metrics,
    ...row.error === undefined ? [] : ['⚠'],
  ]
  return <span className={css.meta}>{parts.join(' · ')}</span>
}

function Summary({ rows, t }: { rows: readonly ClusterWatchRow[]; t: Translate }) {
  return (
    <span className={css.summary}>
      {t('session.summary', {
        total: rows.length,
        running: rows.filter(row => row.phase === 'running').length,
        pending: rows.filter(row => row.phase === 'pending').length,
      })}
    </span>
  )
}

/**
 * Render the Session's jobs as a list, or one job's detail after a row is picked.
 * @param props - Session identity, watch list mirror, job actions, and dictionary.
 * @returns the tab body.
 */
export function SessionJobsTab(props: SessionJobsTabProps) {
  const { sessionId, useWatchList, t } = props
  const list = useWatchList(snapshot => snapshot)
  const rows = sessionRows(list.value, sessionId)
  const [selected, setSelected] = useState<ClusterWatchId | null>(null)
  const current = rows?.find(row => row.id === selected)
  let body: ReactNode
  if (current !== undefined) {
    body = (
      <>
        <button type="button" className={css.back} onClick={() => { setSelected(null) }}>{t('session.back')}</button>
        <div className={css.detail}>
          <JobDetail key={current.id} props={props} watchId={current.id} onRemoved={() => { setSelected(null) }} />
        </div>
      </>
    )
  } else if (rows === null) {
    body = <p className={css.muted}>{t('list.loading')}</p>
  } else if (rows.length === 0) {
    body = <p className={css.muted}>{t('session.empty')}</p>
  } else {
    body = (
      <>
        <Summary rows={rows} t={t} />
        <ul className={css.rows} aria-label={t('session.aria')}>
          {rows.map(row => (
            <li key={row.id}>
              <button type="button" className={css.row} onClick={() => { setSelected(row.id) }}>
                <span className={css.rowTop}>
                  <span className={css.name}>{row.name}</span>
                  <PhaseTag phase={row.phase} t={t} />
                </span>
                <RowMeta row={row} t={t} />
              </button>
            </li>
          ))}
        </ul>
      </>
    )
  }
  return (
    <div className={css.tab}>
      {!list.connected && list.error !== null && <p className={css.muted}>{t('list.disconnected')}</p>}
      {body}
    </div>
  )
}

/**
 * Render the guide card: the Session's job activity at a glance, opening the full tab on click.
 * @param props - Session identity, tab information, watch list mirror, and dictionary.
 * @returns the guide card.
 */
export function SessionJobsGuide({ sessionId, kind, title, useTabInfo, useWatchList, t }: SessionJobsGuideProps) {
  const { tab } = useTabInfo()
  const rows = sessionRows(useWatchList(snapshot => snapshot.value), sessionId) ?? []
  const open = () => { tab.actions.openTab(kind, { replaceTab: true }) }
  return (
    <div className={css.card} data-cluster-session-jobs>
      <button type="button" className={css.cardHeading} onClick={open}>
        <IconChecklistOutlineRegular size={22} />
        <span className={css.cardText}>
          <span className={css.cardTitle}>{title}</span>
          {rows.length === 0
            ? <span className={css.muted}>{t('session.guideDescription')}</span>
            : <Summary rows={rows} t={t} />}
        </span>
      </button>
      {rows.length > 0 && (
        <ul className={css.rows} aria-label={t('session.aria')}>
          {rows.slice(0, GUIDE_ROWS).map(row => (
            <li key={row.id}>
              <button type="button" className={css.row} onClick={open}>
                <span className={css.rowTop}>
                  <span className={css.name}>{row.name}</span>
                  <PhaseTag phase={row.phase} t={t} />
                </span>
                <RowMeta row={row} t={t} />
              </button>
            </li>
          ))}
          {rows.length > GUIDE_ROWS && (
            <li><button type="button" className={css.more} onClick={open}>{t('session.more', { count: rows.length - GUIDE_ROWS })}</button></li>
          )}
        </ul>
      )}
    </div>
  )
}

/**
 * The tab chip's title: the checklist glyph before the tab's title.
 * @param props - the tab information hook.
 * @returns glyph and title.
 */
export function SessionJobsTitle({ useTabInfo }: PropsRuntime<'sidebar.right.pane.tab.title'>) {
  const { tab } = useTabInfo()
  return <><IconChecklistOutlineRegular size={16} className={css.titleIcon} />{tab.title}</>
}
