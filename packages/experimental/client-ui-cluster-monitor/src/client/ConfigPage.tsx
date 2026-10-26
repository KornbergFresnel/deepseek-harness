/** The Cluster configuration page: gateway defaults, editable sources, templates, cached queue options, and AFS volumes. */
import { useState, type FormEvent, type ReactNode } from 'react'
import { Button, IconEditOutlineRegular, IconPlusOutlineRegular, IconRefreshOutlineRegular, IconTrashOutlineRegular, Input, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { ScoAfsVolume, ScoDefaults } from '@deepseek-ai/dsh-experimental-sco/types'
import type {
  ScoConfigOverview, ScoJobTemplate, ScoSource, ScoSourceSaveRequest,
} from '@deepseek-ai/dsh-experimental-sco-submit/types'
import type { Mirror } from './source.ts'
import css from './ConfigPage.module.css'

/** Outcome of a Host read: the value, or the failure message. */
export type Loaded<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string }

/** Host mirror and actions the page receives from its registration. */
export interface ConfigPageInjected {
  readonly hooks: { readonly overview: HostObservable<Mirror<ScoConfigOverview>> }
  /** Register or replace a source; resolves to a failure message or null. */
  readonly saveSource: (request: ScoSourceSaveRequest) => Promise<string | null>
  /** Remove a source; resolves to a failure message or null. */
  readonly deleteSource: (name: string) => Promise<string | null>
  /** Save the default workspace and queue; resolves to a failure message or null. */
  readonly saveDefaults: (defaults: ScoDefaults) => Promise<string | null>
  /** Query the default workspace's queues again; resolves to a failure message or null. */
  readonly refreshOptions: () => Promise<string | null>
  /** List the AFS volumes the sco credentials can see. */
  readonly loadVolumes: () => Promise<Loaded<ScoAfsVolume[]>>
}

/** Page props derived from the `main` seat, the injected face, and the plugin dictionary. */
export type ConfigPageProps = PropsRuntime<'main'> & InjectFace<ConfigPageInjected> & PropsLocale<'cluster.config'>

type Translate = ConfigPageProps['t']
type Kind = ScoSource['kind']

const KINDS: readonly Kind[] = ['code', 'data', 'output', 'storage']

/** Editable form fields; every value is a string so inputs stay controlled. */
type Draft = {
  name: string
  kind: Kind
  volumeType: 'afs' | 'aoss'
  volumeId: string
  bucket: string
  endpoint: string
  path: string
  root: string
  mountPath: string
  defaultRef: string
  setup: string
  reposDir: string
  packagesDir: string
  description: string
}

const EMPTY: Draft = {
  name: '', kind: 'code', volumeType: 'afs', volumeId: '', bucket: '', endpoint: '',
  path: '', root: '', mountPath: '', defaultRef: 'main', setup: '', reposDir: 'repos', packagesDir: 'packages', description: '',
}

/**
 * Fill a form from a registered source.
 * @param name - source name.
 * @param source - registered source.
 * @returns the form fields.
 */
export function draftOf(name: string, source: ScoSource): Draft {
  const volume = source.volume.type === 'afs'
    ? { volumeType: 'afs' as const, volumeId: source.volume.id }
    : { volumeType: 'aoss' as const, bucket: source.volume.bucket, endpoint: source.volume.endpoint }
  const common = { ...EMPTY, name, kind: source.kind, ...volume, description: source.description ?? '' }
  switch (source.kind) {
    case 'data': return { ...common, path: source.path ?? '', mountPath: source.mountPath }
    case 'code': return { ...common, root: source.root, mountPath: source.mountPath, defaultRef: source.defaultRef, setup: source.setup ?? '' }
    case 'output': return { ...common, root: source.root }
    case 'storage':
      return { ...common, path: source.path ?? '', mountPath: source.mountPath, reposDir: source.reposDir, packagesDir: source.packagesDir }
  }
}

/**
 * Build the source a form describes; blank optional fields are omitted and required ones are left for the Host to reject.
 * @param draft - form fields.
 * @returns the source to save.
 */
export function sourceOf(draft: Draft): ScoSource {
  const trim = (value: string) => value.trim()
  const optional = <K extends string>(key: K, value: string): Partial<Record<K, string>> =>
    (trim(value) === '' ? {} : { [key]: trim(value) } as Record<K, string>)
  const volume = draft.volumeType === 'afs'
    ? { type: 'afs' as const, id: trim(draft.volumeId) }
    : { type: 'aoss' as const, bucket: trim(draft.bucket), endpoint: trim(draft.endpoint) }
  const description = optional('description', draft.description)
  switch (draft.kind) {
    case 'data': return { kind: 'data', volume, mountPath: trim(draft.mountPath), ...optional('path', draft.path), ...description }
    case 'code':
      return {
        kind: 'code', volume, root: trim(draft.root), mountPath: trim(draft.mountPath), defaultRef: trim(draft.defaultRef),
        ...optional('setup', draft.setup), ...description,
      }
    case 'output': return { kind: 'output', volume, root: trim(draft.root), ...description }
    case 'storage':
      return {
        kind: 'storage', volume, mountPath: trim(draft.mountPath), reposDir: trim(draft.reposDir), packagesDir: trim(draft.packagesDir),
        ...optional('path', draft.path), ...description,
      }
  }
}

function time(value: string): string {
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? value : new Date(parsed).toLocaleString()
}

function Section({ title, hint, actions, children }: { title: string; hint?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className={css.section} aria-label={title}>
      <header className={css.sectionHeading}>
        <h2>{title}</h2>
        <span className={css.spacer} />
        {actions}
      </header>
      {hint !== undefined && <p className={css.muted}>{hint}</p>}
      {children}
    </section>
  )
}

function Facts({ facts }: { facts: readonly (readonly [string, string])[] }) {
  return (
    <dl className={css.facts}>
      {facts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
    </dl>
  )
}

function volumeText(source: ScoSource): string {
  return source.volume.type === 'afs' ? source.volume.id : `${source.volume.bucket} @ ${source.volume.endpoint}`
}

/** Volume directories are stored without a leading `/`; show them the way `--volume-mount` names them. */
function dir(value: string): string {
  return `/${value}`
}

function sourceFacts(source: ScoSource, t: Translate): [string, string][] {
  const facts: [string, string][] = [[t('source.volume'), volumeText(source)]]
  switch (source.kind) {
    case 'data':
      facts.push([t('source.path'), source.path === undefined ? t('source.volumeRoot') : dir(source.path)], [t('source.mountPath'), source.mountPath])
      break
    case 'code':
      facts.push([t('source.root'), dir(source.root)], [t('source.mountPath'), source.mountPath], [t('source.defaultRef'), source.defaultRef])
      if (source.setup !== undefined) facts.push([t('source.setup'), source.setup])
      break
    case 'output':
      facts.push([t('source.root'), dir(source.root)])
      break
    case 'storage':
      facts.push(
        [t('source.path'), source.path === undefined ? t('source.volumeRoot') : dir(source.path)], [t('source.mountPath'), source.mountPath],
        [t('source.reposDir'), `${source.mountPath}/${source.reposDir}`], [t('source.packagesDir'), `${source.mountPath}/${source.packagesDir}`],
      )
      break
  }
  return facts
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className={css.field}>{label}{children}</label>
}

/** Lazily loaded volume list shared by the volume section and the source form. */
type VolumeState = { loading: boolean; result: Loaded<ScoAfsVolume[]> | null; load: () => void }

function SourceForm({ initial, editing, volumes, save, cancel, t }: {
  initial: Draft
  editing: boolean
  volumes: VolumeState
  save: (request: ScoSourceSaveRequest) => Promise<string | null>
  cancel: () => void
  t: Translate
}) {
  const [draft, setDraft] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const set = (key: keyof Draft) => (value: string) => { setDraft(current => ({ ...current, [key]: value })) }
  const text = (key: keyof Draft, label: string, placeholder?: string) => (
    <Field label={label}>
      <Input value={draft[key]} aria-label={label} placeholder={placeholder} disabled={key === 'name' && editing}
        onChange={(event) => { set(key)(event.target.value) }} />
    </Field>
  )
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    const message = await save({ name: draft.name.trim(), source: sourceOf(draft), ...editing ? { replace: true } : {} })
    setBusy(false)
    setFailure(message)
    if (message === null) cancel()
  }
  const listed = volumes.result?.ok === true ? volumes.result.value : []
  const known = listed.some(volume => volume.id === draft.volumeId)
  return (
    <form className={css.form} onSubmit={(event) => { void submit(event) }}>
      <h3>{editing ? t('form.editTitle', { name: draft.name }) : t('form.addTitle')}</h3>
      {text('name', t('field.name'), t('field.namePlaceholder'))}
      <Field label={t('field.kind')}>
        <select className={css.select} value={draft.kind} aria-label={t('field.kind')} onChange={(event) => { set('kind')(event.target.value) }}>
          {KINDS.map(kind => <option key={kind} value={kind}>{t(`kind.${kind}`)}</option>)}
        </select>
      </Field>
      <Field label={t('field.volumeType')}>
        <select className={css.select} value={draft.volumeType} aria-label={t('field.volumeType')}
          onChange={(event) => { set('volumeType')(event.target.value) }}>
          <option value="afs">{t('volumeType.afs')}</option>
          <option value="aoss">{t('volumeType.aoss')}</option>
        </select>
      </Field>
      {draft.volumeType === 'afs'
        ? (
          <Field label={t('field.volume')}>
            <select className={css.select} value={draft.volumeId} aria-label={t('field.volume')}
              onFocus={volumes.load} onChange={(event) => { set('volumeId')(event.target.value) }}>
              <option value="">{volumes.loading ? t('field.volumeLoading') : t('field.volumeChoose')}</option>
              {!known && draft.volumeId !== '' && <option value={draft.volumeId}>{draft.volumeId}</option>}
              {listed.map(volume => (
                <option key={volume.id} value={volume.id}>
                  {t('field.volumeOption', { id: volume.id, used: volume.usedCapacity ?? '?', total: volume.totalCapacity ?? '?' })}
                </option>
              ))}
            </select>
          </Field>
        )
        : <>{text('bucket', t('field.bucket'))}{text('endpoint', t('field.endpoint'))}</>}
      {(draft.kind === 'data' || draft.kind === 'storage') && text('path', t('field.path'))}
      {(draft.kind === 'code' || draft.kind === 'output') && text('root', t(draft.kind === 'code' ? 'field.rootCode' : 'field.rootOutput'))}
      {draft.kind !== 'output' && text('mountPath', t(draft.kind === 'storage' ? 'field.mountPathStorage' : 'field.mountPath'))}
      {draft.kind === 'code' && <>{text('defaultRef', t('field.defaultRef'))}{text('setup', t('field.setup'))}</>}
      {draft.kind === 'storage' && <>{text('reposDir', t('field.reposDir'))}{text('packagesDir', t('field.packagesDir'))}</>}
      {text('description', t('field.description'))}
      {volumes.result?.ok === false && <p className={css.notice}>{t('action.failed', { message: volumes.result.message })}</p>}
      {failure !== null && <p className={css.notice} role="alert">{t('action.failed', { message: failure })}</p>}
      <div className={css.formActions}>
        <Button type="submit" variant="primary" size="sm" disabled={busy}>{busy ? t('form.saving') : t('form.save')}</Button>
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={cancel}>{t('form.cancel')}</Button>
      </div>
    </form>
  )
}

function SourceCard({ name, source, edit, remove, t }: {
  name: string
  source: ScoSource
  edit: () => void
  remove: (name: string) => Promise<string | null>
  t: Translate
}) {
  const [confirming, setConfirming] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  return (
    <li className={css.card}>
      <div className={css.cardHeading}>
        <span>{name}</span>
        <Tag tone="outline">{t(`kind.${source.kind}`)}</Tag>
        <span className={css.spacer} />
        <Button size="sm" variant="outline" icon={<IconEditOutlineRegular size={16} />} onClick={edit}>{t('sources.edit')}</Button>
        <Button size="sm" variant={confirming ? 'primary' : 'outline'} icon={<IconTrashOutlineRegular size={16} />}
          onClick={() => {
            if (!confirming) { setConfirming(true); return }
            void remove(name).then(setFailure)
          }}>
          {confirming ? t('sources.removeConfirm') : t('sources.remove')}
        </Button>
      </div>
      {source.description !== undefined && <p className={css.muted}>{source.description}</p>}
      <Facts facts={sourceFacts(source, t)} />
      {failure !== null && <p className={css.notice} role="alert">{t('action.failed', { message: failure })}</p>}
    </li>
  )
}

function SourcesSection({ overview, props, volumes }: { overview: ScoConfigOverview; props: ConfigPageProps; volumes: VolumeState }) {
  const { saveSource, deleteSource, t } = props
  const [form, setForm] = useState<{ draft: Draft; editing: boolean } | null>(null)
  return (
    <Section title={t('sources.title')} hint={t('sources.hint')}
      actions={form === null && (
        <Button size="sm" variant="outline" icon={<IconPlusOutlineRegular size={16} />}
          onClick={() => { setForm({ draft: EMPTY, editing: false }) }}>
          {t('sources.add')}
        </Button>
      )}>
      {form !== null && (
        <SourceForm key={form.draft.name} initial={form.draft} editing={form.editing} volumes={volumes} save={saveSource}
          cancel={() => { setForm(null) }} t={t} />
      )}
      {overview.sources.length === 0
        ? <p className={css.notice}>{t('sources.empty')}</p>
        : (
          <ul className={css.cards}>
            {overview.sources.map(({ name, source }) => (
              <SourceCard key={name} name={name} source={source} remove={deleteSource} t={t}
                edit={() => { setForm({ draft: draftOf(name, source), editing: true }) }} />
            ))}
          </ul>
        )}
    </Section>
  )
}

function DefaultsSection({ overview, save, t }: {
  overview: ScoConfigOverview
  save: (defaults: ScoDefaults) => Promise<string | null>
  t: Translate
}) {
  const [workspace, setWorkspace] = useState(overview.saved.workspace ?? '')
  const [queueId, setQueueId] = useState(overview.saved.queueId ?? '')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const fallback = (value: string | undefined) => t('basics.fallback', { value: value ?? t('basics.cliDefault') })
  const queues = overview.options?.queues ?? []
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    const message = await save({ workspace, queueId })
    setBusy(false)
    setFailure(message)
  }
  return (
    <Section title={t('basics.title')} hint={t('basics.hint')}>
      <Facts facts={[
        [t('basics.profile'), overview.profile ?? t('basics.cliDefault')],
        [t('basics.outputMountPath'), overview.outputMountPath],
      ]} />
      <form className={css.form} onSubmit={(event) => { void submit(event) }}>
        <Field label={t('basics.workspace')}>
          <Input value={workspace} aria-label={t('basics.workspace')} placeholder={fallback(overview.configured.workspace)}
            onChange={(event) => { setWorkspace(event.target.value) }} />
        </Field>
        <Field label={t('basics.queue')}>
          {queues.length === 0
            ? (
              <Input value={queueId} aria-label={t('basics.queue')} placeholder={fallback(overview.configured.queueId)}
                onChange={(event) => { setQueueId(event.target.value) }} />
            )
            : (
              <select className={css.select} value={queueId} aria-label={t('basics.queue')} onChange={(event) => { setQueueId(event.target.value) }}>
                <option value="">{fallback(overview.configured.queueId)}</option>
                {queueId !== '' && !queues.some(queue => queue.id === queueId) && <option value={queueId}>{queueId}</option>}
                {queues.map(queue => <option key={queue.id} value={queue.id}>{t('basics.queueOption', { queue: queue.queue, cluster: queue.cluster })}</option>)}
              </select>
            )}
        </Field>
        <p className={css.muted}>
          {t('basics.effective', { workspace: overview.workspace ?? t('basics.cliDefault'), queue: overview.queueId ?? t('basics.cliDefault') })}
        </p>
        {failure !== null && <p className={css.notice} role="alert">{t('action.failed', { message: failure })}</p>}
        <div className={css.formActions}>
          <Button type="submit" variant="primary" size="sm" disabled={busy}>{busy ? t('basics.saving') : t('basics.save')}</Button>
        </div>
      </form>
    </Section>
  )
}

function templateFacts(template: ScoJobTemplate, t: Translate): [string, string][] {
  const facts: [string, string | undefined][] = [
    [t('template.image'), template.image],
    [t('template.code'), template.code === undefined ? undefined : `${template.code}${template.ref === undefined ? '' : ` @ ${template.ref}`}`],
    [t('template.data'), template.data?.join(', ')],
    [t('template.output'), template.output],
    [t('template.command'), template.command],
    [t('template.resources'), template.gpuCount === undefined && template.podCount === undefined
      ? undefined
      : t('template.resourceValue', { pods: template.podCount ?? 1, gpus: template.gpuCount ?? 0 })],
  ]
  return facts.flatMap(([label, value]) => value === undefined || value === '' ? [] : [[label, value]])
}

function OptionsSection({ overview, refresh, t }: { overview: ScoConfigOverview; refresh: () => Promise<string | null>; t: Translate }) {
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const options = overview.options
  return (
    <Section title={t('options.title')} hint={t('options.hint')}
      actions={overview.workspace !== undefined && (
        <Button size="sm" variant="outline" disabled={busy} icon={<IconRefreshOutlineRegular size={16} />}
          onClick={() => {
            setBusy(true)
            void refresh().then((message) => { setBusy(false); setFailure(message) })
          }}>
          {busy ? t('options.refreshing') : t('options.refresh')}
        </Button>
      )}>
      {failure !== null && <p className={css.notice} role="alert">{t('action.failed', { message: failure })}</p>}
      {overview.workspace === undefined
        ? <p className={css.notice}>{t('options.noWorkspace')}</p>
        : options === undefined
          ? <p className={css.notice}>{t('options.empty')}</p>
          : (
            <>
              <p className={css.notice}>{t('options.fetchedAt', { workspace: options.workspace, time: time(options.fetchedAt) })}</p>
              <table className={css.table}>
                <thead><tr><th>{t('options.queue')}</th><th>{t('options.cluster')}</th><th>{t('options.machineTypes')}</th></tr></thead>
                <tbody>
                  {options.queues.map(queue => (
                    <tr key={queue.id}>
                      <td>{queue.queue}</td>
                      <td>{queue.cluster}</td>
                      <td>
                        {queue.machineTypes.length > 0
                          ? <span className={css.codes}>{queue.machineTypes.map(code => <Tag key={code} tone="info">{code}</Tag>)}</span>
                          : (
                            <details>
                              <summary>{t('options.noMachineTypes')}</summary>
                              <pre className={css.raw}>{JSON.stringify(queue.detail, null, 2)}</pre>
                            </details>
                          )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
    </Section>
  )
}

function VolumesSection({ volumes, t }: { volumes: VolumeState; t: Translate }) {
  const result = volumes.result
  return (
    <Section title={t('volumes.title')} hint={t('volumes.hint')}
      actions={(
        <Button size="sm" variant="outline" disabled={volumes.loading} icon={<IconRefreshOutlineRegular size={16} />} onClick={volumes.load}>
          {volumes.loading ? t('volumes.loading') : t('volumes.load')}
        </Button>
      )}>
      {result?.ok === false && <p className={css.notice} role="alert">{t('action.failed', { message: result.message })}</p>}
      {result?.ok === true && (result.value.length === 0
        ? <p className={css.notice}>{t('volumes.empty')}</p>
        : (
          <table className={css.table}>
            <thead>
              <tr>
                <th>{t('volumes.id')}</th><th>{t('volumes.capacity')}</th><th>{t('volumes.usage')}</th>
                <th>{t('volumes.state')}</th><th>{t('volumes.endTime')}</th>
              </tr>
            </thead>
            <tbody>
              {result.value.map(volume => (
                <tr key={volume.id}>
                  <td>{volume.name === undefined ? volume.id : `${volume.name} (${volume.id})`}</td>
                  <td>{`${volume.usedCapacity ?? '—'} / ${volume.totalCapacity ?? '—'}`}</td>
                  <td>{volume.usedPercent === undefined ? '—' : `${volume.usedPercent}%`}</td>
                  <td>{volume.state ?? '—'}</td>
                  <td>{volume.endTime ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
    </Section>
  )
}

/**
 * Render the configuration sections from the Host overview mirror.
 * @param props - overview mirror, actions, and dictionary.
 * @returns the page.
 */
export function ConfigPage(props: ConfigPageProps) {
  const { useOverview, loadVolumes, refreshOptions, t } = props
  const mirror = useOverview(snapshot => snapshot)
  const [volumeResult, setVolumeResult] = useState<Loaded<ScoAfsVolume[]> | null>(null)
  const [loading, setLoading] = useState(false)
  const volumes: VolumeState = {
    loading,
    result: volumeResult,
    load: () => {
      if (loading) return
      setLoading(true)
      void loadVolumes().then((result) => { setVolumeResult(result); setLoading(false) })
    },
  }
  const overview = mirror.value
  return (
    <div className={css.page}>
      <div className={css.content}>
        <h1>{t('page.title')}</h1>
        <p className={css.muted}>{t('page.subtitle')}</p>
        {!mirror.connected && mirror.error !== null && <p className={css.notice}>{t('page.disconnected')}</p>}
        {overview === null
          ? <p className={css.notice}>{t('page.loading')}</p>
          : (
            <>
              <DefaultsSection key={JSON.stringify(overview.saved)} overview={overview} save={props.saveDefaults} t={t} />
              <SourcesSection overview={overview} props={props} volumes={volumes} />
              <Section title={t('templates.title')} hint={t('templates.hint')}>
                {overview.templates.length === 0
                  ? <p className={css.notice}>{t('templates.empty')}</p>
                  : (
                    <ul className={css.cards}>
                      {overview.templates.map(({ name, template }) => (
                        <li key={name} className={css.card}>
                          <div className={css.cardHeading}>{name}</div>
                          {template.description !== undefined && <p className={css.muted}>{template.description}</p>}
                          <Facts facts={templateFacts(template, t)} />
                        </li>
                      ))}
                    </ul>
                  )}
              </Section>
              <OptionsSection overview={overview} refresh={refreshOptions} t={t} />
              <VolumesSection volumes={volumes} t={t} />
            </>
          )}
      </div>
    </div>
  )
}
