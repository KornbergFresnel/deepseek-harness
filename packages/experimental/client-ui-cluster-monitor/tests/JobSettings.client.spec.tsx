// @vitest-environment jsdom
/** The description and metric source editors show a job's settings, build valid changes, and report failures. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ClusterMetricSource, ClusterWatchId, ClusterWatchRow } from '@deepseek-ai/dsh-experimental-cluster-monitor/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DescriptionField, MetricSourceField, sourceOf, sourceSummary, type JobSettingsActions } from '../src/client/JobSettings.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(() => { cleanup() })
const t = makeTranslate(zh)
const id = brandString<ClusterWatchId>('w1')
const job = (extra: Partial<ClusterWatchRow> = {}): ClusterWatchRow => ({
  id, name: 'job-a', origin: 'created', phase: 'running', rawState: 'Running', watchedAt: 't', latest: {},
  metrics: { kind: 'logs' }, metricsDefault: true, ...extra,
})

function actions(kinds: JobSettingsActions['metricSources'] = async () => ({ kinds: ['logs', 'wandb', 'tensorboard'] })) {
  return { configure: vi.fn(async () => null as string | null), metricSources: vi.fn(kinds) }
}

describe('metric source summaries and drafts', () => {
  it('summarizes logs, wandb, and other sources', () => {
    expect(sourceSummary({ kind: 'logs' }, t)).toBe(zh['metrics.logsDefault'])
    expect(sourceSummary({ kind: 'logs', options: { parsers: 'none' } }, t)).toBe(zh['metrics.logsDefault'])
    expect(sourceSummary({
      kind: 'logs',
      options: { parsers: [{ kind: 'experiment-logger' }, { kind: 'json-lines', stepKey: 'iter' }, { kind: 'regex', pattern: 'p(?<step>1)' }, 'x', null, [1], { kind: 'other' }, { kind: 'regex' }] },
    }, t)).toBe('ExperimentLogger 表格 · JSON 行 · p(?<step>1)')
    expect(sourceSummary({ kind: 'wandb' }, t)).toBe(zh['metrics.wandbAuto'])
    expect(sourceSummary({ kind: 'wandb', options: { run: 'a/b/c' } }, t)).toBe('a/b/c')
    expect(sourceSummary({ kind: 'tensorboard' }, t)).toBe('')
    expect(sourceSummary({ kind: 'tensorboard', options: { dir: '/logs' } }, t)).toBe('{"dir":"/logs"}')
  })

  it('builds sources from drafts and names a draft problem', () => {
    const base = { kind: 'logs', fixed: { 'experiment-logger': true, 'json-lines': true, 'key-value': false }, stepKey: ' iter ', patterns: ' a(?<step>1) \n\n', run: '', json: '' }
    expect(sourceOf(base)).toEqual({ ok: true, source: { kind: 'logs', options: { parsers: [
      { kind: 'experiment-logger' }, { kind: 'json-lines', stepKey: 'iter' }, { kind: 'regex', pattern: 'a(?<step>1)' },
    ] } } })
    expect(sourceOf({ ...base, stepKey: '', fixed: { 'experiment-logger': false, 'json-lines': false, 'key-value': true }, patterns: '' }))
      .toEqual({ ok: true, source: { kind: 'logs', options: { parsers: [{ kind: 'key-value' }] } } })
    expect(sourceOf({ ...base, fixed: { 'experiment-logger': false, 'json-lines': false, 'key-value': false }, patterns: ' ' }))
      .toEqual({ ok: false, problem: 'metrics.parsersEmpty' })
    expect(sourceOf({ ...base, kind: 'wandb', run: ' ' })).toEqual({ ok: true, source: { kind: 'wandb' } })
    expect(sourceOf({ ...base, kind: 'wandb', run: ' a/b/c ' })).toEqual({ ok: true, source: { kind: 'wandb', options: { run: 'a/b/c' } } })
    expect(sourceOf({ ...base, kind: 'tb', json: ' ' })).toEqual({ ok: true, source: { kind: 'tb' } })
    expect(sourceOf({ ...base, kind: 'tb', json: '{"dir":"/x"}' })).toEqual({ ok: true, source: { kind: 'tb', options: { dir: '/x' } } })
    expect(sourceOf({ ...base, kind: 'tb', json: '[1]' })).toEqual({ ok: false, problem: 'metrics.optionsInvalid' })
    expect(sourceOf({ ...base, kind: 'tb', json: '{' })).toEqual({ ok: false, problem: 'metrics.optionsInvalid' })
  })
})

describe('description editor', () => {
  it('shows the description or display name, saves a change, and keeps the editor open on failure', async () => {
    const a = actions()
    const view = render(<DescriptionField job={job({ displayName: 'console name' })} configure={a.configure} t={t} />)
    expect(screen.getByText('console name')).toBeTruthy()
    view.rerender(<DescriptionField job={job()} configure={a.configure} t={t} />)
    expect(screen.getByText(zh['description.empty'])).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh['description.edit'] }))
    fireEvent.change(screen.getByLabelText(zh['description.label']), { target: { value: 'Train G1' } })
    a.configure.mockResolvedValueOnce('too long')
    fireEvent.click(screen.getByRole('button', { name: zh['settings.save'] }))
    await screen.findByText('操作失败：too long')
    fireEvent.click(screen.getByRole('button', { name: zh['settings.save'] }))
    await waitFor(() => { expect(screen.queryByLabelText(zh['description.label'])).toBeNull() })
    expect(a.configure).toHaveBeenLastCalledWith(id, { description: 'Train G1' })
    view.rerender(<DescriptionField job={job({ description: 'Train G1' })} configure={a.configure} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: zh['description.edit'] }))
    expect(screen.getByLabelText<HTMLInputElement>(zh['description.label']).value).toBe('Train G1')
    fireEvent.click(screen.getByRole('button', { name: zh['settings.cancel'] }))
    expect(screen.getByText('Train G1')).toBeTruthy()
  })
})

describe('metric source editor', () => {
  const open = async () => {
    fireEvent.click(screen.getByRole('button', { name: zh['metrics.edit'] }))
    await waitFor(() => { expect(screen.getByLabelText(zh['metrics.kind'])).toBeTruthy() })
  }

  it('edits log parsers, switches to wandb, and resets to the default', async () => {
    const a = actions()
    const parsers: ClusterMetricSource = { kind: 'logs', options: { parsers: [{ kind: 'json-lines' }, { kind: 'key-value', stepKey: 'iter' }, { kind: 'regex', pattern: 'r(?<step>1)' }] } }
    const view = render(<MetricSourceField job={job({ metrics: parsers, metricsDefault: false, metricsError: 'bad line' })} actions={a} t={t} />)
    expect(screen.getByText('指标来源：日志解析')).toBeTruthy()
    expect(screen.getByText('读取指标失败：bad line')).toBeTruthy()
    await open()
    expect(screen.getByLabelText<HTMLInputElement>(zh['metrics.stepKey']).value).toBe('iter')
    expect(screen.getByLabelText<HTMLTextAreaElement>(zh['metrics.patterns']).value).toBe('r(?<step>1)')
    expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['日志解析', 'Weights & Biases', 'tensorboard'])
    fireEvent.click(screen.getByLabelText(zh['metrics.parser.key-value']))
    fireEvent.click(screen.getByLabelText(zh['metrics.parser.json-lines']))
    fireEvent.change(screen.getByLabelText(zh['metrics.patterns']), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: zh['settings.save'] }))
    expect(screen.getByRole('alert').textContent).toBe(zh['metrics.parsersEmpty'])
    fireEvent.click(screen.getByLabelText(zh['metrics.parser.json-lines']))
    fireEvent.change(screen.getByLabelText(zh['metrics.stepKey']), { target: { value: '' } })
    a.configure.mockResolvedValueOnce('invalid pattern')
    fireEvent.click(screen.getByRole('button', { name: zh['settings.save'] }))
    await screen.findByText('操作失败：invalid pattern')
    fireEvent.change(screen.getByLabelText(zh['metrics.kind']), { target: { value: 'wandb' } })
    fireEvent.change(screen.getByLabelText(zh['metrics.run']), { target: { value: 'team/rlh/abc' } })
    fireEvent.click(screen.getByRole('button', { name: zh['settings.save'] }))
    await waitFor(() => { expect(screen.queryByLabelText(zh['metrics.kind'])).toBeNull() })
    expect(a.configure).toHaveBeenCalledWith(id, { metrics: { kind: 'logs', options: { parsers: [{ kind: 'json-lines' }] } } })
    expect(a.configure).toHaveBeenLastCalledWith(id, { metrics: { kind: 'wandb', options: { run: 'team/rlh/abc' } } })
    await open()
    fireEvent.click(screen.getByRole('button', { name: zh['metrics.reset'] }))
    await waitFor(() => { expect(a.configure).toHaveBeenLastCalledWith(id, { metrics: null }) })
    view.rerender(<MetricSourceField job={job({ metrics: { kind: 'wandb', options: { run: 'a/b/c' } }, metricsDefault: false })} actions={a} t={t} />)
    expect(screen.getByText('· a/b/c', { exact: false })).toBeTruthy()
    await open()
    expect(screen.getByLabelText<HTMLInputElement>(zh['metrics.run']).value).toBe('a/b/c')
  })

  it('opens a default source with empty fields and shows a source without a summary', async () => {
    const view = render(<MetricSourceField job={job()} actions={actions()} t={t} />)
    await open()
    expect(screen.getByLabelText<HTMLInputElement>(zh['metrics.stepKey']).value).toBe('')
    expect(screen.getByLabelText<HTMLTextAreaElement>(zh['metrics.patterns']).value).toBe('')
    fireEvent.change(screen.getByLabelText(zh['metrics.kind']), { target: { value: 'tensorboard' } })
    expect(screen.getByLabelText<HTMLTextAreaElement>(zh['metrics.options']).value).toBe('')
    view.unmount()
    render(<MetricSourceField job={job({ metrics: { kind: 'tb' } })} actions={actions()} t={t} />)
    expect(screen.getByText('指标来源：tb（默认）').parentElement!.textContent).toBe('指标来源：tb（默认）')
  })

  it('edits options of another source as JSON and lists the current kind when the list is unavailable', async () => {
    const a = actions(async () => ({ error: 'offline' }))
    render(<MetricSourceField job={job({ metrics: { kind: 'tb', options: { dir: '/x' } } })} actions={a} t={t} />)
    expect(screen.getByText('指标来源：tb（默认）')).toBeTruthy()
    await open()
    expect(screen.getByText('操作失败：offline')).toBeTruthy()
    expect(screen.queryByRole('button', { name: zh['metrics.reset'] })).toBeNull()
    expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['tb'])
    fireEvent.change(screen.getByLabelText(zh['metrics.options']), { target: { value: '[]' } })
    fireEvent.click(screen.getByRole('button', { name: zh['settings.save'] }))
    expect(screen.getByRole('alert').textContent).toBe(zh['metrics.optionsInvalid'])
    fireEvent.change(screen.getByLabelText(zh['metrics.options']), { target: { value: '{"dir":"/y"}' } })
    fireEvent.click(screen.getByRole('button', { name: zh['settings.save'] }))
    await waitFor(() => { expect(a.configure).toHaveBeenCalledWith(id, { metrics: { kind: 'tb', options: { dir: '/y' } } }) })
    await open()
    fireEvent.click(screen.getByRole('button', { name: zh['settings.cancel'] }))
    expect(screen.getByRole('button', { name: zh['metrics.edit'] })).toBeTruthy()
  })
})
