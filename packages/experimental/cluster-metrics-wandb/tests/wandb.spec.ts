/** The wandb metric source finds a job's run, reads its history through the W&B API, and reports every failure by name. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ClusterMetricProvider } from '@deepseek-ai/dsh-experimental-cluster-monitor'
import * as Wandb from '../src/index.ts'
import { findRun, historyRecords, parseRun } from '../src/index.ts'

const contexts: Context[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

const HOSTS = ['wandb.ai']
const signal = new AbortController().signal

async function boot(key: string | null = 'secret', config: Partial<Wandb.Config> = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  const registered = new Map<string, ClusterMetricProvider>()
  const unregister = vi.fn()
  ctx.provide('clusterMonitor', {
    registerMetricSource: (kind: string, provider: ClusterMetricProvider) => {
      registered.set(kind, provider)
      return () => { unregister(kind); registered.delete(kind) }
    },
  } as never)
  const resolve = vi.fn(async () => key === null ? undefined : { value: key, source: 'environment' })
  ctx.provide('credentials', { resolve } as never)
  await ctx.plugin(Wandb, config)
  return { ctx, registered, unregister, resolve, source: () => registered.get('wandb')! }
}

function answer(body: unknown, init: ResponseInit = {}) {
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify(body), { status: 200, ...init }))
  vi.stubGlobal('fetch', fetch)
  return fetch
}

const history = (rows: object[]) => ({ data: { project: { run: { history: rows.map(row => JSON.stringify(row)) } } } })

describe('W&B run references', () => {
  it('reads entity/project/run paths and run URLs on the accepted hosts', () => {
    expect(parseRun(' team/rlh/abc123 ', HOSTS)).toEqual({ entity: 'team', project: 'rlh', run: 'abc123' })
    expect(parseRun('team/rlh/runs/abc123', HOSTS)).toEqual({ entity: 'team', project: 'rlh', run: 'abc123' })
    expect(parseRun('https://wandb.ai/team/rlh/runs/abc123?nw=1', HOSTS)).toEqual({ entity: 'team', project: 'rlh', run: 'abc123' })
    expect(parseRun('https://github.com/team/rlh/runs/1', HOSTS)).toBeUndefined()
    expect(parseRun('team/rlh', HOSTS)).toBeUndefined()
  })

  it('finds the last run URL a log prints on an accepted host', () => {
    const log = [
      'wandb: 🚀 View run g1 at: https://wandb.ai/team/rlh/runs/first',
      'see https://github.com/team/rlh/actions/runs/9',
      'wandb: 🚀 View run g1 at: https://eu.wandb.ai:443/team/rlh/runs/second',
      'https://wandb.example.com/self/hosted/runs/third',
    ].join('\n')
    expect(findRun(log, HOSTS)).toEqual({ entity: 'team', project: 'rlh', run: 'second' })
    expect(findRun(log, ['wandb.example.com'])).toEqual({ entity: 'self', project: 'hosted', run: 'third' })
    expect(findRun('no runs', HOSTS)).toBeUndefined()
  })

  it('keeps rows with an integer _step and their finite public values', () => {
    expect(historyRecords([
      JSON.stringify({ _step: 1, _runtime: 3, loss: 0.5, tag: 'a', reward: 2 }),
      JSON.stringify({ _step: 2.5, loss: 0.4 }),
      JSON.stringify({ loss: 0.3 }),
      JSON.stringify([1]),
      JSON.stringify(null),
      '{not json',
    ])).toEqual([{ step: 1, values: { loss: 0.5, reward: 2 } }])
  })
})

describe('wandb metric source', () => {
  it('registers under wandb and unregisters on disposal', async () => {
    const b = await boot()
    expect([...b.registered.keys()]).toEqual(['wandb'])
    await b.ctx.fiber.dispose()
    expect(b.unregister).toHaveBeenCalledWith('wandb')
  })

  it('validates the run option', async () => {
    const { source } = await boot()
    expect(source().validate({})).toEqual({})
    expect(source().validate({ run: 'team/rlh/abc' })).toEqual({ run: 'team/rlh/abc' })
    expect(() => source().validate({ run: 'nonsense' })).toThrow('"nonsense" is neither entity/project/run-id nor a run URL on wandb.ai')
    expect(() => source().validate({ run: 3 })).toThrow('wandb options take only run, a string')
    expect(() => source().validate({ entity: 'team' })).toThrow('wandb options take only run')
  })

  it('reads the history of the named or logged run with the API key', async () => {
    const { source, resolve } = await boot('secret', { baseUrl: 'https://wandb.internal/', samples: 50 })
    const fetch = answer(history([{ _step: 3, loss: 0.25 }, { _step: 1, loss: 1 }]))
    const named = await source().read({ name: 'job-a', options: { run: 'team/rlh/abc' }, logs: '' }, signal)
    expect(named).toEqual([{ step: 3, values: { loss: 0.25 } }, { step: 1, values: { loss: 1 } }])
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe('https://wandb.internal/graphql')
    expect(init.headers).toMatchObject({ authorization: `Basic ${btoa('api:secret')}` })
    expect(JSON.parse(init.body as string)).toMatchObject({ variables: { entity: 'team', project: 'rlh', run: 'abc', samples: 50 } })
    expect(resolve).toHaveBeenCalledWith('WANDB_API_KEY')
    await source().read({ name: 'job-a', options: {}, logs: 'wandb: View run at https://wandb.ai/me/proj/runs/r1' }, signal)
    expect(JSON.parse(fetch.mock.calls[1]![1].body as string)).toMatchObject({ variables: { entity: 'me', project: 'proj', run: 'r1' } })
  })

  it('names a missing run, key, project, or answer', async () => {
    const read = (source: ClusterMetricProvider, logs = 'https://wandb.ai/me/proj/runs/r1') => source.read({ name: 'job-a', options: {}, logs }, signal)
    const missingKey = await boot(null)
    await expect(read(missingKey.source(), 'no url')).rejects.toThrow('no W&B run URL in the job log yet')
    await expect(read(missingKey.source())).rejects.toThrow('the W&B API key WANDB_API_KEY is not set')
    const { source } = await boot()
    answer({ errors: [{ message: 'permission denied' }] })
    await expect(read(source())).rejects.toThrow('W&B API: permission denied')
    answer({ data: { project: null } })
    await expect(read(source())).rejects.toThrow('W&B project me/proj was not found')
    answer({ data: null })
    await expect(read(source())).rejects.toThrow('W&B project me/proj was not found')
    answer({ data: { project: { run: null } } })
    await expect(read(source())).rejects.toThrow('W&B run me/proj/r1 was not found')
    answer({ data: { project: { run: { history: 'rows' } } } })
    await expect(read(source())).rejects.toThrow('unexpected body')
    answer({}, { status: 401, statusText: 'Unauthorized' })
    await expect(read(source())).rejects.toThrow('W&B API answered 401 Unauthorized')
    answer({}, { status: 500, statusText: '' })
    await expect(read(source())).rejects.toThrow(/^W&B API answered 500$/u)
  })
})
