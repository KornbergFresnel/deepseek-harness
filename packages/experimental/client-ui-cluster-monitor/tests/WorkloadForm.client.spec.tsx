// @vitest-environment jsdom
/** The workload form loads saved configurations, edits sources, queues, and resources, checks its fields, and submits or saves. */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ScoConfigOverview, ScoSavedConfig } from '@deepseek-ai/dsh-experimental-sco-submit/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { draftOf, specFacts, specOf, suggestName } from '../src/client/workload.ts'
import { WorkloadForm, type WorkloadFormProps, type WorkloadTranslate } from '../src/client/WorkloadForm.tsx'
import { workloadEn, workloadZh as zh } from '../src/client/workload-locales.ts'

afterEach(() => { cleanup() })
const t = makeTranslate(zh) as WorkloadTranslate

const saved = (kind: ScoSavedConfig['kind'], spec: ScoSavedConfig['spec'], description?: string): ScoSavedConfig => ({
  kind, spec, createdAt: 't', updatedAt: 't', ...description === undefined ? {} : { description },
})

const overview: ScoConfigOverview = {
  configured: {}, saved: {}, outputMountPath: '/outputs', templates: [],
  sources: [
    { name: 'rlh', source: { kind: 'code', volume: { type: 'afs', id: 'v' }, root: 'code', mountPath: '/code', defaultRef: 'main' } },
    { name: 'motion', source: { kind: 'data', volume: { type: 'afs', id: 'v' }, mountPath: '/data' } },
    { name: 'clips', source: { kind: 'data', volume: { type: 'afs', id: 'v' }, mountPath: '/clips' } },
    { name: 'runs', source: { kind: 'output', volume: { type: 'afs', id: 'v' }, root: 'runs' } },
    { name: 'home', source: { kind: 'storage', volume: { type: 'afs', id: 'v' }, mountPath: '/personal', reposDir: 'repos', packagesDir: 'pkgs' } },
  ],
  options: {
    workspace: 'ws', fetchedAt: 't',
    queues: [
      { id: 'q-gpu', cluster: 'c1', queue: 'gpu', detail: {}, machineTypes: ['h1', 'h2'] },
      { id: 'q-cpu', cluster: 'c2', queue: 'cpu', detail: {}, machineTypes: ['c6', 'h1'] },
    ],
  },
  configs: [
    { name: 'wbt-8gpu', config: saved('job', { image: 'img:8', gpuCount: 8, data: ['motion'] }, 'eight GPUs') },
    { name: 'wbt-small', config: saved('job', { image: 'img:1', gpuCount: 1 }) },
    { name: 'dev-a100', config: saved('devmachine', { gpuCount: 1 }) },
  ],
}

function form(overrides: Partial<WorkloadFormProps> = {}) {
  const onSubmit = vi.fn(async () => null as string | null)
  const onCancel = vi.fn()
  const props: WorkloadFormProps = {
    kind: 'job', heading: 'WBT', initial: { image: 'img:0', env: { SEED: '1' } }, overview, save: { mode: 'optional', name: '' },
    submitLabel: 'form.confirm', busyLabel: 'form.confirming', onSubmit, onCancel, t, ...overrides,
  }
  return { ...render(<WorkloadForm {...props} />), onSubmit, onCancel }
}

const field = (label: string) => screen.getByLabelText<HTMLInputElement & HTMLSelectElement & HTMLTextAreaElement>(label)
const change = (label: string, value: string) => { fireEvent.change(field(label), { target: { value } }) }
const confirm = () => { fireEvent.click(screen.getByRole('button', { name: zh['form.confirm'] })) }

describe('workload fields', () => {
  it('round-trips settings through form fields and drops blank and job-only fields', () => {
    const spec = {
      image: 'img', imageType: 'PRIVATE' as const, data: ['a'], env: { A: '1', B: 'x=y' }, gpuCount: 0, podCount: 2,
      framework: 'MPI' as const, maxAttempts: 3, enableQueuing: true, queueId: 'q', storage: 'home', repos: ['https://h/x', 'https://h/y#v1'], packages: ['numpy'],
    }
    const draft = draftOf(spec)
    expect(draft).toMatchObject({ image: 'img', gpuCount: '0', env: 'A=1\nB=x=y', enableQueuing: true, command: '', repos: 'https://h/x\nhttps://h/y#v1', packages: 'numpy' })
    expect(specOf(draft, 'job')).toEqual({ ok: true, spec })
    expect(specOf(draft, 'devmachine')).toEqual({ ok: true, spec: {
      image: 'img', imageType: 'PRIVATE', data: ['a'], env: { A: '1', B: 'x=y' }, gpuCount: 0, podCount: 2, queueId: 'q', storage: 'home', repos: ['https://h/x', 'https://h/y#v1'], packages: ['numpy'],
    } })
    expect(specOf(draftOf({}), 'job')).toEqual({ ok: true, spec: {} })
    expect(specOf({ ...draftOf({}), cpuCount: '1.5' }, 'job')).toEqual({ ok: false, problem: { kind: 'number', field: 'cpuCount' } })
    expect(specOf({ ...draftOf({}), env: 'A=1\n\nnope' }, 'job')).toEqual({ ok: false, problem: { kind: 'env', line: 3 } })
    expect(specOf({ ...draftOf({}), env: '=x' }, 'job')).toEqual({ ok: false, problem: { kind: 'env', line: 1 } })
  })

  it('lists set fields in display order and suggests names', () => {
    expect(specFacts({ env: { A: '1' }, image: 'img', data: ['a', 'b'], enableQueuing: false, gpuCount: 8, storage: 'home', packages: ['numpy', 'torch'] })).toEqual([
      ['field.image', 'img'], ['field.data', 'a, b'], ['field.storage', 'home'], ['field.packages', 'numpy, torch'], ['field.gpuCount', '8'],
      ['field.enableQueuing', 'false'], ['field.env', 'A=1'],
    ])
    expect(suggestName(' WBT Train: G1 / 8 GPUs ')).toBe('wbt-train-g1-8-gpus')
    expect(suggestName('训练')).toBe('')
    expect(Object.keys(workloadEn)).toEqual(Object.keys(zh))
  })
})

describe('WorkloadForm', () => {
  it('submits edited settings with the source, queue, and resource choices', async () => {
    const b = form()
    expect(screen.getByRole('heading', { name: 'WBT' })).toBeTruthy()
    expect(field(zh['field.image']).value).toBe('img:0')
    change(zh['field.image'], 'img:9')
    change(zh['field.imageType'], 'OFFICIAL')
    change(zh['field.code'], 'rlh')
    change(zh['field.ref'], 'dev')
    change(zh['field.output'], 'runs')
    expect(screen.getByText(zh['field.storageHint'])).toBeTruthy()
    change(zh['field.storage'], 'home')
    change(zh['field.repos'], ' https://github.com/org/rsl_rl.git \n\n')
    change(zh['field.packages'], 'numpy\n torch==2.3.0')
    fireEvent.click(screen.getByRole('checkbox', { name: 'clips' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'motion' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'motion' }))
    change(zh['field.workspace'], 'ws2')
    expect(within(field(zh['field.machineType'])).getAllByRole('option').map(option => option.textContent)).toEqual([zh['field.machineTypeNone'], 'h1', 'h2', 'c6'])
    change(zh['field.queue'], 'q-cpu')
    expect(within(field(zh['field.machineType'])).getAllByRole('option').map(option => option.textContent)).toEqual([zh['field.machineTypeNone'], 'c6', 'h1'])
    change(zh['field.machineType'], 'c6')
    change(zh['field.podCount'], '2')
    change(zh['field.gpuCount'], '8')
    change(zh['field.priority'], 'HIGH')
    change(zh['field.framework'], 'PYTORCH_DDP')
    fireEvent.click(screen.getByRole('checkbox', { name: zh['field.enableQueuing'] }))
    change(zh['field.command'], 'python train.py')
    change(zh['field.env'], 'SEED=2\nMODE = offline')
    confirm()
    await waitFor(() => { expect(b.onSubmit).toHaveBeenCalledOnce() })
    expect(b.onSubmit).toHaveBeenCalledWith({
      spec: {
        image: 'img:9', imageType: 'OFFICIAL', code: 'rlh', ref: 'dev', output: 'runs', storage: 'home', workspace: 'ws2', queueId: 'q-cpu', machineType: 'c6',
        repos: ['https://github.com/org/rsl_rl.git'], packages: ['numpy', 'torch==2.3.0'],
        priority: 'HIGH', framework: 'PYTORCH_DDP', command: 'python train.py', podCount: 2, gpuCount: 8, data: ['clips'],
        env: { SEED: '2', MODE: 'offline' }, enableQueuing: true,
      },
    })
    fireEvent.click(screen.getByRole('button', { name: zh['form.cancel'] }))
    expect(b.onCancel).toHaveBeenCalledOnce()
  })

  it('loads a saved configuration of the same kind, follows the agent suggestion, and offers to save under its name', async () => {
    const b = form({ suggested: 'wbt-8gpu' })
    expect(screen.getByText('有 2 个已保存的同类配置，可以先加载再修改。')).toBeTruthy()
    const options = within(field(zh['form.load'])).getAllByRole('option').map(option => option.textContent)
    expect(options).toEqual([zh['form.loadNone'], 'wbt-8gpu · eight GPUs', 'wbt-small'])
    expect(screen.getByText('agent 推荐加载配置 wbt-8gpu')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '加载 wbt-8gpu' }))
    expect(screen.getByText('已加载配置 wbt-8gpu')).toBeTruthy()
    expect(field(zh['field.image']).value).toBe('img:8')
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'motion' }).checked).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: zh['save.toggle'] }))
    expect(field(zh['save.name']).value).toBe('wbt-8gpu')
    expect(screen.getByText(zh['save.replaceHint'])).toBeTruthy()
    change(zh['form.load'], 'wbt-small')
    expect(field(zh['save.name']).value).toBe('wbt-small')
    change(zh['save.name'], 'wbt-1gpu')
    change(zh['save.description'], ' one ')
    change(zh['form.load'], 'wbt-8gpu')
    expect(field(zh['save.name']).value).toBe('wbt-1gpu')
    change(zh['form.load'], '')
    expect(field(zh['field.image']).value).toBe('img:0')
    change(zh['form.load'], 'wbt-small')
    confirm()
    await waitFor(() => { expect(b.onSubmit).toHaveBeenCalledOnce() })
    expect(b.onSubmit).toHaveBeenCalledWith({ spec: { image: 'img:1', gpuCount: 1 }, loaded: 'wbt-small', save: { name: 'wbt-1gpu', description: 'one' } })
  })

  it('reports field problems and Host failures, and requires a name when saving', async () => {
    const b = form({ initial: {} })
    change(zh['field.cpuCount'], 'x')
    confirm()
    expect(screen.getByRole('alert').textContent).toBe('每节点 CPU 核必须是非负整数')
    change(zh['field.cpuCount'], '')
    change(zh['field.env'], 'oops')
    confirm()
    expect(screen.getByRole('alert').textContent).toBe('环境变量第 1 行不是 KEY=VALUE')
    change(zh['field.env'], '')
    fireEvent.click(screen.getByRole('checkbox', { name: zh['save.toggle'] }))
    confirm()
    expect(screen.getByRole('alert').textContent).toBe(zh['invalid.name'])
    change(zh['save.name'], 'mine')
    b.onSubmit.mockResolvedValueOnce('configuration name rejected')
    confirm()
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('操作失败：configuration name rejected') })
    confirm()
    await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
    expect(b.onSubmit).toHaveBeenLastCalledWith({ spec: {}, save: { name: 'mine' } })
  })

  it('omits job-only fields for a development machine and works without an overview', () => {
    form({ kind: 'devmachine', overview: null, initial: { data: ['old'] }, save: { mode: 'required', name: 'dev-a100', description: 'd', lockName: true } })
    expect(screen.queryByLabelText(zh['field.framework'])).toBeNull()
    expect(screen.queryByLabelText(zh['field.maxAttempts'])).toBeNull()
    expect(screen.queryByRole('checkbox', { name: zh['field.enableQueuing'] })).toBeNull()
    expect(screen.queryByLabelText(zh['form.load'])).toBeNull()
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'old' }).checked).toBe(true)
    expect(field(zh['save.name']).disabled).toBe(true)
    expect(field(zh['save.description']).value).toBe('d')
    expect(screen.queryByText(zh['save.replaceHint'])).toBeNull()
    expect(screen.queryByRole('checkbox', { name: zh['save.toggle'] })).toBeNull()
  })

  it('says when no data sources are registered and keeps an unlisted current value selectable', () => {
    form({ overview: { ...overview, sources: [], options: undefined, configs: [] } as ScoConfigOverview, initial: { queueId: 'q-gone', code: 'gone' } })
    expect(screen.getByText(zh['field.noSources'])).toBeTruthy()
    expect(field(zh['field.queue']).value).toBe('q-gone')
    expect(field(zh['field.code']).value).toBe('gone')
  })
})
