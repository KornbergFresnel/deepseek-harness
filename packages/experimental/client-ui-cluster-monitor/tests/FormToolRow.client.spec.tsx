// @vitest-environment jsdom
/** The `sco_config_form` row shows the live form while the call waits, answers it, and summarizes the outcome with an offer to save. */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { ScoConfigForm, ScoConfigOverview } from '@deepseek-ai/dsh-experimental-sco-submit/types'
import { afterEach, expect, it, vi } from 'vitest'
import { FormToolRow, formArgs, formOutcome, type FormToolRowProps } from '../src/client/FormToolRow.tsx'
import type { Mirror } from '../src/client/source.ts'
import { workloadZh as zh } from '../src/client/workload-locales.ts'

afterEach(() => { cleanup() })
const t = makeTranslate(zh)
const callId = brandString<ToolCallId>('call-1')
const overview: ScoConfigOverview = { configured: {}, saved: {}, outputMountPath: '/o', sources: [], templates: [], configs: [] }
const open: ScoConfigForm = { callId, kind: 'job', title: 'WBT G1', initial: { image: 'img' }, openedAt: 't' }

/** Call phase and block as the keyed tool seat supplies them; blocks carry only the fields the row reads. */
type Phase = { phase: FormToolRowProps['phase']; block: object }

function row(phase: Phase, forms: ScoConfigForm[] | null = []) {
  const formStore = createSnapshotStore<Mirror<ScoConfigForm[]>>({ value: forms, connected: true, error: null })
  const overviewStore = createSnapshotStore<Mirror<ScoConfigOverview>>({ value: overview, connected: true, error: null })
  const answer = vi.fn(async () => null as string | null)
  const saveConfig = vi.fn(async () => null as string | null)
  const props = {
    callId, toolName: 'sco_config_form', useForms: bindSnapshotSelector(formStore), useOverview: bindSnapshotSelector(overviewStore),
    answer, saveConfig, storage: { saveSource: vi.fn(), loadVolumes: vi.fn() }, t, ...phase,
  } as FormToolRowProps
  return { ...render(<FormToolRow {...props} />), formStore, answer, saveConfig }
}

const result = (text: string, extra: Record<string, unknown> = {}): Phase => ({
  phase: 'result',
  block: { kind: 'tool-result', call: { name: 'sco_config_form', argsRaw: JSON.stringify({ kind: 'devmachine', title: 'Dev box' }) }, content: [{ type: 'text', text }], isError: false, ...extra },
})

it('reads arguments and outcomes defensively', () => {
  expect(formArgs('{"kind":"devmachine","title":"x"}')).toEqual({ kind: 'devmachine', title: 'x' })
  expect(formArgs('{"kind":"job","title":""}')).toEqual({ kind: 'job' })
  expect(formArgs('{"kind":')).toEqual({ kind: 'job' })
  expect(formArgs('[]')).toEqual({ kind: 'job' })
  expect(formOutcome('{"kind":"cancelled"}')).toEqual({ kind: 'cancelled' })
  expect(formOutcome('{"kind":"confirmed","workload":"devmachine","spec":{"gpuCount":1},"loaded":"a","savedAs":"b"}'))
    .toEqual({ kind: 'confirmed', workload: 'devmachine', spec: { gpuCount: 1 }, loaded: 'a', savedAs: 'b' })
  expect(formOutcome('{"kind":"confirmed","spec":{}}')).toEqual({ kind: 'confirmed', workload: 'job', spec: {} })
  expect(formOutcome('{"kind":"confirmed"}')).toBeNull()
  expect(formOutcome('error: closed')).toBeNull()
})

it('shows a preparing line, then an opening line until the Host lists the form', () => {
  const preparing = row({ phase: 'preparing', block: {} })
  expect(screen.getByText(zh['row.preparing'])).toBeTruthy()
  preparing.unmount()
  const b = row({ phase: 'start', block: { argsRaw: JSON.stringify({ kind: 'job', title: 'WBT G1' }) } }, null)
  expect(screen.getByText(zh['row.opening'])).toBeTruthy()
  expect(screen.getByText('WBT G1')).toBeTruthy()
  act(() => { b.formStore.set({ value: [open], connected: true, error: null }) })
  expect(screen.getByRole('heading', { name: 'WBT G1' })).toBeTruthy()
})

it('answers the open form with the confirmed settings or a cancellation', async () => {
  const b = row({ phase: 'start', block: { argsRaw: '{}' } }, [open])
  fireEvent.click(screen.getByRole('button', { name: zh['form.confirm'] }))
  await waitFor(() => { expect(b.answer).toHaveBeenCalledWith(callId, { kind: 'confirmed', spec: { image: 'img' } }) })
  fireEvent.click(screen.getByRole('button', { name: zh['form.cancel'] }))
  expect(b.answer).toHaveBeenLastCalledWith(callId, { kind: 'cancelled' })
  cleanup()
  row({ phase: 'start', block: { argsRaw: '{}' } }, [{ ...open, title: undefined, kind: 'devmachine', suggested: 'dev' } as ScoConfigForm])
  expect(screen.getByRole('heading', { name: zh['form.title.devmachine'] })).toBeTruthy()
  cleanup()
  row({ phase: 'start', block: { argsRaw: '{}' } }, [{ callId, kind: 'job', initial: {}, openedAt: 't' }])
  expect(screen.getByRole('heading', { name: zh['form.title.job'] })).toBeTruthy()
})

it('summarizes confirmed settings and saves them on request', async () => {
  const b = row(result(JSON.stringify({ kind: 'confirmed', workload: 'devmachine', spec: { gpuCount: 1, image: 'img' }, loaded: 'dev-a100' })))
  expect(screen.getByText('Dev box')).toBeTruthy()
  expect(screen.getByText(zh['row.confirmed'])).toBeTruthy()
  expect(screen.getByText('基于配置 dev-a100')).toBeTruthy()
  expect(screen.getByText('img')).toBeTruthy()
  const name = screen.getByLabelText<HTMLInputElement>(zh['save.name'])
  expect(name.value).toBe('dev-a100')
  fireEvent.change(name, { target: { value: ' ' } })
  fireEvent.click(screen.getByRole('button', { name: zh['form.save'] }))
  expect(screen.getByRole('alert').textContent).toBe(zh['invalid.name'])
  fireEvent.change(name, { target: { value: ' dev-1gpu ' } })
  b.saveConfig.mockResolvedValueOnce('disk full')
  fireEvent.click(screen.getByRole('button', { name: zh['form.save'] }))
  await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('操作失败：disk full') })
  fireEvent.click(screen.getByRole('button', { name: zh['form.save'] }))
  await waitFor(() => { expect(screen.getByText('已保存为配置 dev-1gpu')).toBeTruthy() })
  expect(b.saveConfig).toHaveBeenLastCalledWith({ name: 'dev-1gpu', kind: 'devmachine', spec: { gpuCount: 1, image: 'img' }, replace: true })
})

it('names the saved configuration, the cancellation, and a closed form', () => {
  row(result(JSON.stringify({ kind: 'confirmed', workload: 'job', spec: {}, savedAs: 'wbt' }), { call: null }))
  expect(screen.getByText('已确认，并保存为配置 wbt')).toBeTruthy()
  expect(screen.getByText(zh['form.title.job'])).toBeTruthy()
  expect(screen.queryByLabelText(zh['save.name'])).toBeNull()
  cleanup()
  row(result('{"kind":"cancelled"}'))
  expect(screen.getByText(zh['row.cancelled'])).toBeTruthy()
  cleanup()
  row(result('turn stopped', { isError: true, content: [{ type: 'text', text: 'turn stopped' }, { type: 'image' }] }))
  expect(screen.getByText('表单已关闭：turn stopped')).toBeTruthy()
})

it('suggests a save name from the title when nothing was loaded', () => {
  row(result('{"kind":"confirmed","spec":{}}', { call: { name: 'x', argsRaw: '{"title":"WBT G1"}' } }))
  expect(screen.getByLabelText<HTMLInputElement>(zh['save.name']).value).toBe('wbt-g1')
  cleanup()
  row(result('{"kind":"confirmed","spec":{}}', { call: null }))
  expect(screen.getByLabelText<HTMLInputElement>(zh['save.name']).value).toBe('')
})
