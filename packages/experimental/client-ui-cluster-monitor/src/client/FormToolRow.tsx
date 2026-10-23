/** The chat row of `sco_config_form`: the live form while the call waits, then the confirmed settings with an offer to save them. */
import { useState } from 'react'
import { Button, IconSlidersTwoOutlineRegular, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type {
  ScoConfigForm, ScoConfigFormAnswer, ScoConfigFormOutcome, ScoConfigOverview, ScoConfigSaveRequest, ScoWorkloadKind, ScoWorkloadSpec,
} from '@deepseek-ai/dsh-experimental-sco-submit/types'
import type { Mirror } from './source.ts'
import { specFacts, suggestName } from './workload.ts'
import { WorkloadForm, type WorkloadTranslate } from './WorkloadForm.tsx'
import css from './FormToolRow.module.css'

/** Host mirrors and actions the row receives from its registration. */
export interface FormRowInjected {
  readonly hooks: {
    readonly forms: HostObservable<Mirror<ScoConfigForm[]>>
    readonly overview: HostObservable<Mirror<ScoConfigOverview>>
  }
  /** Answer the form a call opened; resolves to a failure message or null. */
  readonly answer: (callId: string, answer: ScoConfigFormAnswer) => Promise<string | null>
  /** Save settings as a reusable configuration; resolves to a failure message or null. */
  readonly saveConfig: (request: ScoConfigSaveRequest) => Promise<string | null>
}

/** Row props derived from the keyed tool seat, the injected face, and the plugin dictionary. */
export type FormToolRowProps = ToolCallViewProps & InjectFace<FormRowInjected> & PropsLocale<'cluster.workload'>

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    // A running call can expose a truncated argument prefix, and an error result is plain text.
    return null
  }
}

/**
 * Read the workload kind and heading from the call arguments.
 * @param argsRaw - recorded argument JSON, possibly a truncated prefix.
 * @returns kind (job when unreadable) and optional title.
 */
export function formArgs(argsRaw: string): { kind: ScoWorkloadKind; title?: string } {
  const args = record(parse(argsRaw))
  const kind = args?.kind === 'devmachine' ? 'devmachine' : 'job'
  return typeof args?.title === 'string' && args.title !== '' ? { kind, title: args.title } : { kind }
}

/**
 * Read a form outcome from the recorded result text.
 * @param text - the result's text content.
 * @returns the outcome, or null when the text is not an outcome.
 */
export function formOutcome(text: string): ScoConfigFormOutcome | null {
  const value = record(parse(text))
  if (value?.kind === 'cancelled') return { kind: 'cancelled' }
  const spec = record(value?.spec)
  if (value?.kind !== 'confirmed' || spec === null) return null
  return {
    kind: 'confirmed',
    workload: value.workload === 'devmachine' ? 'devmachine' : 'job',
    spec: spec as ScoWorkloadSpec,
    ...typeof value.loaded === 'string' ? { loaded: value.loaded } : {},
    ...typeof value.savedAs === 'string' ? { savedAs: value.savedAs } : {},
  }
}

function Heading({ kind, title, status, t }: { kind: ScoWorkloadKind; title?: string | undefined; status: string; t: WorkloadTranslate }) {
  return (
    <div className={css.heading}>
      <IconSlidersTwoOutlineRegular size={14} />
      <span className={css.title}>{title ?? t(`form.title.${kind}`)}</span>
      <span className={css.status}>{status}</span>
    </div>
  )
}

/** Offer to save confirmed settings that were not saved with the form. */
function SavePrompt({ kind, spec, initialName, saveConfig, t }: {
  kind: ScoWorkloadKind
  spec: ScoWorkloadSpec
  initialName: string
  saveConfig: FormRowInjected['saveConfig']
  t: WorkloadTranslate
}) {
  const [name, setName] = useState(initialName)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  if (saved !== null) return <p className={css.note}>{t('row.saved', { name: saved })}</p>
  const save = async () => {
    if (name.trim() === '') { setFailure(t('invalid.name')); return }
    setBusy(true)
    const message = await saveConfig({ name: name.trim(), kind, spec, replace: true })
    setBusy(false)
    setFailure(message === null ? null : t('action.failed', { message }))
    if (message === null) setSaved(name.trim())
  }
  return (
    <div className={css.prompt}>
      <span>{t('row.savePrompt')}</span>
      <span className={css.promptActions}>
        <Input value={name} placeholder={t('save.namePlaceholder')} aria-label={t('save.name')} onChange={(event) => { setName(event.target.value) }} />
        <Button size="sm" variant="outline" disabled={busy} onClick={() => { void save() }}>{busy ? t('form.saving') : t('form.save')}</Button>
      </span>
      {failure !== null && <span className={css.note} role="alert">{failure}</span>}
    </div>
  )
}

function ResultRow({ props, kind, title }: { props: Extract<FormToolRowProps, { phase: 'result' }>; kind: ScoWorkloadKind; title?: string | undefined }) {
  const { block, toolName, saveConfig, t } = props
  const text = block.content.flatMap(item => item.type === 'text' ? [item.text] : []).join('\n')
  const outcome = block.isError ? null : formOutcome(text)
  if (outcome === null) {
    return <div className={css.row} data-tool={toolName} data-state="error"><Heading kind={kind} title={title} status={t('row.closed', { message: text })} t={t} /></div>
  }
  if (outcome.kind === 'cancelled') {
    return <div className={css.row} data-tool={toolName} data-state="cancelled"><Heading kind={kind} title={title} status={t('row.cancelled')} t={t} /></div>
  }
  const status = outcome.savedAs === undefined ? t('row.confirmed') : t('row.confirmedSaved', { name: outcome.savedAs })
  return (
    <div className={css.row} data-tool={toolName} data-state="confirmed">
      <Heading kind={outcome.workload} title={title} status={status} t={t} />
      {outcome.loaded !== undefined && <p className={css.note}>{t('row.loadedFrom', { name: outcome.loaded })}</p>}
      <dl className={css.facts}>
        {specFacts(outcome.spec).map(([label, value]) => <div key={label}><dt>{t(label)}</dt><dd>{value}</dd></div>)}
      </dl>
      {outcome.savedAs === undefined && (
        <SavePrompt kind={outcome.workload} spec={outcome.spec} saveConfig={saveConfig} t={t}
          initialName={outcome.loaded ?? suggestName(title ?? '')} />
      )}
    </div>
  )
}

function OpenForm({ props, form }: { props: FormToolRowProps; form: ScoConfigForm }) {
  const { useOverview, answer, t } = props
  const overview = useOverview(snapshot => snapshot.value)
  return (
    <WorkloadForm kind={form.kind} heading={form.title ?? t(`form.title.${form.kind}`)} initial={form.initial} overview={overview}
      suggested={form.suggested} save={{ mode: 'optional', name: form.suggested ?? suggestName(form.title ?? '') }}
      submitLabel="form.confirm" busyLabel="form.confirming" t={t}
      onSubmit={result => answer(form.callId, { kind: 'confirmed', ...result })}
      onCancel={() => { void answer(form.callId, { kind: 'cancelled' }) }} />
  )
}

/**
 * Render a `sco_config_form` call: a preparing line, the live form, or the settled outcome.
 * @param props - call phase and block, form and overview mirrors, actions, and dictionary.
 * @returns the row.
 */
export function FormToolRow(props: FormToolRowProps) {
  const { callId, toolName, useForms, t } = props
  const form = useForms(snapshot => snapshot.value?.find(item => item.callId === callId))
  if (props.phase === 'preparing') {
    return <div className={css.row} data-tool={toolName} data-state="preparing"><Heading kind="job" status={t('row.preparing')} t={t} /></div>
  }
  if (props.phase === 'result') {
    const args = formArgs(props.block.call?.argsRaw ?? '')
    return <ResultRow props={props} kind={args.kind} title={args.title} />
  }
  if (form !== undefined) return <div className={css.live} data-tool={toolName} data-state="open"><OpenForm props={props} form={form} /></div>
  const args = formArgs(props.block.argsRaw)
  return <div className={css.row} data-tool={toolName} data-state="opening"><Heading kind={args.kind} title={args.title} status={t('row.opening')} t={t} /></div>
}
