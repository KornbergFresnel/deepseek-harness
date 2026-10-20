/** Validated `sco ssp jobs` argv construction; values never become separate tokens that the CLI could read as flags. */

import type { CreateScoJobRequest, ListScoJobsRequest, ReadScoJobLogsRequest } from './types.ts'

/** SSP job names: `job-` prefix, lowercase alphanumerics and hyphens, at most 32 characters. */
const JOB_NAME = /^job-[a-z0-9-]{0,27}[a-z0-9]$/
/** Sort keys documented for `sco ssp jobs list --order-by`. */
const ORDER_BY = /^[+-]?(created_at|duration)(,[+-]?(created_at|duration))*$/
/** POSIX-style environment variable names. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
/** Volume mount types accepted by `--volume-mount`. */
const VOLUME_MOUNT = /^PV_(AFS|AOSS):[^,]+$/

/**
 * Reject a job name the CLI would refuse or could read as an option.
 * @param name - candidate job name.
 * @returns the unchanged name.
 */
export function jobName(name: string): string {
  if (!JOB_NAME.test(name)) throw new Error(`sco: job name "${name}" must start with "job-", use lowercase letters, digits, and hyphens, end with a letter or digit, and have at most 32 characters`)
  return name
}

function positiveInteger(key: string, value: number, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`sco: ${key} must be an integer from ${min} to ${max}`)
  return value
}

function text(key: string, value: string): string {
  if (value.trim().length === 0) throw new Error(`sco: ${key} must not be empty`)
  return value
}

/** Append `--flag=value` for a present value. */
function flag(argv: string[], name: string, value: string | number | undefined): void {
  if (value !== undefined) argv.push(`--${name}=${value}`)
}

/**
 * Build `ssp jobs list` arguments.
 * @param request - paging, filters, and sort keys.
 * @returns arguments after `ssp jobs`.
 */
export function listArgv(request: ListScoJobsRequest): string[] {
  const argv = ['list']
  flag(argv, 'page-size', request.pageSize === undefined ? undefined : positiveInteger('pageSize', request.pageSize, 1, 100))
  flag(argv, 'skip', request.skip === undefined ? undefined : positiveInteger('skip', request.skip, 0))
  for (const filter of request.filters ?? []) {
    if (text('filter value', filter.value).includes(',')) throw new Error('sco: filter value must not contain ","')
    argv.push(`--filter=Name=${filter.field},Values=${filter.value}`)
  }
  if (request.orderBy !== undefined && !ORDER_BY.test(request.orderBy)) {
    throw new Error('sco: orderBy must list created_at or duration, each optionally prefixed by + or -, separated by commas')
  }
  flag(argv, 'order-by', request.orderBy)
  return argv
}

/**
 * Build `ssp jobs stream-logs` arguments for one non-following round.
 * @param name - job name.
 * @param request - optional worker and container.
 * @returns arguments after `ssp jobs`.
 */
export function logsArgv(name: string, request: ReadScoJobLogsRequest): string[] {
  const argv = ['stream-logs', jobName(name)]
  flag(argv, 'worker-name', request.worker === undefined ? undefined : text('worker', request.worker))
  flag(argv, 'container-name', request.container === undefined ? undefined : text('container', request.container))
  return argv
}

/**
 * Build `ssp jobs create` arguments in parameterized mode.
 * @param request - job specification.
 * @param queueId - resolved queue id, or undefined to defer to the sco profile.
 * @returns arguments after `ssp jobs`.
 */
export function createArgv(request: CreateScoJobRequest, queueId: string | undefined): string[] {
  const argv = ['create', jobName(request.name)]
  flag(argv, 'display-name', request.displayName === undefined ? undefined : text('displayName', request.displayName))
  flag(argv, 'image', text('image', request.image))
  flag(argv, 'image-type', request.imageType)
  flag(argv, 'args', text('args', request.args))
  flag(argv, 'framework', request.framework)
  flag(argv, 'pod-count', request.podCount === undefined ? undefined : positiveInteger('podCount', request.podCount))
  flag(argv, 'gpu-count', request.gpuCount === undefined ? undefined : positiveInteger('gpuCount', request.gpuCount, 0))
  flag(argv, 'cpu-count', request.cpuCount === undefined ? undefined : positiveInteger('cpuCount', request.cpuCount))
  flag(argv, 'memory-gib', request.memoryGib === undefined ? undefined : positiveInteger('memoryGib', request.memoryGib))
  flag(argv, 'machine-type', request.machineType === undefined ? undefined : text('machineType', request.machineType))
  flag(argv, 'rdma-name', request.rdmaName === undefined ? undefined : text('rdmaName', request.rdmaName))
  flag(argv, 'shm-size-gib', request.shmSizeGib === undefined ? undefined : positiveInteger('shmSizeGib', request.shmSizeGib, 0))
  flag(argv, 'queue-id', queueId === undefined ? undefined : text('queueId', queueId))
  flag(argv, 'priority', request.priority)
  for (const [key, value] of Object.entries(request.env ?? {})) {
    if (!ENV_NAME.test(key)) throw new Error(`sco: environment variable name "${key}" is invalid`)
    if (value.includes(',')) throw new Error(`sco: environment variable ${key} must not contain ","`)
    argv.push(`--env=${key}=${value}`)
  }
  for (const mount of request.volumeMounts ?? []) {
    if (!VOLUME_MOUNT.test(mount)) throw new Error(`sco: volume mount "${mount}" must use the PV_AFS:... or PV_AOSS:... form without ","`)
    argv.push(`--volume-mount=${mount}`)
  }
  flag(argv, 'max-attempts', request.maxAttempts === undefined ? undefined : positiveInteger('maxAttempts', request.maxAttempts, 0))
  if (request.enableQueuing === true) argv.push('--enable-queuing')
  flag(argv, 'tensorboard-log-path', request.tensorboardLogPath === undefined ? undefined : text('tensorboardLogPath', request.tensorboardLogPath))
  if (request.dryRun === true) argv.push('--dry-run', '--format=json')
  return argv
}
