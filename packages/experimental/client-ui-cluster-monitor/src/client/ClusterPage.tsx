/** The Cluster jobs page: watched SSP jobs beside the selected job's state, training curves, and logs. */
import { useEffect, useMemo, useState, useSyncExternalStore, type FormEvent } from 'react'
import { Button, IconRefreshOutlineRegular, IconTrashOutlineRegular, Input, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {
  ClusterJobDetail, ClusterJobPhase, ClusterMetricSeries, ClusterWatchId, ClusterWatchRequest, ClusterWatchRow,
} from '@deepseek-ai/dsh-experimental-cluster-monitor/types'
import { formatValue, geometry, VIEW_HEIGHT, VIEW_WIDTH } from './chart.ts'
import { DescriptionField, MetricSourceField, type JobSettingsActions } from './JobSettings.tsx'
import type { Mirror, MirrorHandle } from './source.ts'
import css from './ClusterPage.module.css'

/** Host mirrors and actions the page receives from its registration. */
export interface ClusterPageInjected extends JobSettingsActions {
  readonly hooks: { readonly watchList: HostObservable<Mirror<ClusterWatchRow[]>> }
  /** Open a detail mirror for one job; the page disposes it when the selection changes. */
  readonly openJob: (watchId: ClusterWatchId) => MirrorHandle<ClusterJobDetail>
  /** Start watching a job; resolves to a failure message or null. */
  readonly watch: (request: ClusterWatchRequest) => Promise<string | null>
  /** Stop watching a job; resolves to a failure message or null. */
  readonly unwatch: (watchId: ClusterWatchId) => Promise<string | null>
  /** Poll a job now; resolves to a failure message or null. */
  readonly refresh: (watchId: ClusterWatchId) => Promise<string | null>
}

/** Page props derived from the `main` seat, the injected face, and the plugin dictionary. */
export type ClusterPageProps = PropsRuntime<'main'> & InjectFace<ClusterPageInjected> & PropsLocale<'cluster.monitor'>

type Translate = ClusterPageProps['t']

const PHASE_TONE: Readonly<Record<ClusterJobPhase, TagTone>> = {
  pending: 'info',
  running: 'success',
  succeeded: 'neutral',
  failed: 'danger',
  stopped: 'warning',
  unknown: 'outline',
}

/**
 * Render a job phase as a colored tag.
 * @param props - the phase and the translate function.
 * @returns the tag.
 */
export function PhaseTag({ phase, t }: { phase: ClusterJobPhase; t: Translate }) {
  return <Tag tone={PHASE_TONE[phase]}>{t(`phase.${phase}`)}</Tag>
}

function time(value: string | undefined): string {
  if (value === undefined) return '—'
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? value : new Date(parsed).toLocaleString()
}

/**
 * Render one training metric as a sparkline with its step range and value range.
 * @param props - the series and the translate function.
 * @returns the chart card.
 */
export function MetricChart({ series, t }: { series: ClusterMetricSeries; t: Translate }) {
  const shape = useMemo(() => geometry(series.points), [series.points])
  if (shape === undefined) return null
  return (
    <figure className={css.chart}>
      <figcaption className={css.chartCaption}>
        <span className={css.chartName}>{series.name}</span>
        <span className={css.chartLatest}>{t('metrics.latest', { value: formatValue(shape.lastValue) })}</span>
      </figcaption>
      <svg className={css.chartPlot} viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`} preserveAspectRatio="none" role="img" aria-label={series.name}>
        <polyline className={css.chartLine} points={shape.points} vectorEffect="non-scaling-stroke" />
      </svg>
      <div className={css.chartAxis}>
        <span>{shape.firstStep}</span>
        <span>{formatValue(shape.minValue)} – {formatValue(shape.maxValue)}</span>
        <span>{shape.lastStep}</span>
      </div>
    </figure>
  )
}

/**
 * Render a row's description, or its console display name, on one truncated line.
 * @param props - the row.
 * @returns the line, or nothing when the job has neither.
 */
export function RowDescription({ row }: { row: ClusterWatchRow }) {
  const text = row.description ?? row.displayName
  return text === undefined ? null : <span className={css.rowDescription} title={text}>{text}</span>
}

function useMirror<T>(handle: MirrorHandle<T> | undefined): Mirror<T> | undefined {
  return useSyncExternalStore(
    listener => handle?.store.subscribe(listener) ?? (() => {}),
    () => handle?.store.getSnapshot(),
  )
}

/** Actions and copy the job detail needs; the Cluster jobs page and the Session jobs tab both supply them. */
export type JobDetailActions = Pick<ClusterPageInjected, 'openJob' | 'refresh' | 'unwatch' | 'configure' | 'metricSources'> & { readonly t: Translate }

/**
 * Render one watched job's state, curves, logs, and job object with refresh and stop-watching actions.
 * @param props - the job's actions and copy, its watch id, and the callback after the watch is removed.
 * @returns the detail section.
 */
export function JobDetail({ props, watchId, onRemoved }: { props: JobDetailActions; watchId: ClusterWatchId; onRemoved: () => void }) {
  const { openJob, refresh, unwatch, t } = props
  const [handle, setHandle] = useState<MirrorHandle<ClusterJobDetail>>()
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  useEffect(() => {
    const opened = openJob(watchId)
    setHandle(opened)
    setConfirming(false)
    setFailure(null)
    return () => { void opened.dispose() }
  }, [openJob, watchId])
  const job = useMirror(handle)?.value ?? null
  if (job === null) return <div className={css.detailEmpty}>{t('list.loading')}</div>

  const run = async (action: () => Promise<string | null>, after?: () => void) => {
    setBusy(true)
    const message = await action()
    setBusy(false)
    setFailure(message)
    if (message === null) after?.()
  }
  const facts: [string, string][] = [
    [t('detail.state'), job.rawState ?? '—'],
    [t('detail.workspace'), job.workspace ?? '—'],
    [t('detail.origin'), t(`origin.${job.origin}`)],
    [t('detail.step'), job.step === undefined ? '—' : String(job.step)],
    [t('detail.created'), time(job.createdAt)],
    [t('detail.started'), time(job.startedAt)],
    [t('detail.finished'), time(job.finishedAt)],
    [t('detail.checked'), time(job.checkedAt)],
  ]
  return (
    <section className={css.detail} aria-label={job.name}>
      <header className={css.detailHeading}>
        <h2>{job.name}</h2>
        <PhaseTag phase={job.phase} t={t} />
        <span className={css.spacer} />
        <Button size="sm" variant="outline" disabled={busy} icon={<IconRefreshOutlineRegular size={16} />}
          onClick={() => { void run(() => refresh(watchId)) }}>
          {t('detail.refresh')}
        </Button>
        <Button size="sm" variant={confirming ? 'primary' : 'outline'} disabled={busy} icon={<IconTrashOutlineRegular size={16} />}
          onClick={() => {
            if (!confirming) { setConfirming(true); return }
            void run(() => unwatch(watchId), onRemoved)
          }}>
          {confirming ? t('detail.unwatchConfirm') : t('detail.unwatch')}
        </Button>
      </header>
      <DescriptionField job={job} configure={props.configure} t={t} />
      {failure !== null && <p className={css.notice} role="alert">{t('action.failed', { message: failure })}</p>}
      {job.error !== undefined && <p className={css.notice}>{t('detail.error', { message: job.error })}</p>}
      <dl className={css.facts}>
        {facts.map(([label, value]) => (
          <div key={label} className={css.fact}><dt>{label}</dt><dd>{value}</dd></div>
        ))}
      </dl>
      <h3>{t('metrics.title')}</h3>
      <MetricSourceField job={job} actions={props} t={t} />
      {job.series.length === 0
        ? <p className={css.muted}>{t('metrics.empty')}</p>
        : <div className={css.charts}>{job.series.map(series => <MetricChart key={series.name} series={series} t={t} />)}</div>}
      <h3>{t('logs.title')}</h3>
      {job.logError !== undefined && <p className={css.notice}>{t('logs.error', { message: job.logError })}</p>}
      {job.logTail.length === 0
        ? <p className={css.muted}>{t('logs.empty')}</p>
        : <pre className={css.logs}>{job.logTail}</pre>}
      {job.describe !== null && (
        <details className={css.describe}>
          <summary>{t('describe.title')}</summary>
          <pre className={css.logs}>{job.describe}</pre>
        </details>
      )}
    </section>
  )
}

/**
 * Render the watch form, the watched jobs, and the selected job's detail.
 * @param props - watch list mirror, actions, and dictionary.
 * @returns the page.
 */
export function ClusterPage(props: ClusterPageProps) {
  const { useWatchList, watch, t } = props
  const list = useWatchList(snapshot => snapshot)
  const rows = list.value
  const [selected, setSelected] = useState<ClusterWatchId | null>(null)
  const [name, setName] = useState('')
  const [workspace, setWorkspace] = useState('')
  const [description, setDescription] = useState('')
  const [adding, setAdding] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const current = rows?.find(row => row.id === selected) ?? rows?.[0]

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (name.trim() === '') return
    setAdding(true)
    const message = await watch({
      name: name.trim(),
      ...workspace.trim() === '' ? {} : { workspace: workspace.trim() },
      ...description.trim() === '' ? {} : { description: description.trim() },
    })
    setAdding(false)
    setFailure(message)
    if (message === null) { setName(''); setDescription('') }
  }

  return (
    <div className={css.page}>
      <aside className={css.listPane}>
        <header className={css.pageHeading}>
          <h1>{t('page.title')}</h1>
          <p className={css.muted}>{t('page.subtitle')}</p>
        </header>
        <form className={css.watchForm} onSubmit={(event) => { void submit(event) }}>
          <Input value={name} placeholder={t('watch.name')} aria-label={t('watch.name')} onChange={(event) => { setName(event.target.value) }} />
          <Input value={workspace} placeholder={t('watch.workspace')} aria-label={t('watch.workspace')}
            onChange={(event) => { setWorkspace(event.target.value) }} />
          <Input value={description} placeholder={t('watch.description')} aria-label={t('watch.description')}
            onChange={(event) => { setDescription(event.target.value) }} />
          <Button type="submit" variant="primary" size="sm" disabled={adding || name.trim() === ''}>
            {adding ? t('watch.pending') : t('watch.submit')}
          </Button>
        </form>
        {failure !== null && <p className={css.notice} role="alert">{t('action.failed', { message: failure })}</p>}
        {!list.connected && list.error !== null && <p className={css.notice}>{t('list.disconnected')}</p>}
        {rows === null
          ? <p className={css.muted}>{t('list.loading')}</p>
          : rows.length === 0
            ? <p className={css.muted}>{t('list.empty')}</p>
            : (
              <ul className={css.rows} aria-label={t('list.aria')}>
                {rows.map(row => (
                  <li key={row.id}>
                    <button type="button" className={css.row} aria-current={row.id === current?.id}
                      onClick={() => { setSelected(row.id) }}>
                      <span className={css.rowTop}>
                        <span className={css.rowName}>{row.name}</span>
                        <PhaseTag phase={row.phase} t={t} />
                      </span>
                      <RowDescription row={row} />
                      <span className={css.rowMeta}>
                        {row.workspace ?? ''}
                        {row.step === undefined ? '' : ` · ${t('list.step', { step: row.step })}`}
                        {row.error === undefined ? '' : ' · ⚠'}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
      </aside>
      <div className={css.detailPane}>
        {current === undefined
          ? <div className={css.detailEmpty}>{t('detail.empty')}</div>
          : <JobDetail key={current.id} props={props} watchId={current.id} onRemoved={() => { setSelected(null) }} />}
      </div>
    </div>
  )
}
