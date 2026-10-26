// @vitest-environment jsdom
/** The workload form registers a personal storage source in place and selects it. */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ScoAfsVolume } from '@deepseek-ai/dsh-experimental-sco/types'
import type { ScoConfigOverview } from '@deepseek-ai/dsh-experimental-sco-submit/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Loaded } from '../src/client/ConfigPage.tsx'
import { WorkloadForm, type WorkloadTranslate } from '../src/client/WorkloadForm.tsx'
import { workloadZh as zh } from '../src/client/workload-locales.ts'

afterEach(() => { cleanup() })
const t = makeTranslate(zh) as WorkloadTranslate

const empty: ScoConfigOverview = { configured: {}, saved: {}, outputMountPath: '/outputs', templates: [], sources: [], configs: [] }

function form(overview: ScoConfigOverview, volumes: Loaded<ScoAfsVolume[]>) {
  const onSubmit = vi.fn(async () => null as string | null)
  const storage = { saveSource: vi.fn(async () => null as string | null), loadVolumes: vi.fn(async () => volumes) }
  render(<WorkloadForm kind="job" heading="h" initial={{}} overview={overview} save={{ mode: 'optional', name: '' }}
    submitLabel="form.confirm" busyLabel="form.confirming" onSubmit={onSubmit} onCancel={() => {}} storage={storage} t={t} />)
  return { onSubmit, storage }
}

const field = (label: string) => screen.getByLabelText<HTMLInputElement & HTMLSelectElement>(label)
const change = (label: string, value: string) => { fireEvent.change(field(label), { target: { value } }) }

describe('StorageAdder', () => {
  it('registers a storage source on a listed volume and selects it for the job', async () => {
    const b = form(empty, { ok: true, value: [{ id: 'vol-a' }] })
    expect(screen.getByText(zh['storage.none'])).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh['storage.add'] }))
    fireEvent.focus(field(zh['storage.volume']))
    await waitFor(() => { expect(within(field(zh['storage.volume'])).getAllByRole('option').map(option => option.textContent)).toEqual([zh['storage.volumeChoose'], 'vol-a']) })
    fireEvent.focus(field(zh['storage.volume']))
    expect(b.storage.loadVolumes).toHaveBeenCalledTimes(1)
    change(zh['storage.volume'], 'vol-a')
    change(zh['storage.name'], ' home ')
    change(zh['storage.path'], ' users/me ')
    b.storage.saveSource.mockResolvedValueOnce('name taken')
    fireEvent.click(screen.getByRole('button', { name: zh['storage.save'] }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('操作失败：name taken') })
    fireEvent.click(screen.getByRole('button', { name: zh['storage.save'] }))
    await waitFor(() => { expect(field(zh['field.storage']).value).toBe('home') })
    expect(b.storage.saveSource).toHaveBeenLastCalledWith({
      name: 'home',
      source: { kind: 'storage', volume: { type: 'afs', id: 'vol-a' }, path: 'users/me', mountPath: '/personal', reposDir: 'repos', packagesDir: 'packages' },
    })
    expect(screen.queryByRole('group', { name: zh['storage.title'] })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: zh['form.confirm'] }))
    await waitFor(() => { expect(b.onSubmit).toHaveBeenCalledWith({ spec: { storage: 'home' } }) })
  })

  it('takes a typed volume when the volume list fails, and cancels', async () => {
    const b = form(empty, { ok: false, message: 'denied' })
    fireEvent.click(screen.getByRole('button', { name: zh['storage.add'] }))
    fireEvent.focus(field(zh['storage.volume']))
    await waitFor(() => { expect(screen.getByText('读不到卷列表，请直接填写卷 ID：denied')).toBeTruthy() })
    change(zh['storage.volume'], 'vol-b')
    change(zh['storage.path'], '')
    fireEvent.click(screen.getByRole('button', { name: zh['storage.save'] }))
    await waitFor(() => { expect(b.storage.saveSource).toHaveBeenCalled() })
    expect(b.storage.saveSource.mock.lastCall?.[0]).toEqual({
      name: 'personal', source: { kind: 'storage', volume: { type: 'afs', id: 'vol-b' }, mountPath: '/personal', reposDir: 'repos', packagesDir: 'packages' },
    })
    fireEvent.click(screen.getByRole('button', { name: zh['storage.add'] }))
    fireEvent.click(within(screen.getByRole('group', { name: zh['storage.title'] })).getByRole('button', { name: zh['form.cancel'] }))
    expect(screen.queryByRole('group', { name: zh['storage.title'] })).toBeNull()
  })

  it('offers registration without the missing-storage notice when one is registered', () => {
    form({ ...empty, sources: [{ name: 'home', source: { kind: 'storage', volume: { type: 'afs', id: 'v' }, mountPath: '/p', reposDir: 'r', packagesDir: 'k' } }] }, { ok: true, value: [] })
    expect(screen.queryByText(zh['storage.none'])).toBeNull()
    expect(screen.getByRole('button', { name: zh['storage.add'] })).toBeTruthy()
  })
})
