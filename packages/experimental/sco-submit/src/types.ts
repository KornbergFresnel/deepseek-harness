/** Source, template, resource-option, and submission records; type aliases so tool results carry them as JSON values. */

import type { CreateScoJobRequest, ScoFramework, ScoImageType, ScoPriority } from '@deepseek-ai/dsh-experimental-sco'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Cluster storage a source lives on. */
export type ScoVolume =
  | {
    /** AI file storage volume. */
    type: 'afs'
    /** Volume UUID. */
    id: string
  }
  | {
    /** AI object storage bucket. */
    type: 'aoss'
    /** Bucket name. */
    bucket: string
    /** Object storage endpoint host. */
    endpoint: string
  }

/** A dataset mounted into jobs at a fixed path. */
export type ScoDataSource = {
  kind: 'data'
  volume: ScoVolume
  /** Directory (AFS) or prefix (AOSS) inside the volume; omitted mounts the volume root. */
  path?: string
  /** Absolute mount path inside the container. */
  mountPath: string
  /** What the data is, for the model and the user. */
  description?: string
}

/** Code snapshots stored as `<root>/<ref>/` directories and mounted at a fixed path. */
export type ScoCodeSource = {
  kind: 'code'
  volume: ScoVolume
  /** Directory holding one subdirectory per ref. */
  root: string
  /** Absolute mount path inside the container; the startup command runs there. */
  mountPath: string
  /** Ref used when a submission names none. */
  defaultRef: string
  /** Shell command run in the code directory before the job command. */
  setup?: string
  /** What the code is, for the model and the user. */
  description?: string
}

/** Output storage; each job mounts `<root>/<job name>/` at the configured output mount path. */
export type ScoOutputSource = {
  kind: 'output'
  volume: ScoVolume
  /** Directory holding one subdirectory per job. */
  root: string
  /** What the outputs are, for the model and the user. */
  description?: string
}

/** A registered data, code, or output location. */
export type ScoSource = ScoDataSource | ScoCodeSource | ScoOutputSource

/** Image, sources, command, and resource defaults that a submission starts from. */
export type ScoJobTemplate = {
  /** What the template runs, for the model and the user. */
  description?: string
  /** Container image reference. */
  image?: string
  /** Image source type passed as `--image-type`. */
  imageType?: ScoImageType
  /** Code source name. */
  code?: string
  /** Code ref; omitted uses the code source's `defaultRef`. */
  ref?: string
  /** Data source names. */
  data?: string[]
  /** Output source name. */
  output?: string
  /** Job command, run in the code directory after `setup`. */
  command?: string
  /** Environment variables; values must not contain commas. */
  env?: Record<string, string>
  /** Training framework; the CLI defaults to `PYTORCH_DDP`. */
  framework?: ScoFramework
  /** Pods; the CLI defaults to 1. */
  podCount?: number
  /** GPUs per pod; GPU jobs also need `machineType`. */
  gpuCount?: number
  /** CPU cores per pod; required when `gpuCount` is 0. */
  cpuCount?: number
  /** Memory per pod in GiB; required when `gpuCount` is 0. */
  memoryGib?: number
  /** Queue machine type code; comma-separate several. */
  machineType?: string
  /** RDMA network name. */
  rdmaName?: string
  /** `/dev/shm` per pod in GiB, below `memoryGib`. */
  shmSizeGib?: number
  /** Scheduling priority. */
  priority?: ScoPriority
  /** Retries after failure. */
  maxAttempts?: number
  /** Wait in the queue when quota is insufficient. */
  enableQueuing?: boolean
}

/** A job to submit: an optional template plus fields that override it. */
export interface SubmitScoJobRequest extends Omit<ScoJobTemplate, 'description'> {
  /** New job name. */
  name: string
  /** Template name. */
  template?: string
  /** Arguments appended to the command. */
  extraArgs?: string
  displayName?: string
  queueId?: string
  workspace?: string
  /** Validate and return the merged `TrainingJob` without submitting. */
  dryRun?: boolean
}

/** A submission expanded into creation flags, with the names it was composed from. */
export type ScoResolvedSubmission = {
  /** Flags passed to `createJob`. */
  request: CreateScoJobRequest
  template?: string
  code?: { name: string; ref: string }
  data: string[]
  output?: string
}

/** Outcome of a submission. */
export type ScoSubmission =
  | {
    kind: 'dry-run'
    resolved: CreateScoJobRequest
    /** Merged `TrainingJob` returned by the CLI. */
    job: JsonValue
  }
  | {
    kind: 'created'
    resolved: CreateScoJobRequest
    name: string
    /** CLI confirmation text. */
    output: string
  }

/** One queue a workspace may submit to. */
export type ScoQueueOption = {
  /** Full queue resource id, usable as `queueId`. */
  id: string
  cluster: string
  queue: string
  /** The CLI's queue object, including the machine types its workloads accept. */
  detail: JsonValue
}

/** Queues and machine types cached for one sco profile and workspace. */
export type ScoResourceOptions = {
  workspace: string
  /** ISO time of the CLI queries. */
  fetchedAt: string
  queues: ScoQueueOption[]
}

/** Request for cached resource options. */
export interface ScoResourceOptionsRequest {
  workspace?: string
  /** Query the CLI even when options are cached. */
  refresh?: boolean
}

/** A job created through a submission. */
export type ScoJobSubmitted = {
  name: string
  /** Workspace named on the command line; absent when the sco profile supplied it. */
  workspace?: string
  template?: string
  code?: { name: string; ref: string }
  data: string[]
  output?: string
}
