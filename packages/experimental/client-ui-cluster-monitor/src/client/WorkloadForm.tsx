/** The workload settings form shared by the chat configuration row and the Saved configurations page. */
import { useState, type FormEvent, type ReactNode } from 'react'
import { Button, Checkbox, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ScoConfigOverview, ScoSource, ScoWorkloadKind, ScoWorkloadSpec } from '@deepseek-ai/dsh-experimental-sco-submit/types'
import { draftOf, JOB_ONLY, specOf, type CountField, type WorkloadDraft } from './workload.ts'
import type { ClusterWorkloadKey } from './workload-locales.ts'
import css from './WorkloadForm.module.css'

/** Translate bound to the `cluster.workload` namespace. */
export type WorkloadTranslate = PropsLocale<'cluster.workload'>['t']

/** What the form submits: the settings, the saved configuration loaded, and the save request. */
export interface WorkloadFormResult {
  readonly spec: ScoWorkloadSpec
  readonly loaded?: string
  readonly save?: { readonly name: string; readonly description?: string }
}

/** How the form treats saving: offered with a toggle in the chat, or required on the Saved configurations page. */
export type WorkloadFormSave =
  | { readonly mode: 'optional'; readonly name: string }
  | { readonly mode: 'required'; readonly name: string; readonly description: string; readonly lockName: boolean }

/** Inputs of the workload settings form. */
export interface WorkloadFormProps {
  readonly kind: ScoWorkloadKind
  readonly heading: string
  readonly initial: ScoWorkloadSpec
  /** Sources, queue options, and saved configurations; null while the Host overview loads. */
  readonly overview: ScoConfigOverview | null
  /** Saved configuration the agent suggests loading. */
  readonly suggested?: string | undefined
  readonly save: WorkloadFormSave
  readonly submitLabel: ClusterWorkloadKey
  readonly busyLabel: ClusterWorkloadKey
  /** Resolves to a failure message, or null after the Host accepted the result. */
  readonly onSubmit: (result: WorkloadFormResult) => Promise<string | null>
  readonly onCancel: () => void
  readonly t: WorkloadTranslate
}

const IMAGE_TYPES = ['OFFICIAL', 'PRIVATE', 'THIRD_PARTY'] as const
const PRIORITIES = ['NORMAL', 'HIGH', 'HIGHEST'] as const
const FRAMEWORKS = ['PYTORCH_DDP', 'MPI', 'RAY_JOB', 'TENSORFLOW_PS', 'FRAMEWORK_CUSTOM'] as const

function Field({ label, wide, children }: { label: string; wide?: boolean; children: ReactNode }) {
  return <label className={wide === true ? css.wideField : css.field}><span className={css.label}>{label}</span>{children}</label>
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className={css.section}>
      <legend className={css.legend}>{title}</legend>
      <div className={css.grid}>{children}</div>
    </fieldset>
  )
}

/** A select whose options are values with display labels, keeping a current value that is not listed. */
function Choice({ label, value, empty, options, onChange }: {
  label: string
  value: string
  empty: string
  options: readonly (readonly [string, string])[]
  onChange: (value: string) => void
}) {
  const listed = value === '' || options.some(([option]) => option === value)
  return (
    <Field label={label}>
      <select className={css.select} value={value} aria-label={label} onChange={(event) => { onChange(event.target.value) }}>
        <option value="">{empty}</option>
        {!listed && <option value={value}>{value}</option>}
        {options.map(([option, text]) => <option key={option} value={option}>{text}</option>)}
      </select>
    </Field>
  )
}

function sourcesOf(overview: ScoConfigOverview | null, kind: ScoSource['kind']): string[] {
  return (overview?.sources ?? []).filter(entry => entry.source.kind === kind).map(entry => entry.name)
}

/**
 * Render the settings form with saved-configuration loading, source and queue choices, and saving.
 * @param props - kind, initial values, Host overview, save mode, callbacks, and dictionary.
 * @returns the form.
 */
export function WorkloadForm(props: WorkloadFormProps) {
  const { kind, heading, initial, overview, suggested, save, t } = props
  const [draft, setDraft] = useState<WorkloadDraft>(() => draftOf(initial))
  const [loaded, setLoaded] = useState<string | undefined>()
  const [saving, setSaving] = useState(save.mode === 'required')
  const [name, setName] = useState(save.name)
  const [description, setDescription] = useState(save.mode === 'required' ? save.description : '')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const configs = (overview?.configs ?? []).filter(entry => entry.config.kind === kind)
  const set = <K extends keyof WorkloadDraft>(key: K) => (value: WorkloadDraft[K]) => {
    setDraft(current => ({ ...current, [key]: value }))
  }
  const load = (picked: string) => {
    const config = configs.find(entry => entry.name === picked)?.config
    setDraft(draftOf(config?.spec ?? initial))
    setLoaded(config === undefined ? undefined : picked)
    if (config !== undefined && save.mode === 'optional' && (name === '' || name === loaded)) setName(picked)
  }
  const shown = (key: keyof WorkloadDraft): boolean => kind === 'job' || !JOB_ONLY.has(key)
  const text = (key: 'image' | 'ref' | 'workspace' | 'command', label: ClusterWorkloadKey, wide = false) => (
    <Field label={t(label)} wide={wide}>
      <Input value={draft[key]} aria-label={t(label)} onChange={(event) => { set(key)(event.target.value) }} />
    </Field>
  )
  const lines = (key: 'repos' | 'packages', label: ClusterWorkloadKey) => (
    <Field label={t(label)} wide>
      <textarea className={css.textarea} rows={2} value={draft[key]} aria-label={t(label)}
        onChange={(event) => { set(key)(event.target.value) }} />
    </Field>
  )
  const count = (key: CountField) => shown(key) && (
    <Field key={key} label={t(`field.${key}`)}>
      <Input value={draft[key]} inputMode="numeric" aria-label={t(`field.${key}`)} onChange={(event) => { set(key)(event.target.value) }} />
    </Field>
  )

  const queues = overview?.options?.queues ?? []
  const queue = queues.find(entry => entry.id === draft.queueId)
  const machineTypes = [...new Set((queue === undefined ? queues : [queue]).flatMap(entry => entry.machineTypes))]
  const dataSources = sourcesOf(overview, 'data')
  const replacing = saving && (overview?.configs ?? []).some(entry => entry.name === name.trim()) && !(save.mode === 'required' && save.lockName)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const built = specOf(draft, kind)
    if (!built.ok) {
      const problem = built.problem
      setFailure(problem.kind === 'number' ? t('invalid.number', { field: t(`field.${problem.field}`) }) : t('invalid.env', { line: problem.line }))
      return
    }
    if (saving && name.trim() === '') { setFailure(t('invalid.name')); return }
    setBusy(true)
    const message = await props.onSubmit({
      spec: built.spec,
      ...loaded === undefined ? {} : { loaded },
      ...saving ? { save: { name: name.trim(), ...description.trim() === '' ? {} : { description: description.trim() } } } : {},
    })
    setBusy(false)
    setFailure(message === null ? null : t('action.failed', { message }))
  }

  return (
    <form className={css.form} onSubmit={(event) => { void submit(event) }}>
      <h3 className={css.heading}>{heading}</h3>
      {configs.length > 0 && (
        <div className={css.load}>
          <Choice label={t('form.load')} value={loaded ?? ''} empty={t('form.loadNone')}
            options={configs.map(entry => [entry.name, entry.config.description === undefined ? entry.name : `${entry.name} · ${entry.config.description}`])}
            onChange={load} />
          {loaded === undefined && <p className={css.hint}>{t('form.loadHint', { count: configs.length })}</p>}
          {suggested !== undefined && loaded !== suggested && configs.some(entry => entry.name === suggested) && (
            <p className={css.hint}>
              {t('form.suggested', { name: suggested })}
              <Button type="button" size="sm" variant="outline" onClick={() => { load(suggested) }}>{t('form.loadSuggested', { name: suggested })}</Button>
            </p>
          )}
          {loaded !== undefined && <p className={css.hint}>{t('form.loaded', { name: loaded })}</p>}
        </div>
      )}
      <Section title={t('section.image')}>
        {text('image', 'field.image', true)}
        <Choice label={t('field.imageType')} value={draft.imageType} empty={t('field.default')}
          options={IMAGE_TYPES.map(type => [type, t(`imageType.${type}`)])} onChange={set('imageType')} />
      </Section>
      <Section title={t('section.mounts')}>
        <Choice label={t('field.code')} value={draft.code} empty={t('field.none')}
          options={sourcesOf(overview, 'code').map(source => [source, source])} onChange={set('code')} />
        {text('ref', 'field.ref')}
        <Choice label={t('field.output')} value={draft.output} empty={t('field.none')}
          options={sourcesOf(overview, 'output').map(source => [source, source])} onChange={set('output')} />
        <div className={css.wideField} role="group" aria-label={t('field.data')}>
          <span className={css.label}>{t('field.data')}</span>
          {dataSources.length === 0 && draft.data.length === 0
            ? <span className={css.hint}>{t('field.noSources')}</span>
            : (
              <span className={css.checks}>
                {[...new Set([...dataSources, ...draft.data])].map(source => (
                  <Checkbox key={source} label={source} checked={draft.data.includes(source)}
                    onChange={(checked) => { set('data')(checked ? [...draft.data, source] : draft.data.filter(item => item !== source)) }} />
                ))}
              </span>
            )}
        </div>
      </Section>
      <Section title={t('section.storage')}>
        <Choice label={t('field.storage')} value={draft.storage} empty={t('field.none')}
          options={sourcesOf(overview, 'storage').map(source => [source, source])} onChange={set('storage')} />
        <p className={css.wideField}><span className={css.hint}>{t('field.storageHint')}</span></p>
        {lines('repos', 'field.repos')}
        {lines('packages', 'field.packages')}
      </Section>
      <Section title={t('section.resources')}>
        {text('workspace', 'field.workspace')}
        <Choice label={t('field.queue')} value={draft.queueId} empty={t('field.queueDefault')}
          options={queues.map(entry => [entry.id, t('field.queueOption', { queue: entry.queue, cluster: entry.cluster })])} onChange={set('queueId')} />
        <Choice label={t('field.machineType')} value={draft.machineType} empty={t('field.machineTypeNone')}
          options={machineTypes.map(code => [code, code])} onChange={set('machineType')} />
        {count('podCount')}
        {count('gpuCount')}
        {count('cpuCount')}
        {count('memoryGib')}
        {count('shmSizeGib')}
        <Choice label={t('field.priority')} value={draft.priority} empty={t('field.default')}
          options={PRIORITIES.map(priority => [priority, t(`priority.${priority}`)])} onChange={set('priority')} />
        {shown('framework') && (
          <Choice label={t('field.framework')} value={draft.framework} empty={t('field.default')}
            options={FRAMEWORKS.map(framework => [framework, framework])} onChange={set('framework')} />
        )}
        {count('maxAttempts')}
        {shown('enableQueuing') && (
          <span className={css.wideField}>
            <Checkbox label={t('field.enableQueuing')} checked={draft.enableQueuing} onChange={set('enableQueuing')} />
          </span>
        )}
      </Section>
      <Section title={t('section.run')}>
        {text('command', 'field.command', true)}
        <Field label={t('field.env')} wide>
          <textarea className={css.textarea} rows={3} value={draft.env} aria-label={t('field.env')}
            onChange={(event) => { set('env')(event.target.value) }} />
        </Field>
      </Section>
      <div className={css.save}>
        {save.mode === 'optional' && <Checkbox label={t('save.toggle')} checked={saving} onChange={setSaving} />}
        {saving && (
          <div className={css.grid}>
            <Field label={t('save.name')}>
              <Input value={name} placeholder={t('save.namePlaceholder')} aria-label={t('save.name')}
                disabled={save.mode === 'required' && save.lockName} onChange={(event) => { setName(event.target.value) }} />
            </Field>
            <Field label={t('save.description')}>
              <Input value={description} aria-label={t('save.description')} onChange={(event) => { setDescription(event.target.value) }} />
            </Field>
          </div>
        )}
        {replacing && <p className={css.hint}>{t('save.replaceHint')}</p>}
      </div>
      {failure !== null && <p className={css.failure} role="alert">{failure}</p>}
      <div className={css.actions}>
        <Button type="submit" variant="primary" size="sm" disabled={busy}>{busy ? t(props.busyLabel) : t(props.submitLabel)}</Button>
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={props.onCancel}>{t('form.cancel')}</Button>
      </div>
    </form>
  )
}
