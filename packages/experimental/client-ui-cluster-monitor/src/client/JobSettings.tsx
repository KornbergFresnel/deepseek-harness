/** Editors of a watched job's description and metric source, shown in the job detail. */
import { useState } from 'react'
import { Button, Checkbox, IconEditOutlineRegular, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  ClusterLogParser, ClusterMetricSource, ClusterWatchChanges, ClusterWatchId, ClusterWatchRow,
} from '@deepseek-ai/dsh-experimental-cluster-monitor/types'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ClusterMonitorKey } from './locales.ts'
import css from './ClusterPage.module.css'

/** Translate bound to the `cluster.monitor` namespace. */
export type MonitorTranslate = PropsLocale<'cluster.monitor'>['t']

/** Registered metric source kinds, or why they could not be read. */
export type MetricSourceList = { readonly kinds: readonly string[] } | { readonly error: string }

/** Actions the editors call. */
export interface JobSettingsActions {
  /** Change a watch's description or metric source; resolves to a failure message or null. */
  readonly configure: (watchId: ClusterWatchId, changes: ClusterWatchChanges) => Promise<string | null>
  /** Read the registered metric source kinds. */
  readonly metricSources: () => Promise<MetricSourceList>
}

/** Built-in parsers the logs editor offers as checkboxes; `regex` parsers come from the pattern list. */
export const FIXED_PARSERS = ['experiment-logger', 'json-lines', 'key-value'] as const

type FixedParser = (typeof FIXED_PARSERS)[number]

/**
 * Show a job's description, or its console display name, with an inline editor.
 * @param props - the row, actions, and dictionary.
 * @returns the description block.
 */
export function DescriptionField({ job, configure, t }: { job: ClusterWatchRow; configure: JobSettingsActions['configure']; t: MonitorTranslate }) {
  const [draft, setDraft] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  if (draft === null) {
    const shown = job.description ?? job.displayName
    return (
      <div className={css.description}>
        <p className={shown === undefined ? css.muted : undefined}>{shown ?? t('description.empty')}</p>
        <Button size="sm" variant="ghost" icon={<IconEditOutlineRegular size={16} />} onClick={() => { setDraft(job.description ?? '') }}>
          {t('description.edit')}
        </Button>
      </div>
    )
  }
  const save = async () => {
    setBusy(true)
    const message = await configure(job.id, { description: draft })
    setBusy(false)
    setFailure(message)
    if (message === null) setDraft(null)
  }
  return (
    <div className={css.description}>
      <Input value={draft} placeholder={t('description.placeholder')} aria-label={t('description.label')}
        onChange={(event) => { setDraft(event.target.value) }} />
      <Button size="sm" variant="primary" disabled={busy} onClick={() => { void save() }}>{t('settings.save')}</Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setDraft(null); setFailure(null) }}>{t('settings.cancel')}</Button>
      {failure !== null && <p className={css.notice} role="alert">{t('action.failed', { message: failure })}</p>}
    </div>
  )
}

function parsersOf(source: ClusterMetricSource): ClusterLogParser[] | undefined {
  const parsers = source.options?.['parsers']
  if (!Array.isArray(parsers)) return undefined
  return parsers.flatMap((entry): ClusterLogParser[] => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return []
    const { kind, stepKey, pattern } = entry
    if (kind === 'regex') return typeof pattern === 'string' ? [{ kind, pattern }] : []
    if (kind === 'experiment-logger') return [{ kind }]
    if (kind === 'json-lines' || kind === 'key-value') return [{ kind, ...typeof stepKey === 'string' ? { stepKey } : {} }]
    return []
  })
}

/**
 * Describe a metric source in one line.
 * @param source - the source.
 * @param t - dictionary.
 * @returns the summary text.
 */
export function sourceSummary(source: ClusterMetricSource, t: MonitorTranslate): string {
  if (source.kind === 'logs') {
    const parsers = parsersOf(source)
    if (parsers === undefined) return t('metrics.logsDefault')
    return parsers.map(parser => parser.kind === 'regex' ? parser.pattern : t(`metrics.parser.${parser.kind}`)).join(' · ')
  }
  if (source.kind === 'wandb') {
    const run = source.options?.['run']
    return typeof run === 'string' ? run : t('metrics.wandbAuto')
  }
  return source.options === undefined ? '' : JSON.stringify(source.options)
}

/** Editor state of the source form. */
interface SourceDraft {
  kind: string
  fixed: Record<FixedParser, boolean>
  stepKey: string
  patterns: string
  run: string
  json: string
}

function draftOf(source: ClusterMetricSource): SourceDraft {
  const parsers = parsersOf(source) ?? []
  const run = source.options?.['run']
  return {
    kind: source.kind,
    fixed: {
      'experiment-logger': parsers.some(parser => parser.kind === 'experiment-logger'),
      'json-lines': parsers.some(parser => parser.kind === 'json-lines'),
      'key-value': parsers.some(parser => parser.kind === 'key-value'),
    },
    stepKey: parsers.flatMap(parser => (parser.kind === 'json-lines' || parser.kind === 'key-value') && parser.stepKey !== undefined ? [parser.stepKey] : [])[0] ?? '',
    patterns: parsers.flatMap(parser => parser.kind === 'regex' ? [parser.pattern] : []).join('\n'),
    run: typeof run === 'string' ? run : '',
    json: source.options === undefined ? '' : JSON.stringify(source.options, null, 2),
  }
}

/** Build the source a draft names, or the dictionary key of its problem. */
export function sourceOf(draft: SourceDraft): { ok: true; source: ClusterMetricSource } | { ok: false; problem: ClusterMonitorKey } {
  if (draft.kind === 'logs') {
    const stepKey = draft.stepKey.trim()
    const parsers: JsonValue[] = FIXED_PARSERS.filter(kind => draft.fixed[kind]).map(kind => (
      kind === 'experiment-logger' || stepKey === '' ? { kind } : { kind, stepKey }
    ))
    for (const line of draft.patterns.split('\n')) if (line.trim() !== '') parsers.push({ kind: 'regex', pattern: line.trim() })
    if (parsers.length === 0) return { ok: false, problem: 'metrics.parsersEmpty' }
    return { ok: true, source: { kind: 'logs', options: { parsers } } }
  }
  if (draft.kind === 'wandb') {
    const run = draft.run.trim()
    return { ok: true, source: run === '' ? { kind: 'wandb' } : { kind: 'wandb', options: { run } } }
  }
  if (draft.json.trim() === '') return { ok: true, source: { kind: draft.kind } }
  let options: JsonValue
  try {
    options = JSON.parse(draft.json) as JsonValue
  } catch (_invalidJson) {
    return { ok: false, problem: 'metrics.optionsInvalid' }
  }
  if (typeof options !== 'object' || options === null || Array.isArray(options)) return { ok: false, problem: 'metrics.optionsInvalid' }
  return { ok: true, source: { kind: draft.kind, options } }
}

/**
 * Show where a job's curves come from, with an editor for the source and a reset to the configured default.
 * @param props - the row, actions, and dictionary.
 * @returns the source block.
 */
export function MetricSourceField({ job, actions, t }: { job: ClusterWatchRow; actions: JobSettingsActions; t: MonitorTranslate }) {
  const [draft, setDraft] = useState<SourceDraft | null>(null)
  const [kinds, setKinds] = useState<readonly string[]>([job.metrics.kind])
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const kindLabel = (kind: string) => kind === 'logs' || kind === 'wandb' ? t(`metrics.kind.${kind}`) : kind
  const apply = async (changes: ClusterWatchChanges) => {
    setBusy(true)
    const message = await actions.configure(job.id, changes)
    setBusy(false)
    setFailure(message === null ? null : t('action.failed', { message }))
    if (message === null) setDraft(null)
  }
  const open = async () => {
    setDraft(draftOf(job.metrics))
    const listed = await actions.metricSources()
    if ('kinds' in listed) setKinds([...new Set([...listed.kinds, job.metrics.kind])])
    else setFailure(t('action.failed', { message: listed.error }))
  }
  const summary = sourceSummary(job.metrics, t)
  const notice = (
    <>
      {failure !== null && <p className={css.notice} role="alert">{failure}</p>}
      {job.metricsError !== undefined && <p className={css.notice}>{t('metrics.error', { message: job.metricsError })}</p>}
    </>
  )
  if (draft === null) {
    return (
      <div className={css.source}>
        <p>
          <span className={css.sourceKind}>{t(job.metricsDefault ? 'metrics.sourceDefault' : 'metrics.source', { kind: kindLabel(job.metrics.kind) })}</span>
          {summary === '' ? '' : ` · ${summary}`}
        </p>
        <Button size="sm" variant="ghost" icon={<IconEditOutlineRegular size={16} />} onClick={() => { void open() }}>{t('metrics.edit')}</Button>
        {notice}
      </div>
    )
  }
  const set = <K extends keyof SourceDraft>(key: K, value: SourceDraft[K]) => { setDraft({ ...draft, [key]: value }) }
  const save = () => {
    const built = sourceOf(draft)
    if (!built.ok) { setFailure(t(built.problem)); return }
    void apply({ metrics: built.source })
  }
  return (
    <div className={css.sourceForm}>
      <label className={css.field}>
        <span>{t('metrics.kind')}</span>
        <select className={css.select} value={draft.kind} aria-label={t('metrics.kind')} onChange={(event) => { set('kind', event.target.value) }}>
          {kinds.map(kind => <option key={kind} value={kind}>{kindLabel(kind)}</option>)}
        </select>
      </label>
      {draft.kind === 'logs' && (
        <>
          <div className={css.checks}>
            {FIXED_PARSERS.map(kind => (
              <Checkbox key={kind} label={t(`metrics.parser.${kind}`)} checked={draft.fixed[kind]}
                onChange={(checked) => { set('fixed', { ...draft.fixed, [kind]: checked }) }} />
            ))}
          </div>
          <label className={css.field}>
            <span>{t('metrics.stepKey')}</span>
            <Input value={draft.stepKey} placeholder={t('metrics.stepKeyPlaceholder')} aria-label={t('metrics.stepKey')} onChange={(event) => { set('stepKey', event.target.value) }} />
          </label>
          <label className={css.field}>
            <span>{t('metrics.patterns')}</span>
            <textarea className={css.textarea} value={draft.patterns} rows={3} aria-label={t('metrics.patterns')}
              placeholder={String.raw`step (?<step>\d+) .*loss=(?<loss>[\d.]+)`} onChange={(event) => { set('patterns', event.target.value) }} />
          </label>
        </>
      )}
      {draft.kind === 'wandb' && (
        <label className={css.field}>
          <span>{t('metrics.run')}</span>
          <Input value={draft.run} placeholder={t('metrics.runPlaceholder')} aria-label={t('metrics.run')} onChange={(event) => { set('run', event.target.value) }} />
        </label>
      )}
      {draft.kind !== 'logs' && draft.kind !== 'wandb' && (
        <label className={css.field}>
          <span>{t('metrics.options')}</span>
          <textarea className={css.textarea} value={draft.json} rows={3} aria-label={t('metrics.options')}
            onChange={(event) => { set('json', event.target.value) }} />
        </label>
      )}
      <p className={css.muted}>{t('metrics.clearHint')}</p>
      <div className={css.sourceActions}>
        <Button size="sm" variant="primary" disabled={busy} onClick={save}>{t('settings.save')}</Button>
        {!job.metricsDefault && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => { void apply({ metrics: null }) }}>{t('metrics.reset')}</Button>
        )}
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setDraft(null); setFailure(null) }}>{t('settings.cancel')}</Button>
      </div>
      {notice}
    </div>
  )
}
