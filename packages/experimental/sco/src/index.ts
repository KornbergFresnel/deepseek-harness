/** SenseCore SSP training-job and queue operations and AFS volume listing through the locally installed `sco` CLI. */

import { homedir } from 'node:os'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-subprocess'
import type { SubprocessCollectedOutputs } from '@deepseek-ai/dsh-subprocess'
import { deadline, MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { createArgv, jobName, listArgv, logsArgv, resourceName } from './argv.ts'
import type {
  CreateScoJobRequest, ListScoJobsRequest, ReadScoJobLogsRequest, ScoJobCreated, ScoJobCreation, ScoJobLogs, ScoJobStop,
  ScoWorkspaceRequest,
} from './types.ts'

export type * from './types.ts'

/** Executable, sco profile selection, workspace and queue defaults, and subprocess limits. */
export interface Config {
  /** Executable name on PATH or absolute path of the `sco` CLI. */
  command?: string
  /** sco profile passed as `--profile`; omitted uses the CLI's active profile. */
  profile?: string
  /** Default SSP workspace passed as `--workspace-name`; omitted defers to profile `ssp.workspace_name`. */
  workspace?: string
  /** Default queue resource id for creation; omitted defers to profile `ssp.queue_id`. */
  queueId?: string
  /** Deadline in milliseconds for one CLI invocation. */
  timeoutMs?: number
  /** Subprocess termination grace in milliseconds. */
  graceMs?: number
  /** Maximum captured bytes per output stream. */
  maxOutputBytes?: number
}

type ResolvedConfig = Required<Pick<Config, 'command' | 'timeoutMs' | 'graceMs' | 'maxOutputBytes'>> & Config

declare module '@deepseek-ai/cordis' {
  interface Context {
    sco: ScoGateway
  }

  interface Events {
    /**
     * The CLI accepted a non-dry-run job creation; observers such as job monitors start tracking it.
     * @mode emit
     * @param event - created job name and the workspace named on the command line.
     */
    'sco/job-created'(event: ScoJobCreated): void
  }
}

/** `sco` command paths the gateway invokes. */
type ScoCommand = readonly ['ssp', 'jobs' | 'workspaces' | 'queues'] | readonly ['afs', 'volumes']

const JOBS = ['ssp', 'jobs'] as const

/** Captured result of one CLI invocation. */
interface Invocation {
  stdout: string
  lossy: boolean
}

/**
 * Adapts `sco ssp jobs`, `workspaces list-queues`, `queues get`, and `afs volumes list` and `list-dir-quota` subcommands
 * to typed operations.
 * Every invocation is a literal argv with `--flag=value` tokens, run without a shell or
 * sandbox confinement because the CLI needs network access and its credential profile.
 */
export class ScoGateway extends Service {
  static inject = ['subprocess']

  static Config: z<Config> = z.object({
    command: z.string().default('sco'),
    profile: z.string(),
    workspace: z.string(),
    queueId: z.string(),
    timeoutMs: z.number().default(120_000),
    graceMs: z.number().default(3_000),
    maxOutputBytes: z.number().default(1_048_576),
  })

  private readonly config: ResolvedConfig
  private readonly lifetime = new AbortController()
  private readonly cwd = homedir()

  constructor(ctx: Context, config: Config) {
    super(ctx, 'sco')
    this.config = config as ResolvedConfig
    for (const key of ['command', 'profile', 'workspace', 'queueId'] as const) {
      const value = this.config[key]
      if (value !== undefined && value.trim().length === 0) throw new Error(`sco: ${key} must not be empty`)
    }
    for (const key of ['timeoutMs', 'graceMs', 'maxOutputBytes'] as const) {
      const value = this.config[key]
      if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMER_DELAY_MS) {
        throw new Error(`sco: ${key} must be a positive integer no greater than ${MAX_TIMER_DELAY_MS}`)
      }
    }
    ctx.effect(() => () => {
      this.lifetime.abort(new Error('sco gateway disposed'))
    })
  }

  /**
   * List training jobs.
   * @param request - workspace, paging, filters, and sort keys.
   * @param signal - cancellation.
   * @returns the CLI's JSON listing.
   */
  async listJobs(request: ListScoJobsRequest = {}, signal?: AbortSignal): Promise<JsonValue> {
    return this.json(JOBS, [...listArgv(request), ...this.workspaceArgv(request), '--format=json'], signal)
  }

  /**
   * Read one job's complete `TrainingJob` object, including state.
   * @param name - job name.
   * @param request - workspace.
   * @param signal - cancellation.
   * @returns the CLI's JSON job object.
   */
  async describeJob(name: string, request: ScoWorkspaceRequest = {}, signal?: AbortSignal): Promise<JsonValue> {
    return this.json(JOBS, ['describe', jobName(name), ...this.workspaceArgv(request), '--format=json'], signal)
  }

  /**
   * List one job's current workers; worker names select logs.
   * @param name - job name.
   * @param request - workspace.
   * @param signal - cancellation.
   * @returns the CLI's JSON worker listing.
   */
  async listWorkers(name: string, request: ScoWorkspaceRequest = {}, signal?: AbortSignal): Promise<JsonValue> {
    return this.json(JOBS, ['get-workers', jobName(name), ...this.workspaceArgv(request), '--format=json'], signal)
  }

  /**
   * Read one round of a running job's logs without following.
   * @param name - job name.
   * @param request - workspace, worker, and container.
   * @param signal - cancellation.
   * @returns the retained log text and whether it was truncated to the output limit.
   */
  async readLogs(name: string, request: ReadScoJobLogsRequest = {}, signal?: AbortSignal): Promise<ScoJobLogs> {
    const result = await this.run(JOBS, [...logsArgv(name, request), ...this.workspaceArgv(request)], signal, true)
    return { text: result.stdout, truncated: result.lossy }
  }

  /**
   * Create a training job from flags, or validate it with `dryRun`.
   * Creation is not idempotent: an existing name fails in the CLI.
   * @param request - job specification.
   * @param signal - cancellation; a cancelled creation may still have been accepted remotely.
   * @returns the merged `TrainingJob` for a dry run, otherwise the created name and CLI output.
   * A real creation emits `sco/job-created` after the CLI succeeds.
   */
  async createJob(request: CreateScoJobRequest, signal?: AbortSignal): Promise<ScoJobCreation> {
    const argv = [...createArgv(request, request.queueId ?? this.config.queueId), ...this.workspaceArgv(request)]
    if (request.dryRun === true) return { kind: 'dry-run', job: await this.json(JOBS, argv, signal) }
    const result = await this.run(JOBS, argv, signal)
    const workspace = this.workspaceOf(request)
    this.ctx.emit('sco/job-created', { name: request.name, ...workspace === undefined ? {} : { workspace } })
    return { kind: 'created', name: request.name, output: result.stdout.trim() }
  }

  /**
   * Stop up to 100 training jobs.
   * @param names - job names.
   * @param request - workspace.
   * @param signal - cancellation; a cancelled stop may still have been applied remotely.
   * @returns the stopped names and CLI output.
   */
  async stopJobs(names: readonly string[], request: ScoWorkspaceRequest = {}, signal?: AbortSignal): Promise<ScoJobStop> {
    if (names.length === 0 || names.length > 100) throw new Error('sco: stop takes 1 to 100 job names')
    const result = await this.run(JOBS, ['stop', ...names.map(jobName), ...this.workspaceArgv(request)], signal)
    return { names: [...names], output: result.stdout.trim() }
  }

  /**
   * List the queues a workspace may submit to.
   * @param request - workspace; the CLI takes it positionally, so it must resolve from the request or config.
   * @param signal - cancellation.
   * @returns the CLI's JSON queue listing.
   */
  async listQueues(request: ScoWorkspaceRequest = {}, signal?: AbortSignal): Promise<JsonValue> {
    const workspace = this.workspaceOf(request)
    if (workspace === undefined) throw new Error('sco: listing queues needs a workspace from the request or the gateway config')
    return this.json(['ssp', 'workspaces'], ['list-queues', resourceName('workspace', workspace), '--format=json'], signal)
  }

  /**
   * Read one queue, including the machine types (`spec_code`) its workloads accept.
   * @param cluster - cluster name from the queue's resource id.
   * @param queue - queue name from the queue's resource id.
   * @param signal - cancellation.
   * @returns the CLI's JSON queue object.
   */
  async describeQueue(cluster: string, queue: string, signal?: AbortSignal): Promise<JsonValue> {
    return this.json(['ssp', 'queues'], ['get', resourceName('cluster', cluster), resourceName('queue', queue), '--format=json'], signal)
  }

  /**
   * List the AFS volumes the active sco credentials can see, with capacity and state.
   * @param signal - cancellation.
   * @returns the CLI's JSON volume listing.
   */
  async listVolumes(signal?: AbortSignal): Promise<JsonValue> {
    return this.json(['afs', 'volumes'], ['list', '--format=json'], signal)
  }

  /**
   * List the directory quota rules of one AFS volume.
   * @param volume - volume `ID` from `listVolumes`.
   * @param signal - cancellation.
   * @returns the CLI's JSON rule listing.
   */
  async listDirectoryQuotas(volume: string, signal?: AbortSignal): Promise<JsonValue> {
    return this.json(['afs', 'volumes'], ['list-dir-quota', `--instance=${resourceName('volume', volume)}`, '--format=json'], signal)
  }

  /**
   * Resolve the workspace an operation targets on the command line.
   * @param request - optional per-request workspace.
   * @returns the request workspace, else the configured default; undefined defers to the sco profile.
   */
  workspaceOf(request: ScoWorkspaceRequest): string | undefined {
    const workspace = request.workspace ?? this.config.workspace
    if (workspace !== undefined && workspace.trim().length === 0) throw new Error('sco: workspace must not be empty')
    return workspace
  }

  /** The configured sco profile, or undefined for the CLI's active profile. */
  get profile(): string | undefined {
    return this.config.profile
  }

  private workspaceArgv(request: ScoWorkspaceRequest): string[] {
    const workspace = this.workspaceOf(request)
    return workspace === undefined ? [] : [`--workspace-name=${workspace}`]
  }

  private async json(command: ScoCommand, argv: readonly string[], signal: AbortSignal | undefined): Promise<JsonValue> {
    const { stdout } = await this.run(command, argv, signal)
    try {
      return JSON.parse(stdout) as JsonValue
    } catch (error) {
      throw new Error(`sco ${command.join(' ')} ${argv[0]} returned non-JSON output: ${stdout.slice(0, 200)}`, { cause: error })
    }
  }

  /** Run `sco [--profile=<p>] <command> <argv>` and return stdout; a non-zero exit throws with stderr. */
  private async run(
    command: ScoCommand, argv: readonly string[], signal: AbortSignal | undefined, allowLossy = false,
  ): Promise<Invocation> {
    const operation = signal === undefined ? this.lifetime.signal : AbortSignal.any([this.lifetime.signal, signal])
    using timeout = deadline(operation, this.config.timeoutMs, 'SCO_TIMEOUT')
    timeout.signal.throwIfAborted()
    const program = await this.ctx.subprocess.resolveExecutable(this.config.command, undefined, timeout.signal)
    const profile = this.config.profile === undefined ? [] : [`--profile=${this.config.profile}`]
    const child = this.ctx.subprocess.spawn({
      argv: [program, ...profile, ...command, ...argv],
      cwd: this.cwd,
      env: { SCO_COLOR: 'no' },
      signal: timeout.signal,
      graceMs: this.config.graceMs,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: this.config.maxOutputBytes },
        stderr: { maxBytes: this.config.maxOutputBytes },
      },
    })
    try {
      const outcome = await child.done
      timeout.signal.throwIfAborted()
      // The spawn spec above collects both streams.
      const captured = child.collected as Required<SubprocessCollectedOutputs>
      const stdout = captured.stdout.readFrom(0)
      if (outcome.exitCode !== 0) {
        const stderr = captured.stderr.readFrom(0).text.trim()
        throw new Error(`sco ${command.join(' ')} ${argv[0]} failed (${outcome.signal ?? outcome.exitCode}): ${stderr || stdout.text.trim()}`)
      }
      if (stdout.lossy && !allowLossy) throw new Error(`sco ${command.join(' ')} ${argv[0]} output exceeds maxOutputBytes`)
      return { stdout: stdout.text, lossy: stdout.lossy }
    } finally {
      child.terminate()
      await child.waitForExit()
    }
  }
}

export default ScoGateway
