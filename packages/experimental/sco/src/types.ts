/** Request and result records for SenseCore SSP training-job operations. */

import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** SSP training frameworks accepted by `sco ssp jobs create --framework`. */
export type ScoFramework = 'PYTORCH_DDP' | 'MPI' | 'RAY_JOB' | 'TENSORFLOW_PS' | 'FRAMEWORK_CUSTOM'

/** SSP scheduling priorities accepted by `sco ssp jobs create --priority`. */
export type ScoPriority = 'NORMAL' | 'HIGH' | 'HIGHEST'

/** SSP image sources accepted by `sco ssp jobs create --image-type`. */
export type ScoImageType = 'OFFICIAL' | 'PRIVATE' | 'THIRD_PARTY'

/** Job-list fields accepted by `sco ssp jobs list --filter`; `name` and `display_name` match by prefix, the rest exactly. */
export type ScoJobFilterField = 'name' | 'display_name' | 'state' | 'queue_id' | 'priority' | 'framework'

/** Workspace selection shared by every SSP job operation; omitted values use the configured default, then the sco profile. */
export type ScoWorkspaceRequest = {
  /** SSP workspace name. */
  workspace?: string
}

/** One `--filter` term; several terms combine with AND. */
export interface ScoJobFilter {
  /** Filtered job field. */
  field: ScoJobFilterField
  /** Matched value. */
  value: string
}

/** Paged, filtered training-job listing. */
export interface ListScoJobsRequest extends ScoWorkspaceRequest {
  /** Page size from 1 to 100. */
  pageSize?: number
  /** Number of jobs to skip. */
  skip?: number
  /** AND-combined filters. */
  filters?: readonly ScoJobFilter[]
  /** Comma-separated `created_at` / `duration` sort keys, each optionally prefixed by `+` or `-`. */
  orderBy?: string
}

/** One running job's log read; omitted worker reads every worker. */
export interface ReadScoJobLogsRequest extends ScoWorkspaceRequest {
  /** Worker name returned by `listWorkers`. */
  worker?: string
  /** Container name; omitted selects the main container. */
  container?: string
}

/** Captured log text of one `stream-logs` round. */
export interface ScoJobLogs {
  /** Retained log text. */
  text: string
  /** True when output exceeded `maxOutputBytes` and only the tail is retained. */
  truncated: boolean
}

/** Parameterized training-job creation, mapped onto `sco ssp jobs create <name>` flags; a type alias so it is a JSON value. */
export type CreateScoJobRequest = ScoWorkspaceRequest & {
  /** Job name: `job-` prefix, lowercase letters, digits, and hyphens, at most 32 characters. */
  name: string
  /** Console display name. */
  displayName?: string
  /** Container image reference. */
  image: string
  /** Image source. */
  imageType?: ScoImageType
  /** Startup command run by the job's `bash -c`. */
  args: string
  /** Training framework; the CLI defaults to `PYTORCH_DDP`. */
  framework?: ScoFramework
  /** Pod count; the CLI defaults to 1. */
  podCount?: number
  /** GPUs per pod; the CLI defaults to 0. */
  gpuCount?: number
  /** CPU cores per pod; required when `gpuCount` is 0. */
  cpuCount?: number
  /** Memory per pod in GiB; required when `gpuCount` is 0. */
  memoryGib?: number
  /** Queue workload machine type (`spec_code`); required when `gpuCount` is positive. */
  machineType?: string
  /** RDMA network name. */
  rdmaName?: string
  /** `/dev/shm` size per pod in GiB. */
  shmSizeGib?: number
  /** Full queue resource id; omitted values use the configured default, then the sco profile. */
  queueId?: string
  /** Scheduling priority. */
  priority?: ScoPriority
  /** Container environment variables. */
  env?: Readonly<Record<string, string>>
  /** Volume mounts in the CLI `PV_AFS:<uuid>:<path>[:<subdir>]` or `PV_AOSS:...` form. */
  volumeMounts?: string[]
  /** Maximum retry attempts after failure (VcJob frameworks only). */
  maxAttempts?: number
  /** Queue when quota is insufficient instead of failing. */
  enableQueuing?: boolean
  /** TensorBoard log path under a mounted AFS volume (VcJob frameworks only). */
  tensorboardLogPath?: string
  /** Validate and return the merged `TrainingJob` without creating it. */
  dryRun?: boolean
}

/** Outcome of one creation request. */
export type ScoJobCreation =
  | { kind: 'dry-run'; job: JsonValue }
  | { kind: 'created'; name: string; output: string }

/** Outcome of one stop request. */
export interface ScoJobStop {
  /** Job names sent to `sco ssp jobs stop`. */
  names: string[]
  /** CLI confirmation text. */
  output: string
}

/** A job the CLI accepted for creation. */
export interface ScoJobCreated {
  /** Created job name. */
  name: string
  /** Workspace named on the command line; absent when the sco profile supplied it. */
  workspace?: string
}
