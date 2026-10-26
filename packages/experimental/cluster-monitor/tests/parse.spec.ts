import { describe, expect, it } from 'vitest'
import {
  compilePattern, isTerminal, jobFacts, parseExperimentLogger, parseJsonLines, parseKeyValues, parseLogs, parseRegex, phaseOf, tail,
} from '../src/parse.ts'
import { issueText, logParserSchema, logsSource } from '../src/sources.ts'
import type { ClusterJobPhase } from '../src/types.ts'

describe('SSP job facts', () => {
  it('maps state text onto lifecycle buckets by keyword', () => {
    expect([
      'RUNNING', 'Pending', 'QUEUING', 'SUCCEEDED', 'Completed', 'FAILED', 'Error', 'STOPPED', 'Cancelled', 'mystery',
    ].map(phaseOf)).toEqual([
      'running', 'pending', 'pending', 'succeeded', 'succeeded', 'failed', 'failed', 'stopped', 'stopped', 'unknown',
    ])
    expect(phaseOf(null)).toBe('unknown')
    const phases: ClusterJobPhase[] = ['succeeded', 'failed', 'stopped', 'running', 'pending', 'unknown']
    expect(phases.map(isTerminal))
      .toEqual([true, true, true, false, false, false])
  })

  it('reads state and times from the job object or its status and metadata members', () => {
    expect(jobFacts({ name: 'job-a', state: 'RUNNING', create_time: '2026-10-20T01:00:00Z' }))
      .toEqual({ rawState: 'RUNNING', phase: 'running', createdAt: '2026-10-20T01:00:00Z' })
    expect(jobFacts({ status: { phase: 'Succeeded', start_time: 's', end_time: 'e' }, metadata: { created_at: 'c' } }))
      .toEqual({ rawState: 'Succeeded', phase: 'succeeded', createdAt: 'c', startedAt: 's', finishedAt: 'e' })
    expect(jobFacts({ state: '', status: 'Pending' })).toEqual({ rawState: 'Pending', phase: 'pending' })
    expect(jobFacts([1, 2])).toEqual({ rawState: null, phase: 'unknown' })
    expect(jobFacts(null)).toEqual({ rawState: null, phase: 'unknown' })
    expect(jobFacts({ state: 'RUNNING', display_name: 'G1 sweep' })).toEqual({ rawState: 'RUNNING', phase: 'running', displayName: 'G1 sweep' })
  })
})

describe('rlightning-humanoid metric output', () => {
  it('parses metric/value tables between other log lines', () => {
    const text = [
      '2026-10-20 10:00:00 | INFO | rlh.learner:record:217 - ',
      'metric        value',
      '------------  ------',
      'step          100',
      'train/loss    0.5000',
      'train/reward  12.2500',
      'note          warmup',
      '2026-10-20 10:00:05 | INFO | something else',
      'metric  value',
      '------  -----',
      'step    200',
      'train/loss  nan',
      'train/reward  13.0000',
    ].join('\n')
    expect(parseExperimentLogger(text)).toEqual([
      { step: 100, values: { 'train/loss': 0.5, 'train/reward': 12.25 } },
      { step: 200, values: { 'train/reward': 13 } },
    ])
  })

  it('parses compact step lines and skips records without an integral step', () => {
    const text = [
      '[step=300]  train/loss=0.2500  train/reward=14.0000',
      'metric  value',
      '[step=350]  train/loss=0.2',
      'prefix [step=400]  train/loss=inf',
      'metric  value',
      '------  -----',
      'train/loss  0.1',
      'metric  value',
      'not a rule',
      'metric  value',
      '------  -----',
      'step  1.5',
      'x  1',
      '[step=99999999999999999999]  loss=1',
      'metric  value',
    ].join('\r\n')
    expect(parseExperimentLogger(text)).toEqual([
      { step: 300, values: { 'train/loss': 0.25, 'train/reward': 14 } },
      { step: 350, values: { 'train/loss': 0.2 } },
      { step: 400, values: {} },
    ])
  })
})

describe('log tails', () => {
  it('keeps the end of a text, starting after the first cut line', () => {
    expect(tail('short', 10)).toBe('short')
    expect(tail('line one\nline two\nline three', 15)).toBe('line three')
    expect(tail('abcdefghij', 4)).toBe('ghij')
  })
})

describe('generic metric log formats', () => {
  it('parses JSON lines after a log prefix under a chosen step key', () => {
    const text = [
      '2026-10-20 INFO {"step": 5, "loss": 0.5, "nested": {"x": 1}, "tag": "a"}',
      '{"iter": 6, "loss": 0.4, "step": 99}',
      'plain {braces} that are not JSON',
      '[1, 2]',
      '{"loss": 0.3}',
      '{"step": 7.5, "loss": 0.2}',
      '} reversed {',
    ].join('\n')
    expect(parseJsonLines(text, 'step')).toEqual([
      { step: 5, values: { loss: 0.5 } },
      { step: 99, values: { iter: 6, loss: 0.4 } },
    ])
    expect(parseJsonLines(text, 'iter')).toEqual([{ step: 6, values: { loss: 0.4 } }])
  })

  it('parses key=value and key: value lines that carry the step key', () => {
    const text = [
      'epoch 1 | step=10 loss=0.5 lr: 3e-4 acc=.9 name=run1',
      'global_step: 20, loss: 0.25',
      'loss=0.1 without a step',
      'step=1.5 loss=1',
      'version=2.1.3 step=30',
    ].join('\n')
    expect(parseKeyValues(text, 'step')).toEqual([
      { step: 10, values: { loss: 0.5, lr: 3e-4, acc: 0.9 } },
      { step: 30, values: {} },
    ])
    expect(parseKeyValues(text, 'global_step')).toEqual([{ step: 20, values: { loss: 0.25 } }])
  })

  it('parses named groups of a custom pattern and rejects patterns without a step group', () => {
    const regex = compilePattern(String.raw`Iter (?<step>\d+)/\d+ \| loss (?<loss>[\d.]+)(?: \| reward (?<reward>[\d.]+))?`)
    expect(parseRegex('Iter 3/10 | loss 0.5 | reward 2\nIter 4/10 | loss 0.4\nIter x/10 | loss 1', regex)).toEqual([
      { step: 3, values: { loss: 0.5, reward: 2 } },
      { step: 4, values: { loss: 0.4 } },
    ])
    expect(parseRegex('epoch 1.5 loss 2\nepoch 2 loss 1', compilePattern(String.raw`epoch (?<step>[\d.]+) loss (?<loss>\d+)`)))
      .toEqual([{ step: 2, values: { loss: 1 } }])
    expect(() => compilePattern(String.raw`loss (?<loss>\d+)`)).toThrow('named group "step"')
    expect(() => compilePattern('(')).toThrow()
  })

  it('runs every parser of a logs source over the same text', () => {
    const text = '[step=1]  loss=0.5\n{"step": 2, "loss": 0.4}\nIter 3 loss 0.3'
    expect(parseLogs(text, [
      { kind: 'experiment-logger' }, { kind: 'json-lines' }, { kind: 'key-value', stepKey: 'step' },
      { kind: 'regex', pattern: String.raw`Iter (?<step>\d+) loss (?<loss>[\d.]+)` },
    ]).map(record => record.step)).toEqual([1, 2, 1, 3])
    expect(parseLogs(text, [{ kind: 'json-lines', stepKey: 'step' }, { kind: 'key-value' }]).map(record => record.step)).toEqual([2, 1])
  })

  it('validates logs source options and reads with the defaults when a watch names none', async () => {
    const source = logsSource([{ kind: 'json-lines' }])
    expect(source.validate({})).toEqual({})
    expect(source.validate({ parsers: [{ kind: 'key-value', stepKey: 'iter' }] })).toEqual({ parsers: [{ kind: 'key-value', stepKey: 'iter' }] })
    expect(() => source.validate({ parsers: [] })).toThrow('parsers')
    expect(() => source.validate({ parsers: [{ kind: 'regex', pattern: 'loss' }] })).toThrow('parsers.0.pattern: the pattern needs a named group "step"')
    expect(() => source.validate({ parsers: [{ kind: 'regex', pattern: '(?<step>' }] })).toThrow('parsers.0.pattern')
    expect(() => source.validate({ other: 1 })).toThrow()
    const input = { name: 'job-a', logs: '{"step": 1, "loss": 2}\nstep=3 loss=4', options: {} }
    const signal = new AbortController().signal
    expect(await source.read(input, signal)).toEqual([{ step: 1, values: { loss: 2 } }])
    expect(await source.read({ ...input, options: { parsers: [{ kind: 'key-value' }] } }, signal)).toEqual([{ step: 3, values: { loss: 4 } }])
    const failed = logParserSchema.safeParse({ kind: 'unknown' })
    expect(failed.success).toBe(false)
    if (!failed.success) expect(issueText(failed.error)).toMatch(/^kind: /u)
    const root = logParserSchema.safeParse('text')
    if (!root.success) expect(issueText(root.error)).not.toContain(':  ')
  })
})
