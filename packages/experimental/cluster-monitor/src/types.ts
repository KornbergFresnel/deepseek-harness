/** Client-safe records of the `cluster` Remote namespace: watched SSP jobs, their training curves, and log tails. */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-typert-protocol'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** No watched job carries that id. */
    'cluster/not-found': { readonly watchId: string }
    /** The job name or workspace is not a valid SSP reference. */
    'cluster/invalid-job': { readonly reason: string }
    /** The metric source kind is not registered, or its options are invalid. */
    'cluster/invalid-metrics': { readonly kind: string; readonly reason: string }
  }
}

/** Host-assigned id of one watched job. */
export type ClusterWatchId = Branded<'ClusterWatchId'>

/**
 * Lifecycle bucket derived from the raw SSP `state` string.
 * `succeeded`, `failed`, and `stopped` are terminal: polling ends after one final read.
 */
export type ClusterJobPhase = 'pending' | 'running' | 'succeeded' | 'failed' | 'stopped' | 'unknown'

/** How a job entered the watch list. */
export type ClusterWatchOrigin = 'created' | 'manual'

/**
 * Where a watch reads its training metrics: a registered metric source kind and that source's options.
 * The monitor registers `logs`; other plugins register more kinds through `registerMetricSource`.
 */
export interface ClusterMetricSource {
  readonly kind: string
  /** Options the source validates when the watch is configured; omitted uses the source's defaults. */
  readonly options?: Readonly<Record<string, JsonValue>>
}

/**
 * One way the `logs` source reads metric records from log text.
 * - `experiment-logger`: rlightning-humanoid `ExperimentLogger` tables (`metric  value`) and `[step=N]  key=value` lines.
 * - `json-lines`: lines holding one JSON object with an integer step under `stepKey` (default `step`) and numeric metrics.
 * - `key-value`: lines with `stepKey=N` (or `stepKey: N`) followed by numeric `key=value` or `key: value` pairs.
 * - `regex`: a JavaScript pattern, compiled with the `u` flag, whose named group `step` captures the step and whose other
 *   named groups capture metric values named after the group.
 */
export type ClusterLogParser =
  | {
    /** Parser kind. */
    readonly kind: 'experiment-logger'
  }
  | {
    /** Parser kind. */
    readonly kind: 'json-lines'
    /** Key of the integer step; omitted reads `step`. */
    readonly stepKey?: string
  }
  | {
    /** Parser kind. */
    readonly kind: 'key-value'
    /** Key of the integer step; omitted reads `step`. */
    readonly stepKey?: string
  }
  | {
    /** Parser kind. */
    readonly kind: 'regex'
    /** Pattern with a named group `step`; other named groups name metric values. */
    readonly pattern: string
  }

/** One SSP job to watch. */
export interface ClusterWatchRequest {
  /** SSP job name. */
  readonly name: string
  /** SSP workspace; omitted uses the sco gateway default, then the sco profile. */
  readonly workspace?: string
  /** Session the job belongs to; attaches an existing watch that has none. */
  readonly sessionId?: SessionId
  /** What the job does, in a sentence; replaces the stored description of an existing watch. */
  readonly description?: string
  /** Metric source; replaces the stored source of an existing watch and clears its curves. */
  readonly metrics?: ClusterMetricSource
}

/** Changes to one watch; omitted fields stay as they are. */
export interface ClusterWatchChanges {
  /** New description; an empty or blank string removes it. */
  readonly description?: string
  /** New metric source, or null for the configured default; a different source clears the curves. */
  readonly metrics?: ClusterMetricSource | null
}

/** One metric record a source read: a training step and its finite scalar values. */
export interface ClusterMetricRecord {
  readonly step: number
  readonly values: Readonly<Record<string, number>>
}

/** One watched job as the job list shows it. */
export interface ClusterWatchRow {
  readonly id: ClusterWatchId
  readonly name: string
  readonly workspace?: string
  /** Session whose agent submitted the job, or that watched it manually; absent for jobs outside any Session. */
  readonly sessionId?: SessionId
  readonly origin: ClusterWatchOrigin
  /** What the job does, as the submitting agent or the user described it. */
  readonly description?: string
  /** Console display name from the SSP job object. */
  readonly displayName?: string
  /** Effective metric source: the watch's own, or the configured default. */
  readonly metrics: ClusterMetricSource
  /** Whether `metrics` is the configured default rather than the watch's own. */
  readonly metricsDefault: boolean
  /** Last failure of the metric source; cleared by its next success. */
  readonly metricsError?: string
  readonly phase: ClusterJobPhase
  /** SSP `state` exactly as the last successful describe reported it. */
  readonly rawState: string | null
  /** ISO time the job entered the watch list. */
  readonly watchedAt: string
  /** ISO time of the last successful describe. */
  readonly checkedAt?: string
  /** Creation, start, and end times copied from the SSP job object when present. */
  readonly createdAt?: string
  readonly startedAt?: string
  readonly finishedAt?: string
  /** Last failed sco call; cleared by the next success of the same call. */
  readonly error?: string
  /** Highest training step parsed from logs. */
  readonly step?: number
  /** Last value of each training metric at `step`. */
  readonly latest: Readonly<Record<string, number>>
}

/** One training-metric observation. */
export interface ClusterMetricPoint {
  readonly step: number
  readonly value: number
}

/** One training metric's history, ascending by step. */
export interface ClusterMetricSeries {
  readonly name: string
  readonly points: readonly ClusterMetricPoint[]
}

/** One watched job with everything its detail view renders. */
export interface ClusterJobDetail extends ClusterWatchRow {
  readonly series: readonly ClusterMetricSeries[]
  /** Tail of the last log round, at most the configured byte budget. */
  readonly logTail: string
  /** Failure of the last log read; logs of a finished job may be unavailable. */
  readonly logError?: string
  /** Pretty-printed SSP job object from the last describe. */
  readonly describe: string | null
}
