/** In-form registration of a personal storage source, for users who did not register one on the Cluster settings page. */
import { useState } from 'react'
import { Button, IconPlusOutlineRegular, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ScoAfsVolume } from '@deepseek-ai/dsh-experimental-sco/types'
import type { ScoSourceSaveRequest } from '@deepseek-ai/dsh-experimental-sco-submit/types'
import type { Loaded } from './ConfigPage.tsx'
import type { ClusterWorkloadKey } from './workload-locales.ts'
import type { WorkloadTranslate } from './WorkloadForm.tsx'
import css from './WorkloadForm.module.css'

/** Host actions that register a storage source from the workload form. */
export interface StorageActions {
  /** Register a source; resolves to a failure message or null. */
  readonly saveSource: (request: ScoSourceSaveRequest) => Promise<string | null>
  /** List the AFS volumes the sco credentials can see. */
  readonly loadVolumes: () => Promise<Loaded<ScoAfsVolume[]>>
}

type Draft = { name: string; volumeId: string; path: string; mountPath: string; reposDir: string; packagesDir: string }

const EMPTY: Draft = { name: 'personal', volumeId: '', path: '', mountPath: '/personal', reposDir: 'repos', packagesDir: 'packages' }

/**
 * Render the button that opens storage registration and, once opened, its fields.
 * The fields sit inside the workload form, so saving is a button action rather than a nested form submission.
 * @param props - whether a storage source exists, Host actions, the callback receiving the registered name, and dictionary.
 * @returns the registration control.
 */
export function StorageAdder({ registered, actions, onAdded, t }: {
  registered: boolean
  actions: StorageActions
  onAdded: (name: string) => void
  t: WorkloadTranslate
}) {
  const [draft, setDraft] = useState<Draft | null>(null)
  const [volumes, setVolumes] = useState<Loaded<ScoAfsVolume[]> | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  if (draft === null) {
    return (
      <p className={css.wideField}>
        <span className={css.hint}>
          {!registered && t('storage.none')}
          <Button type="button" size="sm" variant="outline" icon={<IconPlusOutlineRegular size={16} />} onClick={() => { setDraft(EMPTY) }}>
            {t('storage.add')}
          </Button>
        </span>
      </p>
    )
  }
  const set = (key: keyof Draft) => (value: string) => { setDraft({ ...draft, [key]: value }) }
  const load = () => {
    if (loading || volumes?.ok === true) return
    setLoading(true)
    void actions.loadVolumes().then((result) => { setVolumes(result); setLoading(false) })
  }
  const text = (key: keyof Draft, label: ClusterWorkloadKey) => (
    <label className={css.field}>
      <span className={css.label}>{t(label)}</span>
      <Input value={draft[key]} aria-label={t(label)} onChange={(event) => { set(key)(event.target.value) }} />
    </label>
  )
  const save = async () => {
    const name = draft.name.trim()
    const path = draft.path.trim()
    setBusy(true)
    const message = await actions.saveSource({
      name,
      source: {
        kind: 'storage', volume: { type: 'afs', id: draft.volumeId.trim() }, mountPath: draft.mountPath.trim(),
        reposDir: draft.reposDir.trim(), packagesDir: draft.packagesDir.trim(), ...path === '' ? {} : { path },
      },
    })
    setBusy(false)
    setFailure(message === null ? null : t('action.failed', { message }))
    if (message === null) { setDraft(null); onAdded(name) }
  }
  const listed = volumes?.ok === true ? volumes.value : []
  return (
    <div className={css.wideField} role="group" aria-label={t('storage.title')}>
      <span className={css.label}>{t('storage.title')}</span>
      <div className={css.grid}>
        {text('name', 'storage.name')}
        {volumes?.ok === false
          ? text('volumeId', 'storage.volume')
          : (
            <label className={css.field}>
              <span className={css.label}>{t('storage.volume')}</span>
              <select className={css.select} value={draft.volumeId} aria-label={t('storage.volume')}
                onFocus={load} onChange={(event) => { set('volumeId')(event.target.value) }}>
                <option value="">{loading ? t('storage.volumeLoading') : t('storage.volumeChoose')}</option>
                {listed.map(volume => <option key={volume.id} value={volume.id}>{volume.id}</option>)}
              </select>
            </label>
          )}
        {text('path', 'storage.path')}
        {text('mountPath', 'storage.mountPath')}
        {text('reposDir', 'storage.reposDir')}
        {text('packagesDir', 'storage.packagesDir')}
      </div>
      {volumes?.ok === false && <p className={css.hint}>{t('storage.volumeFailed', { message: volumes.message })}</p>}
      {failure !== null && <p className={css.failure} role="alert">{failure}</p>}
      <span className={css.actions}>
        <Button type="button" variant="primary" size="sm" disabled={busy} onClick={() => { void save() }}>
          {busy ? t('form.saving') : t('storage.save')}
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => { setDraft(null); setFailure(null) }}>{t('form.cancel')}</Button>
      </span>
    </div>
  )
}
