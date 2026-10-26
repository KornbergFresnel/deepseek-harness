/** Metric source providers: the contract other plugins implement and the built-in `logs` source. */

import { z as zod } from 'zod'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { compilePattern, parseLogs } from './parse.ts'
import type { ClusterLogParser, ClusterMetricRecord } from './types.ts'

/** Options of one metric source after its provider validated them. */
export type ClusterMetricOptions = Readonly<Record<string, JsonValue>>

/** What a metric source reads from after each log round of one job. */
export interface ClusterMetricReadInput {
  /** SSP job name. */
  readonly name: string
  /** SSP workspace of the watch, when it names one. */
  readonly workspace?: string
  /** Options the provider validated when the watch was configured; `{}` when the watch gave none. */
  readonly options: ClusterMetricOptions
  /** Full text of the log round just read; a source that reads elsewhere may use it to find its run. */
  readonly logs: string
}

/**
 * A metric source registered under one kind through `ctx.clusterMonitor.registerMetricSource`.
 * The monitor calls `read` after every log round, outside the sco call limit, and keeps only records whose step is above
 * the stored step, so a source may return its whole history each time.
 */
export interface ClusterMetricProvider {
  /**
   * Validate the options a watch names before the monitor stores them.
   * @param options - options from the request, `{}` when it named none.
   * @returns the options to store.
   * @throws Error whose message says which option is invalid.
   */
  validate(options: ClusterMetricOptions): ClusterMetricOptions
  /**
   * Read the job's metric records.
   * @param input - job, validated options, and the latest log text.
   * @param signal - aborted when the monitor unloads.
   * @returns records in any order.
   */
  read(input: ClusterMetricReadInput, signal: AbortSignal): Promise<readonly ClusterMetricRecord[]>
}

const stepKey = zod.string().trim().min(1).exactOptional()

/** JSON validation of one log parser; a `regex` pattern must also compile. */
export const logParserSchema = zod.discriminatedUnion('kind', [
  zod.strictObject({ kind: zod.literal('experiment-logger') }),
  zod.strictObject({ kind: zod.literal('json-lines'), stepKey }),
  zod.strictObject({ kind: zod.literal('key-value'), stepKey }),
  zod.strictObject({ kind: zod.literal('regex'), pattern: zod.string().min(1) }),
]).superRefine((parser, issues) => {
  if (parser.kind !== 'regex') return
  try {
    compilePattern(parser.pattern)
  } catch (error: unknown) {
    /* v8 ignore next -- RegExp and compilePattern throw Error instances; String() keeps a foreign throw readable. */
    issues.addIssue({ code: 'custom', path: ['pattern'], message: error instanceof Error ? error.message : String(error) })
  }
})

const logsOptionsSchema = zod.strictObject({ parsers: zod.array(logParserSchema).min(1).optional() })

/**
 * Render the first zod issue as `path: message`.
 * @param error - failed parse.
 * @returns the issue text.
 */
export function issueText(error: zod.ZodError): string {
  const issue = error.issues[0]
  /* v8 ignore next -- a failed zod parse always carries at least one issue. */
  if (issue === undefined) return 'invalid options'
  return issue.path.length === 0 ? issue.message : `${issue.path.join('.')}: ${issue.message}`
}

/**
 * Create the built-in `logs` source, which parses the log round the monitor already read.
 * @param defaults - parsers used when a watch names none.
 * @returns the provider.
 */
export function logsSource(defaults: readonly ClusterLogParser[]): ClusterMetricProvider {
  return {
    validate(options) {
      const parsed = logsOptionsSchema.safeParse(options)
      if (!parsed.success) throw new Error(issueText(parsed.error))
      return options
    },
    read(input) {
      const parsed = logsOptionsSchema.parse(input.options)
      return Promise.resolve(parseLogs(input.logs, parsed.parsers ?? defaults))
    },
  }
}
