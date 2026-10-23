/** Pure readers for `sco ssp jobs` output: job phase, times, and display name, metric records in log text, and log tails. */

import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ClusterJobPhase, ClusterLogParser, ClusterMetricRecord } from './types.ts'

/** Facts the monitor keeps from one SSP job object. */
export interface JobFacts {
  readonly rawState: string | null
  readonly phase: ClusterJobPhase
  readonly createdAt?: string
  readonly startedAt?: string
  readonly finishedAt?: string
  readonly displayName?: string
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
 * @returns raw state, its phase, and the times and display name that are present.
 */
export function jobFacts(job: JsonValue): JobFacts {
  const rawState = firstString(job, ['state', 'phase', 'status']) ?? null
  const createdAt = firstString(job, ['create_time', 'created_at', 'creation_time'])
  const startedAt = firstString(job, ['start_time', 'started_at'])
  const finishedAt = firstString(job, ['end_time', 'finish_time', 'finished_at', 'completion_time'])
  const displayName = firstString(job, ['display_name', 'displayName'])
  return {
    rawState,
    phase: phaseOf(rawState),
    ...createdAt === undefined ? {} : { createdAt },
    ...startedAt === undefined ? {} : { startedAt },
    ...finishedAt === undefined ? {} : { finishedAt },
    ...displayName === undefined ? {} : { displayName },
  }
}

const lines = (text: string): string[] => text.split(/\r?\n/u)

const TABLE_HEADER = /^\s*metric\s+value\s*$/u
const TABLE_RULE = /^\s*-+\s+-+\s*$/u
const TABLE_ROW = /^\s*([^\s[]\S*)\s+(\S+)\s*$/u
const COMPACT_LINE = /\[step=(\d+)\]((?:\s+\S+=\S+)*)\s*$/u
const COMPACT_PAIR = /(\S+)=(\S+)/gu

function finite(text: string): number | undefined {
  const value = Number(text)
  return text.length > 0 && Number.isFinite(value) ? value : undefined
}

function record(pairs: Iterable<readonly [string, string]>): ClusterMetricRecord | undefined {
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
export function parseExperimentLogger(text: string): ClusterMetricRecord[] {
  const records: ClusterMetricRecord[] = []
  const push = (parsed: ClusterMetricRecord | undefined): void => { if (parsed !== undefined) records.push(parsed) }
  let rows: [string, string][] | undefined
  let afterHeader = false
  for (const line of lines(text)) {
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
 * Parse lines that hold one JSON object, optionally after a log prefix: the text from the first `{` to the last `}`.
 * The step is the integer under `stepKey`; other finite numeric members are metric values, nested objects excluded.
 * @param text - log text.
 * @param stepKey - member holding the step.
 * @returns metric records in log order.
 */
export function parseJsonLines(text: string, stepKey: string): ClusterMetricRecord[] {
  const records: ClusterMetricRecord[] = []
  for (const line of lines(text)) {
    const start = line.indexOf('{')
    const end = line.lastIndexOf('}')
    if (start === -1 || end < start) continue
    let value: JsonValue
    try {
      value = JSON.parse(line.slice(start, end + 1)) as JsonValue
    } catch (_notJson) {
      // Braces around text that is not JSON are an ordinary log line.
      continue
    }
    /* v8 ignore next -- text from `{` to `}` that parses as JSON is always an object; the guard narrows the type. */
    if (!isObject(value)) continue
    const step = value[stepKey]
    if (typeof step !== 'number') continue
    const pairs: [string, string][] = [['step', String(step)]]
    for (const [key, member] of Object.entries(value)) {
      if (key !== stepKey && key !== 'step' && typeof member === 'number') pairs.push([key, String(member)])
    }
    const parsed = record(pairs)
    if (parsed !== undefined) records.push(parsed)
  }
  return records
}

const NUMBER = String.raw`[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?`
const KEY_VALUE = new RegExp(String.raw`([A-Za-z_][\w./-]*)\s*[=:]\s*(${NUMBER})(?![\w.])`, 'gu')

/**
 * Parse lines with a `stepKey=N` or `stepKey: N` pair and numeric `key=value` or `key: value` pairs.
 * @param text - log text.
 * @param stepKey - pair key holding the step.
 * @returns metric records in log order.
 */
export function parseKeyValues(text: string, stepKey: string): ClusterMetricRecord[] {
  const records: ClusterMetricRecord[] = []
  for (const line of lines(text)) {
    const pairs: [string, string][] = []
    let hasStep = false
    for (const match of line.matchAll(KEY_VALUE)) {
      const key = group(match, 1)
      if (key === stepKey) hasStep = true
      pairs.push([key === stepKey ? 'step' : key, group(match, 2)])
    }
    const parsed = hasStep ? record(pairs) : undefined
    if (parsed !== undefined) records.push(parsed)
  }
  return records
}

/**
 * Compile a `regex` parser pattern; it must compile with the `u` flag and name a `step` group.
 * @param pattern - JavaScript pattern source.
 * @returns the compiled expression.
 */
export function compilePattern(pattern: string): RegExp {
  const regex = new RegExp(pattern, 'gu')
  if (!/\(\?<step>/u.test(pattern)) throw new Error('the pattern needs a named group "step"')
  return regex
}

/**
 * Parse every match of a compiled `regex` parser: group `step` is the step, other named groups are metric values.
 * @param text - log text.
 * @param regex - expression from {@link compilePattern}.
 * @returns metric records in log order.
 */
export function parseRegex(text: string, regex: RegExp): ClusterMetricRecord[] {
  const records: ClusterMetricRecord[] = []
  for (const match of text.matchAll(regex)) {
    // compilePattern requires the named group `step`, so every match carries groups.
    const groups = match.groups as Readonly<Record<string, string | undefined>>
    const pairs = Object.entries(groups).flatMap(([key, value]) => value === undefined ? [] : [[key, value] as [string, string]])
    const parsed = record(pairs)
    if (parsed !== undefined) records.push(parsed)
  }
  return records
}

/**
 * Run each parser over the same log text and concatenate their records, parser by parser.
 * @param text - log text.
 * @param parsers - parsers from a validated `logs` source.
 * @returns metric records.
 */
export function parseLogs(text: string, parsers: readonly ClusterLogParser[]): ClusterMetricRecord[] {
  return parsers.flatMap((parser) => {
    switch (parser.kind) {
      case 'experiment-logger': return parseExperimentLogger(text)
      case 'json-lines': return parseJsonLines(text, parser.stepKey ?? 'step')
      case 'key-value': return parseKeyValues(text, parser.stepKey ?? 'step')
      case 'regex': return parseRegex(text, compilePattern(parser.pattern))
    }
  })
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
