import { describe, expect, it } from 'vitest'
import { isTerminal, jobFacts, parseMetrics, phaseOf, tail } from '../src/parse.ts'
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
    expect(parseMetrics(text)).toEqual([
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
    expect(parseMetrics(text)).toEqual([
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
