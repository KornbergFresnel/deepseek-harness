/** The Job configurations page: saved workload configurations beside the selected one's settings, with create, edit, and delete. */
import { useState } from 'react'
import { Button, IconEditOutlineRegular, IconPlusOutlineRegular, IconTrashOutlineRegular, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { ScoConfigOverview, ScoConfigSaveRequest, ScoSavedConfig, ScoWorkloadKind } from '@deepseek-ai/dsh-experimental-sco-submit/types'
import type { Mirror } from './source.ts'
import type { StorageActions } from './StorageAdder.tsx'
import { specFacts } from './workload.ts'
import { WorkloadForm, type WorkloadTranslate } from './WorkloadForm.tsx'
import css from './SavedConfigsPage.module.css'

/** Host mirror and actions the page receives from its registration. */
export interface SavedConfigsInjected {
  readonly hooks: { readonly overview: HostObservable<Mirror<ScoConfigOverview>> }
  /** Save a configuration; resolves to a failure message or null. */
  readonly saveConfig: (request: ScoConfigSaveRequest) => Promise<string | null>
  /** Delete a configuration; resolves to a failure message or null. */
  readonly deleteConfig: (name: string) => Promise<string | null>
  /** Register a personal storage source from the form. */
  readonly storage: StorageActions
}

/** Page props derived from the `main` seat, the injected face, and the plugin dictionary. */
export type SavedConfigsPageProps = PropsRuntime<'main'> & InjectFace<SavedConfigsInjected> & PropsLocale<'cluster.workload'>

const KINDS: readonly ScoWorkloadKind[] = ['job', 'devmachine']

function time(value: string): string {
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? value : new Date(parsed).toLocaleString()
}

/** What the detail pane shows: one configuration, its editor, or a new configuration's editor. */
type Pane = { readonly kind: 'view'; readonly name: string } | { readonly kind: 'edit'; readonly name: string } | { readonly kind: 'new'; readonly workload: ScoWorkloadKind }

function Detail({ name, config, edit, remove, t }: {
  name: string
  config: ScoSavedConfig
  edit: () => void
  remove: (name: string) => Promise<string | null>
  t: WorkloadTranslate
}) {
  const [confirming, setConfirming] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const facts = specFacts(config.spec)
  return (
    <section className={css.detail} aria-label={name}>
      <header className={css.detailHeading}>
        <h2>{name}</h2>
        <Tag tone="outline">{t(`kind.${config.kind}`)}</Tag>
        <span className={css.spacer} />
        <Button size="sm" variant="outline" icon={<IconEditOutlineRegular size={16} />} onClick={edit}>{t('presets.edit')}</Button>
        <Button size="sm" variant={confirming ? 'primary' : 'outline'} icon={<IconTrashOutlineRegular size={16} />}
          onClick={() => {
            if (!confirming) { setConfirming(true); return }
            void remove(name).then((message) => { setFailure(message === null ? null : t('action.failed', { message })) })
          }}>
          {confirming ? t('presets.deleteConfirm') : t('presets.delete')}
        </Button>
      </header>
      {config.description !== undefined && <p className={css.muted}>{config.description}</p>}
      <p className={css.muted}>
        {t('presets.updated', { time: time(config.updatedAt) })}
        {' · '}
        {config.lastUsedAt === undefined ? t('presets.neverUsed') : t('presets.lastUsed', { time: time(config.lastUsedAt) })}
      </p>
      {failure !== null && <p className={css.notice} role="alert">{failure}</p>}
      {facts.length === 0
        ? <p className={css.notice}>{t('presets.emptySpec')}</p>
        : (
          <dl className={css.facts}>
            {facts.map(([label, value]) => <div key={label}><dt>{t(label)}</dt><dd>{value}</dd></div>)}
          </dl>
        )}
      <details className={css.raw}>
        <summary>{t('presets.raw')}</summary>
        <pre>{JSON.stringify(config.spec, null, 2)}</pre>
      </details>
    </section>
  )
}

/**
 * Render the saved configurations, the selected one's settings, and the editor.
 * @param props - overview mirror, actions, and dictionary.
 * @returns the page.
 */
export function SavedConfigsPage({ useOverview, saveConfig, deleteConfig, storage, t }: SavedConfigsPageProps) {
  const mirror = useOverview(snapshot => snapshot)
  const overview = mirror.value
  const configs = overview?.configs ?? []
  const [pane, setPane] = useState<Pane | null>(null)
  const current = pane === null ? configs[0] : configs.find(entry => pane.kind !== 'new' && entry.name === pane.name)
  const close = (name?: string) => { setPane(name === undefined ? null : { kind: 'view', name }) }

  let detail
  if (pane?.kind === 'new') {
    detail = (
      <WorkloadForm key={`new-${pane.workload}`} kind={pane.workload} heading={t('presets.newTitle', { kind: t(`kind.${pane.workload}`) })}
        initial={{}} overview={overview} save={{ mode: 'required', name: '', description: '', lockName: false }}
        submitLabel="form.save" busyLabel="form.saving" storage={storage} t={t} onCancel={() => { close() }}
        onSubmit={async ({ spec, save }) => {
          const request: ScoConfigSaveRequest = { name: '', ...save, kind: pane.workload, spec }
          const message = await saveConfig(request)
          if (message === null) close(request.name)
          return message
        }} />
    )
  } else if (current === undefined) {
    detail = <div className={css.empty}>{t('presets.select')}</div>
  } else if (pane?.kind === 'edit') {
    detail = (
      <WorkloadForm key={`edit-${current.name}`} kind={current.config.kind} heading={t('presets.editTitle', { name: current.name })}
        initial={current.config.spec} overview={overview}
        save={{ mode: 'required', name: current.name, description: current.config.description ?? '', lockName: true }}
        submitLabel="form.save" busyLabel="form.saving" storage={storage} t={t} onCancel={() => { close(current.name) }}
        onSubmit={async ({ spec, save }) => {
          const message = await saveConfig({ ...save, name: current.name, kind: current.config.kind, spec, replace: true })
          if (message === null) close(current.name)
          return message
        }} />
    )
  } else {
    detail = <Detail key={current.name} name={current.name} config={current.config} t={t} remove={deleteConfig}
      edit={() => { setPane({ kind: 'edit', name: current.name }) }} />
  }

  return (
    <div className={css.page}>
      <aside className={css.listPane}>
        <header className={css.pageHeading}>
          <h1>{t('presets.title')}</h1>
          <p className={css.muted}>{t('presets.subtitle')}</p>
        </header>
        <div className={css.newActions}>
          {KINDS.map(kind => (
            <Button key={kind} size="sm" variant="outline" icon={<IconPlusOutlineRegular size={16} />}
              onClick={() => { setPane({ kind: 'new', workload: kind }) }}>
              {t('presets.newTitle', { kind: t(`kind.${kind}`) })}
            </Button>
          ))}
        </div>
        {!mirror.connected && mirror.error !== null && <p className={css.notice}>{t('presets.disconnected')}</p>}
        {overview === null
          ? <p className={css.muted}>{t('presets.loading')}</p>
          : configs.length === 0
            ? <p className={css.muted}>{t('presets.empty')}</p>
            : (
              <ul className={css.rows} aria-label={t('presets.aria')}>
                {configs.map(({ name, config }) => (
                  <li key={name}>
                    <button type="button" className={css.row} aria-current={pane?.kind !== 'new' && name === current?.name}
                      onClick={() => { setPane({ kind: 'view', name }) }}>
                      <span className={css.rowTop}>
                        <span className={css.rowName}>{name}</span>
                        <Tag tone="outline">{t(`kind.${config.kind}`)}</Tag>
                      </span>
                      <span className={css.rowMeta}>{config.description ?? t('presets.updated', { time: time(config.updatedAt) })}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
      </aside>
      <div className={css.detailPane}><div className={css.detailInner}>{detail}</div></div>
    </div>
  )
}
