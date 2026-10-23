/** Host-side watch list for SenseCore SSP jobs: polls state and logs through `ctx.sco` and serves the `cluster` Remote namespace. */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {} from '@deepseek-ai/dsh-experimental-sco'
import type { ScoJobCreated } from '@deepseek-ai/dsh-experimental-sco'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { compilePattern, isTerminal, jobFacts, tail } from './parse.ts'
import { logsSource } from './sources.ts'
import type { ClusterMetricProvider } from './sources.ts'
import type {
  ClusterJobDetail, ClusterJobPhase, ClusterLogParser, ClusterMetricRecord, ClusterMetricSeries, ClusterMetricSource, ClusterWatchChanges,
  ClusterWatchId, ClusterWatchOrigin, ClusterWatchRequest, ClusterWatchRow,
} from './types.ts'

export type * from './types.ts'
export type * from './sources.ts'
export { logParserSchema } from './sources.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Experimental SSP job monitor and its `cluster` Remote namespace. */
    clusterMonitor: ClusterMonitor
  }
}

/** Polling cadence, retention, and automatic watching. */
export interface Config {
  /** Poll interval in milliseconds for a running job: describe, then one log round. */
  runningPollMs: number
  /** Poll interval in milliseconds for a pending or unrecognized job: describe only. */
  pendingPollMs: number
  /** Concurrent `sco` invocations across all watched jobs. */
  maxConcurrentCalls: number
  /** Retained log tail per job, in UTF-16 code units. */
  logTailLength: number
  /** Retained points per training metric; older points are thinned to half when exceeded. */
  maxPointsPerSeries: number
  /** Retained pretty-printed job object, in UTF-16 code units. */
  describeLength: number
  /** Watch every job that `ctx.sco` creates. */
  watchCreatedJobs: boolean
  /** Metric source kind of a watch that names none; a plugin other than the monitor must register any kind but `logs`. */
  defaultMetricSource: string
  /** Parsers of the `logs` source when a watch names none. */
  logParsers: ClusterLogParser[]
}

const DESCRIPTION_LENGTH = 500

const phaseSchema = zod.enum(['pending', 'running', 'succeeded', 'failed', 'stopped', 'unknown'])

const watchRecordSchema = zod.object({
  id: zod.string(),
  name: zod.string(),
  workspace: zod.string().optional(),
  sessionId: zod.string().optional(),
  description: zod.string().optional(),
  displayName: zod.string().optional(),
  metrics: zod.object({ kind: zod.string(), options: zod.record(zod.string(), zod.json()).exactOptional() }).optional(),
  metricsError: zod.string().optional(),
  origin: zod.enum(['created', 'manual']),
  phase: phaseSchema,
  rawState: zod.string().nullable(),
  watchedAt: zod.string(),
  checkedAt: zod.string().optional(),
  createdAt: zod.string().optional(),
  startedAt: zod.string().optional(),
  finishedAt: zod.string().optional(),
  error: zod.string().optional(),
  step: zod.number().optional(),
  series: zod.record(zod.string(), zod.array(zod.tuple([zod.number(), zod.number()]))),
  describe: zod.string().nullable(),
})

/** Durable form of one watch; series are `[step, value]` pairs ascending by step. */
type WatchRecord = zod.infer<typeof watchRecordSchema>

const clusterDomain = defineDomain({
  name: 'cluster_monitor',
  version: 1,
  tables: { watches: domainTable<string, WatchRecord>(watchRecordSchema) },
})

/** Volatile per-watch state that is re-read after a Host restart. */
interface LiveWatch {
  record: WatchRecord
  logTail: string
  logError?: string
  /** Cancels the pending poll timer. */
  cancelTimer?: () => void
  /** Set while a poll runs, so a refresh joins it instead of overlapping. */
  polling?: Promise<void>
}

const JOB_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/u

function watchKey(name: string, workspace: string | undefined): string {
  return `${workspace ?? ''}/${name}`
}

function message(error: unknown): string {
  /* v8 ignore next -- sco, storage, and Remote failures are Error instances; String() keeps a foreign throw readable. */
  return error instanceof Error ? error.message : String(error)
}

/** Stable text of a metric source, for telling whether a change replaces it. */
function sourceKey(source: ClusterMetricSource | undefined): string {
  return source === undefined ? '' : JSON.stringify([source.kind, source.options ?? null])
}

/** The fields a poll does not own, copied from the latest record so a poll never reverts a concurrent change. */
function annotations(record: WatchRecord): Pick<WatchRecord, 'sessionId' | 'description' | 'metrics'> {
  return {
    ...record.sessionId === undefined ? {} : { sessionId: record.sessionId },
    ...record.description === undefined ? {} : { description: record.description },
    ...record.metrics === undefined ? {} : { metrics: record.metrics },
  }
}

/** Copy a record without the named optional fields. */
function without(record: WatchRecord, ...keys: (keyof WatchRecord)[]): WatchRecord {
  const omitted = new Set<string>(keys)
  return Object.fromEntries(Object.entries(record).filter(([key]) => !omitted.has(key))) as WatchRecord
}

function row(record: WatchRecord, fallback: string): ClusterWatchRow {
  const latest: Record<string, number> = {}
  if (record.step !== undefined) {
    for (const [name, points] of Object.entries(record.series)) {
      const last = points.at(-1)
      if (last !== undefined && last[0] === record.step) latest[name] = last[1]
    }
  }
  return {
    id: brandString<ClusterWatchId>(record.id),
    name: record.name,
    ...record.workspace === undefined ? {} : { workspace: record.workspace },
    ...record.sessionId === undefined ? {} : { sessionId: brandString<SessionId>(record.sessionId) },
    origin: record.origin,
    ...record.description === undefined ? {} : { description: record.description },
    ...record.displayName === undefined ? {} : { displayName: record.displayName },
    metrics: record.metrics ?? { kind: fallback },
    metricsDefault: record.metrics === undefined,
    ...record.metricsError === undefined ? {} : { metricsError: record.metricsError },
    phase: record.phase,
    rawState: record.rawState,
    watchedAt: record.watchedAt,
    ...record.checkedAt === undefined ? {} : { checkedAt: record.checkedAt },
    ...record.createdAt === undefined ? {} : { createdAt: record.createdAt },
    ...record.startedAt === undefined ? {} : { startedAt: record.startedAt },
    ...record.finishedAt === undefined ? {} : { finishedAt: record.finishedAt },
    ...record.error === undefined ? {} : { error: record.error },
    ...record.step === undefined ? {} : { step: record.step },
    latest,
  }
}

/** Halve a series by keeping every other point, always keeping the newest. */
function thin(points: [number, number][]): [number, number][] {
  return points.filter((_, index) => (points.length - 1 - index) % 2 === 0)
}

/**
 * Watches SSP jobs and serves their state, training curves, and log tails to browser clients.
 * Polling runs on the Host without the model; nothing here enters a model request.
 */
export default class ClusterMonitor extends TypertRemoteService {
  static inject = ['sco', 'storageDomain']

  static Config: z<Config> = z.object({
    runningPollMs: z.natural().min(5_000).default(30_000),
    pendingPollMs: z.natural().min(5_000).default(60_000),
    maxConcurrentCalls: z.natural().min(1).default(4),
    logTailLength: z.natural().min(1_024).default(65_536),
    maxPointsPerSeries: z.natural().min(16).default(2_000),
    describeLength: z.natural().min(1_024).default(32_768),
    watchCreatedJobs: z.boolean().default(true),
    defaultMetricSource: z.string().min(1).default('logs'),
    logParsers: z.array(z.union([
      z.object({ kind: z.const('experiment-logger').required() }),
      z.object({ kind: z.const('json-lines').required(), stepKey: z.string().min(1) }),
      z.object({ kind: z.const('key-value').required(), stepKey: z.string().min(1) }),
      z.object({ kind: z.const('regex').required(), pattern: z.string().min(1).required() }),
    ])).default([{ kind: 'experiment-logger' }, { kind: 'json-lines' }, { kind: 'key-value' }]),
  })

  private readonly watches = new Map<string, LiveWatch>()
  /** Watches being created, so a second request for the same job joins the first instead of creating a duplicate. */
  private readonly adding = new Map<string, Promise<LiveWatch>>()
  private readonly providers = new Map<string, ClusterMetricProvider>()
  private readonly listeners = new Set<() => void>()
  private readonly waiting: (() => void)[] = []
  private readonly domain: Promise<Domain<typeof clusterDomain>>
  private readonly lifetime = new AbortController()
  private active = 0
  private disposed = false

  /**
   * @param ctx - Host context providing `sco` and `storageDomain`.
   * @param config - validated cadence and retention.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'clusterMonitor', { namespace: 'cluster' })
    for (const parser of config.logParsers) if (parser.kind === 'regex') compilePattern(parser.pattern)
    this.providers.set('logs', logsSource(config.logParsers))
    this.domain = ctx.storageDomain.open(clusterDomain)
    ctx.effect(async () => {
      const domain = await this.domain
      for (const [key, record] of domain.table('watches').entries()) {
        const watch: LiveWatch = { record, logTail: '' }
        this.watches.set(key, watch)
        if (!isTerminal(record.phase)) this.schedule(key, watch, 0)
      }
      this.notify()
      return async () => {
        this.disposed = true
        this.lifetime.abort(new Error('cluster monitor disposed'))
        for (const watch of this.watches.values()) watch.cancelTimer?.()
        for (const release of this.waiting.splice(0)) release()
        await Promise.allSettled([...this.watches.values()].flatMap(watch => watch.polling === undefined ? [] : [watch.polling]))
        await domain.close()
      }
    }, 'cluster-monitor: resume stored watches; stop polling and close the domain on disposal')
    if (config.watchCreatedJobs) {
      ctx.on('sco/job-created', (event: ScoJobCreated) => {
        this.add(event, 'created').catch((error: unknown) => {
          ctx.logger.warn(`cluster-monitor: could not watch created job ${event.name}: ${message(error)}`)
        })
      })
    }
  }

  /**
   * List every watched job, newest first.
   * @returns one row per watch.
   */
  @Remote
  list(): ClusterWatchRow[] {
    return this.rows()
  }

  /**
   * Follow the watch list: the current rows, then the complete list after each change.
   * @param signal - stream lifetime.
   * @returns complete row lists.
   */
  @Remote({ mode: 'stream' })
  async *follow(signal: AbortSignal): AsyncIterable<ClusterWatchRow[]> {
    for await (const _ of this.changes(signal)) yield this.rows()
  }

  /**
   * Read one watched job with its curves, log tail, and job object.
   * @param watchId - watch id from a row.
   * @returns the job detail.
   */
  @Remote
  detail(watchId: ClusterWatchId): ClusterJobDetail {
    return this.detailOf(this.find(watchId))
  }

  /**
   * Follow one watched job: its detail now and after each change, ending when the watch is removed.
   * @param watchId - watch id from a row.
   * @param signal - stream lifetime.
   * @returns complete job details.
   */
  @Remote({ mode: 'stream' })
  async *followJob(watchId: ClusterWatchId, signal: AbortSignal): AsyncIterable<ClusterJobDetail> {
    this.find(watchId)
    for await (const _ of this.changes(signal)) {
      const watch = this.byId(watchId)
      if (watch === undefined) return
      yield this.detailOf(watch)
    }
  }

  /**
   * Start watching a job, or return the existing watch of the same job and workspace.
   * A Session named by the request attaches to an existing watch that has none.
   * @param request - job name, optional workspace, and optional Session.
   * @returns the watch row.
   */
  @Remote
  async watch(request: ClusterWatchRequest): Promise<ClusterWatchRow> {
    return this.rowOf((await this.add(request, 'manual')).record)
  }

  /**
   * Stop watching a job and delete its stored curves; the SSP job itself is untouched.
   * @param watchId - watch id from a row.
   * @returns after the record is deleted.
   */
  @Remote
  async unwatch(watchId: ClusterWatchId): Promise<void> {
    const watch = this.find(watchId)
    const key = watchKey(watch.record.name, watch.record.workspace)
    watch.cancelTimer?.()
    this.watches.delete(key)
    await (await this.domain).table('watches').delete(key)
    this.notify()
  }

  /**
   * Poll one job now, including a finished one, and wait for the result.
   * @param watchId - watch id from a row.
   * @returns after the poll is stored.
   */
  @Remote
  async refresh(watchId: ClusterWatchId): Promise<void> {
    const watch = this.find(watchId)
    watch.cancelTimer?.()
    await this.poll(watchKey(watch.record.name, watch.record.workspace), watch, true)
  }

  /**
   * List the registered metric source kinds.
   * @returns kinds in registration order, starting with `logs`.
   */
  @Remote
  metricSources(): string[] {
    return [...this.providers.keys()]
  }

  /**
   * Change a watch's description or metric source. A different source clears the curves and polls the job's logs again.
   * @param watchId - watch id from a row.
   * @param changes - fields to change.
   * @returns the updated row.
   */
  @Remote
  async configure(watchId: ClusterWatchId, changes: ClusterWatchChanges): Promise<ClusterWatchRow> {
    const watch = this.find(watchId)
    const key = watchKey(watch.record.name, watch.record.workspace)
    await this.apply(key, watch, {
      ...changes.description === undefined ? {} : { description: changes.description },
      ...changes.metrics === undefined ? {} : { metrics: changes.metrics },
    })
    return this.rowOf(watch.record)
  }

  /**
   * Register a metric source kind. Watches name it in `metrics.kind`; one that names a kind no plugin registers reports that on every poll.
   * @param kind - source kind; `logs` and every registered kind are taken.
   * @param provider - option validation and the metric read.
   * @returns disposer that unregisters the kind.
   */
  registerMetricSource(kind: string, provider: ClusterMetricProvider): () => void {
    if (this.providers.has(kind)) throw new Error(`cluster-monitor: metric source "${kind}" is already registered`)
    this.providers.set(kind, provider)
    this.notify()
    return () => {
      if (this.providers.get(kind) === provider) this.providers.delete(kind)
      this.notify()
    }
  }

  private rowOf(record: WatchRecord): ClusterWatchRow {
    return row(record, this.config.defaultMetricSource)
  }

  private rows(): ClusterWatchRow[] {
    return [...this.watches.values()].map(watch => this.rowOf(watch.record))
      .toSorted((left, right) => right.watchedAt.localeCompare(left.watchedAt))
  }

  private detailOf(watch: LiveWatch): ClusterJobDetail {
    const series: ClusterMetricSeries[] = Object.entries(watch.record.series)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([name, points]) => ({ name, points: points.map(([step, value]) => ({ step, value })) }))
    return {
      ...this.rowOf(watch.record),
      series,
      logTail: watch.logTail,
      ...watch.logError === undefined ? {} : { logError: watch.logError },
      describe: watch.record.describe,
    }
  }

  private byId(watchId: ClusterWatchId): LiveWatch | undefined {
    for (const watch of this.watches.values()) if (watch.record.id === watchId) return watch
    return undefined
  }

  private find(watchId: ClusterWatchId): LiveWatch {
    const watch = this.byId(watchId)
    if (watch === undefined) throw new RemoteError('cluster/not-found', `no watched job "${watchId}"`, { watchId })
    return watch
  }

  private async add(request: ClusterWatchRequest, origin: ClusterWatchOrigin): Promise<LiveWatch> {
    const name = request.name.trim()
    const workspace = request.workspace?.trim()
    if (!JOB_NAME.test(name)) {
      throw new RemoteError('cluster/invalid-job', `invalid SSP job name "${request.name}"`, { reason: 'name' })
    }
    if (workspace === '') throw new RemoteError('cluster/invalid-job', 'workspace must not be empty', { reason: 'workspace' })
    const changes = {
      ...request.description === undefined ? {} : { description: request.description },
      ...request.metrics === undefined ? {} : { metrics: request.metrics },
    }
    // Validate before creating, so an invalid request never leaves a watch behind.
    this.annotate({ name, origin, phase: 'unknown', rawState: null, watchedAt: '', series: {}, describe: null, id: '' }, changes)
    const key = watchKey(name, workspace)
    let watch = this.watches.get(key)
    if (watch === undefined) {
      let pending = this.adding.get(key)
      if (pending === undefined) {
        pending = this.create(key, name, workspace, request.sessionId, origin).finally(() => { this.adding.delete(key) })
        this.adding.set(key, pending)
      }
      watch = await pending
    }
    await this.apply(key, watch, {
      ...changes,
      ...request.sessionId === undefined || watch.record.sessionId !== undefined ? {} : { sessionId: request.sessionId },
    })
    return watch
  }

  private async create(
    key: string, name: string, workspace: string | undefined, sessionId: SessionId | undefined, origin: ClusterWatchOrigin,
  ): Promise<LiveWatch> {
    const domain = await this.domain
    const record: WatchRecord = {
      id: `cw-${randomUUID()}`,
      name,
      ...workspace === undefined ? {} : { workspace },
      ...sessionId === undefined ? {} : { sessionId },
      origin,
      phase: 'unknown',
      rawState: null,
      watchedAt: new Date().toISOString(),
      series: {},
      describe: null,
    }
    await domain.table('watches').put(key, record)
    const watch: LiveWatch = { record, logTail: '' }
    this.watches.set(key, watch)
    this.notify()
    this.schedule(key, watch, 0)
    return watch
  }

  /**
   * Return a record with a new description, metric source, or Session; a replaced source drops the curves.
   * @throws RemoteError for a description over the length limit or an unregistered or invalid source.
   */
  private annotate(
    record: WatchRecord, changes: { description?: string; metrics?: ClusterMetricSource | null; sessionId?: string },
  ): WatchRecord {
    let next = record
    if (changes.description !== undefined) {
      const description = changes.description.trim()
      if (description.length > DESCRIPTION_LENGTH) {
        throw new RemoteError('cluster/invalid-job', `description is longer than ${DESCRIPTION_LENGTH} characters`, { reason: 'description' })
      }
      next = description === '' ? without(next, 'description') : { ...next, description }
    }
    if (changes.metrics !== undefined) {
      const metrics = changes.metrics === null ? undefined : this.validSource(changes.metrics)
      if (sourceKey(metrics) !== sourceKey(next.metrics)) {
        next = { ...without(next, 'metrics', 'metricsError', 'step'), series: {}, ...metrics === undefined ? {} : { metrics } }
      }
    }
    if (changes.sessionId !== undefined) next = { ...next, sessionId: changes.sessionId }
    return next
  }

  /** Store the changes when they alter the record; a replaced metric source polls the logs again. */
  private async apply(key: string, watch: LiveWatch, changes: Parameters<ClusterMonitor['annotate']>[1]): Promise<void> {
    const before = watch.record
    const next = this.annotate(before, changes)
    if (next === before) return
    await (await this.domain).table('watches').put(key, next)
    watch.record = next
    this.notify()
    if (sourceKey(next.metrics) !== sourceKey(before.metrics)) {
      watch.cancelTimer?.()
      this.poll(key, watch, true).catch(
        /* v8 ignore next 3 -- only a failed durable write of the watch record rejects a poll. */
        (error: unknown) => {
          this.ctx.logger.warn(`cluster-monitor: poll of ${key} failed: ${message(error)}`)
        })
    }
  }

  private validSource(source: ClusterMetricSource): NonNullable<WatchRecord['metrics']> {
    const provider = this.providers.get(source.kind)
    if (provider === undefined) {
      const known = [...this.providers.keys()].join(', ')
      throw new RemoteError('cluster/invalid-metrics', `no metric source "${source.kind}" is registered; registered: ${known}`, {
        kind: source.kind, reason: 'unregistered',
      })
    }
    try {
      const options = provider.validate(source.options ?? {})
      return source.options === undefined ? { kind: source.kind } : { kind: source.kind, options }
    } catch (error: unknown) {
      throw new RemoteError('cluster/invalid-metrics', `invalid ${source.kind} metric options: ${message(error)}`, {
        kind: source.kind, reason: message(error),
      })
    }
  }

  private schedule(key: string, watch: LiveWatch, delayMs: number): void {
    watch.cancelTimer?.()
    const timer = setTimeout(() => {
      delete watch.cancelTimer
      this.poll(key, watch, false).catch(
        /* v8 ignore next 3 -- only a failed durable write of the watch record rejects a poll. */
        (error: unknown) => {
          this.ctx.logger.warn(`cluster-monitor: poll of ${key} failed: ${message(error)}`)
        })
    }, delayMs)
    watch.cancelTimer = () => { clearTimeout(timer) }
  }

  private poll(key: string, watch: LiveWatch, forceLogs: boolean): Promise<void> {
    watch.polling ??= this.pollOnce(key, watch, forceLogs).finally(() => { delete watch.polling })
    return watch.polling
  }

  /** Describe the job, read one log round while it runs or right after it ends, then store and reschedule. */
  private async pollOnce(key: string, watch: LiveWatch, forceLogs: boolean): Promise<void> {
    const start = watch.record
    const { name, workspace } = start
    const request = workspace === undefined ? {} : { workspace }
    let next: WatchRecord = { ...start }
    let phase: ClusterJobPhase = next.phase
    try {
      const job = await this.call(signal => this.ctx.sco.describeJob(name, request, signal))
      const facts = jobFacts(job)
      phase = facts.phase
      const kept = without(next, 'error', 'createdAt', 'startedAt', 'finishedAt', 'displayName')
      next = {
        ...kept,
        ...facts,
        checkedAt: new Date().toISOString(),
        describe: JSON.stringify(job, null, 2).slice(0, this.config.describeLength),
      }
    } catch (error: unknown) {
      next = { ...next, error: message(error) }
    }
    const readLogs = forceLogs || phase === 'running' || (isTerminal(phase) && !isTerminal(watch.record.phase))
    if (readLogs) {
      let text = ''
      try {
        text = (await this.call(signal => this.ctx.sco.readLogs(name, request, signal))).text
        watch.logTail = tail(text, this.config.logTailLength)
        delete watch.logError
      } catch (error: unknown) {
        watch.logError = message(error)
      }
      next = await this.readMetrics(next, text)
    }
    if (this.disposed || this.watches.get(key) !== watch) return
    const current = watch.record
    next = { ...without(next, 'sessionId', 'description', 'metrics'), ...annotations(current) }
    if (sourceKey(current.metrics) !== sourceKey(start.metrics)) {
      // The source changed during this poll; its curves restart with the next poll.
      next = { ...without(next, 'step', 'metricsError'), series: {} }
    }
    await (await this.domain).table('watches').put(key, next)
    watch.record = next
    this.notify()
    if (!isTerminal(next.phase)) {
      this.schedule(key, watch, next.phase === 'running' ? this.config.runningPollMs : this.config.pendingPollMs)
    }
  }

  /** Read the watch's metric source after a log round and merge its records, or record why it failed. */
  private async readMetrics(record: WatchRecord, logs: string): Promise<WatchRecord> {
    const source = record.metrics ?? { kind: this.config.defaultMetricSource }
    const provider = this.providers.get(source.kind)
    if (provider === undefined) return { ...record, metricsError: `no metric source "${source.kind}" is registered` }
    try {
      const records = await provider.read({
        name: record.name,
        ...record.workspace === undefined ? {} : { workspace: record.workspace },
        options: source.options ?? {},
        logs,
      }, this.lifetime.signal)
      return this.merge(without(record, 'metricsError'), records)
    } catch (error: unknown) {
      return { ...record, metricsError: message(error) }
    }
  }

  /**
   * Append metric records, in step order, whose step is above the step stored before this read, which repeats
   * earlier records. Records of one step from several printers or parsers merge into one point per metric.
   */
  private merge(record: WatchRecord, metrics: readonly ClusterMetricRecord[]): WatchRecord {
    const baseline = record.step
    let step = baseline
    const series: Record<string, [number, number][]> = { ...record.series }
    for (const metric of metrics.toSorted((left, right) => left.step - right.step)) {
      if (baseline !== undefined && metric.step <= baseline) continue
      step = Math.max(step ?? metric.step, metric.step)
      for (const [name, value] of Object.entries(metric.values)) {
        let points = [...series[name] ?? []]
        if (points.at(-1)?.[0] === metric.step) points[points.length - 1] = [metric.step, value]
        else points.push([metric.step, value])
        if (points.length > this.config.maxPointsPerSeries) points = thin(points)
        series[name] = points
      }
    }
    return { ...record, series, ...step === undefined ? {} : { step } }
  }

  /**
   * Run one sco call under the shared concurrency limit and the service lifetime.
   * A finishing call hands its slot to the oldest waiter instead of releasing it.
   */
  private async call<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.active < this.config.maxConcurrentCalls) this.active++
    else await new Promise<void>((resolve) => { this.waiting.push(resolve) })
    try {
      this.lifetime.signal.throwIfAborted()
      return await operation(this.lifetime.signal)
    } finally {
      const next = this.waiting.shift()
      if (next === undefined) this.active--
      else next()
    }
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }

  /** Yield once now and once after each burst of changes, until the signal aborts. */
  private async *changes(signal: AbortSignal): AsyncIterable<void> {
    let pending = true
    let wake: (() => void) | undefined
    const listener = () => { pending = true; wake?.() }
    const abort = () => { wake?.() }
    this.listeners.add(listener)
    signal.addEventListener('abort', abort)
    try {
      while (!signal.aborted) {
        if (pending) {
          pending = false
          yield
          continue
        }
        await new Promise<void>((resolve) => { wake = resolve })
        wake = undefined
      }
    } finally {
      this.listeners.delete(listener)
      signal.removeEventListener('abort', abort)
    }
  }
}
