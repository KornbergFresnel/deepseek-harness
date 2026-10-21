// @vitest-environment jsdom
/** The configuration page shows gateway defaults, edits sources, lists templates and cached options, and loads volumes on demand. */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ScoAfsVolume } from '@deepseek-ai/dsh-experimental-sco/types'
import type { ScoConfigOverview, ScoSource } from '@deepseek-ai/dsh-experimental-sco-submit/types'
import { afterEach, expect, it, vi } from 'vitest'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { ConfigIcon } from '../src/client/ConfigIcon.tsx'
import { ConfigPage, draftOf, sourceOf, type ConfigPageProps, type Loaded } from '../src/client/ConfigPage.tsx'
import type { Mirror } from '../src/client/source.ts'
import { configZh as zh } from '../src/client/config-locales.ts'

afterEach(() => { cleanup() })
const t = makeTranslate(zh)

const code: ScoSource = { kind: 'code', volume: { type: 'afs', id: 'vol-a' }, root: 'code/rlh', mountPath: '/workspace/code', defaultRef: 'main', setup: 'pip install -e .' }
const data: ScoSource = { kind: 'data', volume: { type: 'aoss', bucket: 'b', endpoint: 'e.example' }, mountPath: '/data', description: 'motion clips' }
const output: ScoSource = { kind: 'output', volume: { type: 'afs', id: 'vol-b' }, root: 'runs' }

const overview: ScoConfigOverview = {
  profile: 'team', workspace: 'ws', outputMountPath: '/workspace/output',
  sources: [{ name: 'rlh', source: code }, { name: 'clips', source: data }, { name: 'runs', source: output },
    { name: 'lib', source: { kind: 'code', volume: { type: 'afs', id: 'vol-a' }, root: 'lib', mountPath: '/lib', defaultRef: 'v1' } },
  ],
  templates: [
    { name: 'wbt', template: { description: 'tracking', image: 'img:1', code: 'rlh', ref: 'dev', data: ['clips'], output: 'runs', command: 'train', podCount: 2, gpuCount: 8 } },
    { name: 'bare', template: { code: 'rlh', gpuCount: 1 } },
    { name: 'pods', template: { podCount: 3 } },
    { name: 'empty', template: {} },
  ],
  options: {
    workspace: 'ws', fetchedAt: '2026-10-21T00:00:00.000Z',
    queues: [
      { id: 'q1', cluster: 'c1', queue: 'gpu', detail: {}, machineTypes: ['N6lS.Iu.I80.8'] },
      { id: 'q2', cluster: 'c2', queue: 'cpu', detail: { raw: 1 }, machineTypes: [] },
    ],
  },
}

const volumes: ScoAfsVolume[] = [
  { id: 'vol-a', name: 'main', totalCapacity: '51200GB', usedCapacity: '43TB', usedPercent: 86, state: 'Running', endTime: '2027' },
  { id: 'vol-c' },
]

function fixture(initial: Mirror<ScoConfigOverview>) {
  const store = createSnapshotStore(initial)
  const saveSource = vi.fn(async () => null as string | null)
  const deleteSource = vi.fn(async () => null as string | null)
  const refreshOptions = vi.fn(async () => null as string | null)
  const loadVolumes = vi.fn(async (): Promise<Loaded<ScoAfsVolume[]>> => ({ ok: true, value: volumes }))
  const props = { useOverview: bindSnapshotSelector(store), saveSource, deleteSource, refreshOptions, loadVolumes, t } as ConfigPageProps
  return { ...render(<ConfigPage {...props} />), store, saveSource, deleteSource, refreshOptions, loadVolumes }
}

const section = (title: string) => screen.getByRole('region', { name: title })

it('shows loading and disconnected states, then gateway defaults with CLI fallbacks', () => {
  const b = fixture({ value: null, connected: false, error: null })
  expect(screen.getByText(zh['page.loading'])).toBeTruthy()
  act(() => { b.store.set({ value: { outputMountPath: '/out', sources: [], templates: [] }, connected: false, error: 'lost' }) })
  expect(screen.getByText(zh['page.disconnected'])).toBeTruthy()
  expect(within(section(zh['basics.title'])).getAllByText(zh['basics.cliDefault'])).toHaveLength(3)
  expect(screen.getByText(zh['sources.empty'])).toBeTruthy()
  expect(screen.getByText(zh['templates.empty'])).toBeTruthy()
  expect(screen.getByText(zh['options.noWorkspace'])).toBeTruthy()
  expect(within(section(zh['options.title'])).queryByRole('button')).toBeNull()
  act(() => { b.store.set({ value: { workspace: 'ws', queueId: 'q1', outputMountPath: '/out', sources: [], templates: [] }, connected: true, error: null }) })
  expect(screen.getByText(zh['options.empty'])).toBeTruthy()
  expect(screen.getByText('q1')).toBeTruthy()
})

it('renders sources, templates, and cached queue options', () => {
  fixture({ value: overview, connected: true, error: null })
  const sources = section(zh['sources.title'])
  expect(within(sources).getByText('pip install -e .')).toBeTruthy()
  expect(within(sources).getByText('b @ e.example')).toBeTruthy()
  expect(within(sources).getByText('motion clips')).toBeTruthy()
  expect(within(sources).getByText(zh['source.volumeRoot'])).toBeTruthy()
  const templates = section(zh['templates.title'])
  expect(within(templates).getByText('rlh @ dev')).toBeTruthy()
  expect(within(templates).getByText('2 个 Pod，每个 8 卡')).toBeTruthy()
  expect(within(templates).getByText('1 个 Pod，每个 1 卡')).toBeTruthy()
  expect(within(templates).getByText('3 个 Pod，每个 0 卡')).toBeTruthy()
  expect(within(templates).getByText('tracking')).toBeTruthy()
  const options = section(zh['options.title'])
  expect(within(options).getByText('N6lS.Iu.I80.8')).toBeTruthy()
  expect(within(options).getByText(zh['options.noMachineTypes'])).toBeTruthy()
  expect(within(options).getByText(/"raw": 1/)).toBeTruthy()
})

it('shows an unparseable fetch time verbatim', () => {
  fixture({ value: { ...overview, options: { ...overview.options!, fetchedAt: 'yesterday' } }, connected: true, error: null })
  expect(screen.getByText('工作空间 ws，查询于 yesterday')).toBeTruthy()
})

it('refreshes queue options and reports a failure', async () => {
  const b = fixture({ value: overview, connected: true, error: null })
  b.refreshOptions.mockResolvedValueOnce('quota')
  fireEvent.click(screen.getByRole('button', { name: zh['options.refresh'] }))
  expect(screen.getByRole('button', { name: zh['options.refreshing'] })).toBeTruthy()
  await screen.findByText('操作失败：quota')
  fireEvent.click(screen.getByRole('button', { name: zh['options.refresh'] }))
  await waitFor(() => { expect(screen.queryByText('操作失败：quota')).toBeNull() })
  expect(b.refreshOptions).toHaveBeenCalledTimes(2)
})

it('loads volumes once at a time and renders usage, missing fields, empty lists, and failures', async () => {
  const b = fixture({ value: overview, connected: true, error: null })
  const area = section(zh['volumes.title'])
  fireEvent.click(within(area).getByRole('button', { name: zh['volumes.load'] }))
  fireEvent.click(within(area).getByRole('button', { name: zh['volumes.loading'] }))
  await waitFor(() => { expect(within(area).getByText('86%')).toBeTruthy() })
  expect(within(area).getByText('main (vol-a)')).toBeTruthy()
  expect(b.loadVolumes).toHaveBeenCalledOnce()
  expect(within(area).getByText('43TB / 51200GB')).toBeTruthy()
  expect(within(area).getByText('— / —')).toBeTruthy()
  b.loadVolumes.mockResolvedValueOnce({ ok: true, value: [] })
  fireEvent.click(within(area).getByRole('button', { name: zh['volumes.load'] }))
  await within(area).findByText(zh['volumes.empty'])
  b.loadVolumes.mockResolvedValueOnce({ ok: false, message: 'no credentials' })
  fireEvent.click(within(area).getByRole('button', { name: zh['volumes.load'] }))
  await within(area).findByText('操作失败：no credentials')
})

it('adds an AFS code source chosen from the loaded volumes and closes the form on success', async () => {
  const b = fixture({ value: overview, connected: true, error: null })
  fireEvent.click(screen.getByRole('button', { name: zh['sources.add'] }))
  expect(screen.queryByRole('button', { name: zh['sources.add'] })).toBeNull()
  const volume = screen.getByLabelText<HTMLSelectElement>(zh['field.volume'])
  fireEvent.focusIn(volume)
  fireEvent.focusIn(volume)
  expect(within(volume).getByText(zh['field.volumeLoading'])).toBeTruthy()
  await within(volume).findByText('vol-a（已用 43TB / 51200GB）')
  expect(within(volume).getByText('vol-c（已用 ? / ?）')).toBeTruthy()
  expect(b.loadVolumes).toHaveBeenCalledOnce()
  fireEvent.change(screen.getByLabelText(zh['field.name']), { target: { value: ' code2 ' } })
  fireEvent.change(volume, { target: { value: 'vol-a' } })
  fireEvent.change(screen.getByLabelText(zh['field.rootCode']), { target: { value: ' code/x ' } })
  fireEvent.change(screen.getByLabelText(zh['field.mountPath']), { target: { value: '/w' } })
  fireEvent.change(screen.getByLabelText(zh['field.setup']), { target: { value: 'make' } })
  fireEvent.click(screen.getByRole('button', { name: zh['form.save'] }))
  await waitFor(() => { expect(screen.queryByRole('button', { name: zh['form.save'] })).toBeNull() })
  expect(b.saveSource).toHaveBeenCalledWith({
    name: 'code2', source: { kind: 'code', volume: { type: 'afs', id: 'vol-a' }, root: 'code/x', mountPath: '/w', defaultRef: 'main', setup: 'make' },
  })
})

it('switches the form between kinds and volume types and keeps it open on failure until cancelled', async () => {
  const b = fixture({ value: overview, connected: true, error: null })
  b.loadVolumes.mockResolvedValueOnce({ ok: false, message: 'denied' })
  fireEvent.click(screen.getByRole('button', { name: zh['sources.add'] }))
  fireEvent.focusIn(screen.getByLabelText(zh['field.volume']))
  expect(await screen.findAllByText('操作失败：denied')).toHaveLength(2)
  fireEvent.change(screen.getByLabelText(zh['field.kind']), { target: { value: 'data' } })
  fireEvent.change(screen.getByLabelText(zh['field.volumeType']), { target: { value: 'aoss' } })
  expect(screen.queryByLabelText(zh['field.volume'])).toBeNull()
  fireEvent.change(screen.getByLabelText(zh['field.name']), { target: { value: 'd' } })
  fireEvent.change(screen.getByLabelText(zh['field.bucket']), { target: { value: 'bk' } })
  fireEvent.change(screen.getByLabelText(zh['field.endpoint']), { target: { value: 'ep' } })
  fireEvent.change(screen.getByLabelText(zh['field.path']), { target: { value: 'clips' } })
  fireEvent.change(screen.getByLabelText(zh['field.mountPath']), { target: { value: '/data' } })
  b.saveSource.mockResolvedValueOnce('duplicate')
  fireEvent.click(screen.getByRole('button', { name: zh['form.save'] }))
  expect(screen.getByRole('button', { name: zh['form.saving'] })).toBeTruthy()
  await screen.findByText('操作失败：duplicate')
  expect(b.saveSource).toHaveBeenCalledWith({
    name: 'd', source: { kind: 'data', volume: { type: 'aoss', bucket: 'bk', endpoint: 'ep' }, mountPath: '/data', path: 'clips' },
  })
  fireEvent.change(screen.getByLabelText(zh['field.kind']), { target: { value: 'output' } })
  expect(screen.getByLabelText(zh['field.rootOutput'])).toBeTruthy()
  expect(screen.queryByLabelText(zh['field.mountPath'])).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: zh['form.cancel'] }))
  expect(screen.queryByLabelText(zh['field.kind'])).toBeNull()
})

it('edits a source with a locked name and an unlisted volume, and removes one after confirmation', async () => {
  const b = fixture({ value: overview, connected: true, error: null })
  const card = screen.getByText('runs', { selector: 'span' }).closest('li')!
  fireEvent.click(within(card).getByRole('button', { name: zh['sources.edit'] }))
  expect(screen.getByText('编辑数据源 runs')).toBeTruthy()
  expect(screen.getByLabelText<HTMLInputElement>(zh['field.name']).disabled).toBe(true)
  expect(screen.getByLabelText<HTMLSelectElement>(zh['field.volume']).value).toBe('vol-b')
  fireEvent.change(screen.getByLabelText(zh['field.description']), { target: { value: ' outputs ' } })
  fireEvent.click(screen.getByRole('button', { name: zh['form.save'] }))
  await waitFor(() => { expect(b.saveSource).toHaveBeenCalledOnce() })
  expect(b.saveSource).toHaveBeenCalledWith({
    name: 'runs', replace: true, source: { kind: 'output', volume: { type: 'afs', id: 'vol-b' }, root: 'runs', description: 'outputs' },
  })

  const clips = screen.getByText('clips', { selector: 'span' }).closest('li')!
  fireEvent.click(within(clips).getByRole('button', { name: zh['sources.remove'] }))
  expect(b.deleteSource).not.toHaveBeenCalled()
  b.deleteSource.mockResolvedValueOnce('in use')
  fireEvent.click(within(clips).getByRole('button', { name: zh['sources.removeConfirm'] }))
  await within(clips).findByText('操作失败：in use')
  expect(b.deleteSource).toHaveBeenCalledWith('clips')
})

it('round-trips every source kind through the form fields', () => {
  for (const source of [code, data, output, { ...data, path: 'p' }, { ...code, setup: undefined }]) expect(sourceOf(draftOf('x', source))).toEqual(source)
})

it('renders the decorative sidebar icon', () => {
  const { container } = render(<ConfigIcon {...{ size: 20 } as PropsRuntime<'sidebar.panellist'>} />)
  expect(container.querySelector('svg')).toBeTruthy()
})
