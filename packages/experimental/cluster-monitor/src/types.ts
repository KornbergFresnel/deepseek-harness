/** Client-safe records of the `cluster` Remote namespace: watched SSP jobs, their training curves, and log tails. */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-typert-protocol'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** No watched job carries that id. */
    'cluster/not-found': { readonly watchId: string }
    /** The job name or workspace is not a valid SSP reference. */
    'cluster/invalid-job': { readonly reason: string }
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

/** One SSP job to watch. */
export interface ClusterWatchRequest {
  /** SSP job name. */
  readonly name: string
  /** SSP workspace; omitted uses the sco gateway default, then the sco profile. */
  readonly workspace?: string
  /** Session the job belongs to; attaches an existing watch that has none. */
  readonly sessionId?: SessionId
}

/** One watched job as the job list shows it. */
export interface ClusterWatchRow {
  readonly id: ClusterWatchId
  readonly name: string
  readonly workspace?: string
  /** Session whose agent submitted the job, or that watched it manually; absent for jobs outside any Session. */
  readonly sessionId?: SessionId
  readonly origin: ClusterWatchOrigin
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
