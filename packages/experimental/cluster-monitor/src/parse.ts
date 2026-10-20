/** Pure readers for `sco ssp jobs` output: job phase and times, rlightning-humanoid metric lines, and log tails. */

import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ClusterJobPhase } from './types.ts'

/** Facts the monitor keeps from one SSP job object. */
export interface JobFacts {
  readonly rawState: string | null
  readonly phase: ClusterJobPhase
  readonly createdAt?: string
  readonly startedAt?: string
  readonly finishedAt?: string
}

/** One parsed metric record: a training step and its finite scalar values. */
export interface MetricRecord {
  readonly step: number
  readonly values: Readonly<Record<string, number>>
}

const PHASE_PATTERNS: ReadonlyArray<readonly [RegExp, ClusterJobPhase]> = [
  [/fail|error/u, 'failed'],
  [/succe|complet|finish|done/u, 'succeeded'],
  [/stop|cancel|kill|terminat|abort/u, 'stopped'],
  [/run/u, 'running'],
  [/pend|queu|wait|creat|init|schedul|start|submit/u, 'pending'],
]

/**
 * Map an SSP `state` string onto a lifecycle bucket by keyword, case-insensitively.
 * The SSP documentation does not enumerate states, so unmatched text stays `unknown` and keeps polling.
 * @param rawState - state text from the job object, or null when absent.
 * @returns the lifecycle bucket.
 */
export function phaseOf(rawState: string | null): ClusterJobPhase {
  if (rawState === null) return 'unknown'
  const text = rawState.toLowerCase()
  return PHASE_PATTERNS.find(([pattern]) => pattern.test(text))?.[1] ?? 'unknown'
}

/**
 * Report whether polling ends after the current read.
 * @param phase - lifecycle bucket.
 * @returns true for succeeded, failed, and stopped jobs.
 */
export function isTerminal(phase: ClusterJobPhase): boolean {
  return phase === 'succeeded' || phase === 'failed' || phase === 'stopped'
}

type JsonObject = { readonly [key: string]: JsonValue }

function isObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The job object itself and its `status` and `metadata` members, where SSP keeps state and times. */
function scopes(job: JsonValue): JsonObject[] {
  if (!isObject(job)) return []
  return [job, job['status'], job['metadata']].filter(isObject)
}

function firstString(job: JsonValue, keys: readonly string[]): string | undefined {
  for (const scope of scopes(job)) {
    for (const key of keys) {
      const value = scope[key]
      if (typeof value === 'string' && value.length > 0) return value
    }
  }
  return undefined
}

/**
 * Read state and times from one `sco ssp jobs describe --format=json` object.
 * @param job - parsed CLI output.
 * @returns raw state, its phase, and the times that are present.
 */
export function jobFacts(job: JsonValue): JobFacts {
  const rawState = firstString(job, ['state', 'phase', 'status']) ?? null
  const createdAt = firstString(job, ['create_time', 'created_at', 'creation_time'])
  const startedAt = firstString(job, ['start_time', 'started_at'])
  const finishedAt = firstString(job, ['end_time', 'finish_time', 'finished_at', 'completion_time'])
  return {
    rawState,
    phase: phaseOf(rawState),
    ...createdAt === undefined ? {} : { createdAt },
    ...startedAt === undefined ? {} : { startedAt },
    ...finishedAt === undefined ? {} : { finishedAt },
  }
}

const TABLE_HEADER = /^\s*metric\s+value\s*$/u
const TABLE_RULE = /^\s*-+\s+-+\s*$/u
const TABLE_ROW = /^\s*([^\s[]\S*)\s+(\S+)\s*$/u
const COMPACT_LINE = /\[step=(\d+)\]((?:\s+\S+=\S+)*)\s*$/u
const COMPACT_PAIR = /(\S+)=(\S+)/gu

function finite(text: string): number | undefined {
  const value = Number(text)
  return text.length > 0 && Number.isFinite(value) ? value : undefined
}

function record(pairs: Iterable<readonly [string, string]>): MetricRecord | undefined {
  let step: number | undefined
  const values: Record<string, number> = {}
  for (const [key, text] of pairs) {
    const value = finite(text)
    if (value === undefined) continue
    if (key === 'step') step = value
    else values[key] = value
  }
  return step === undefined || !Number.isSafeInteger(step) ? undefined : { step, values }
}

/** Every capture group in the metric patterns participates in any match. */
function group(match: RegExpExecArray, index: number): string {
  return match[index] as string
}

/**
 * Parse the metric output of rlightning-humanoid's `ExperimentLogger`: the two-column
 * `metric  value` table and the compact `[step=N]  key=value` line. Non-finite values are dropped.
 * @param text - log text in any order of other lines.
 * @returns metric records in log order.
 */
export function parseMetrics(text: string): MetricRecord[] {
  const records: MetricRecord[] = []
  const push = (parsed: MetricRecord | undefined): void => { if (parsed !== undefined) records.push(parsed) }
  let rows: [string, string][] | undefined
  let afterHeader = false
  for (const line of text.split(/\r?\n/u)) {
    if (rows !== undefined) {
      const row = TABLE_ROW.exec(line)
      if (row !== null) {
        rows.push([group(row, 1), group(row, 2)])
        continue
      }
      push(record(rows))
      rows = undefined
    }
    if (afterHeader) {
      afterHeader = false
      if (TABLE_RULE.test(line)) {
        rows = []
        continue
      }
    }
    const compact = COMPACT_LINE.exec(line)
    if (compact !== null) {
      const pairs: [string, string][] = [['step', group(compact, 1)]]
      for (const match of group(compact, 2).matchAll(COMPACT_PAIR)) pairs.push([group(match, 1), group(match, 2)])
      push(record(pairs))
      continue
    }
    afterHeader = TABLE_HEADER.test(line)
  }
  if (rows !== undefined) push(record(rows))
  return records
}

/**
 * Keep the end of a text within a UTF-16 length budget, starting at a line boundary when one exists.
 * @param text - full text.
 * @param maxLength - retained length.
 * @returns the retained tail.
 */
export function tail(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  const cut = text.slice(text.length - maxLength)
  const newline = cut.indexOf('\n')
  return newline === -1 ? cut : cut.slice(newline + 1)
}
