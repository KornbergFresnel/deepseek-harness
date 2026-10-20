# SenseCore Training Jobs

English | [中文](sco.zh.md)

The experimental [`dsh-experimental-sco`](../../packages/experimental/sco/README.md) gateway provides `ctx.sco`, which runs SenseCore SSP training-job operations through the user's locally installed `sco` CLI. Its [`tool-sco`](../../packages/experimental/tool-sco/README.md) consumer exposes those operations to models and asks the user before submitting or stopping a job. Neither package ships in a default profile; explicit compositions mount both.

## Operations and authority

The gateway lists jobs, reads one job, lists its workers, reads one round of its logs, creates a job from parameterized flags, and stops up to 100 jobs. Each operation is one CLI invocation with literal `--flag=value` arguments under a deadline. The CLI's own profile supplies credentials, subscription, and resource group; the gateway's `workspace` and `queueId` configuration only fills values a request omits. Creation and stop change remote cluster state and are not idempotent; a cancelled or timed-out call may still have been applied.

The CLI is not confined by the Session sandbox because it needs network access and its credential profile. The tool package's approval gate is the control for remote changes: with `confirmMutations` on, a submission without `dryRun` and every stop ask the user through [approval](approval.md) after other pre-execute listeners allow the call.

## Job monitoring

The experimental [`dsh-experimental-cluster-monitor`](../../packages/experimental/cluster-monitor/README.md) service provides `ctx.clusterMonitor`, which polls watched jobs through `ctx.sco` on Host timers and stores their state, log-derived training metrics, and log tail in the `cluster_monitor` storage domain. A successful non-dry-run creation emits `sco/job-created`, and the monitor watches that job unless `watchCreatedJobs` is off. The [`client-ui-cluster-monitor`](../../packages/experimental/client-ui-cluster-monitor/README.md) page reads the `cluster` Remote namespace. Monitoring never enters a model request.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxclustermonitor--clustermonitor"></a>

### `ctx.clusterMonitor` — `ClusterMonitor`

Watches SSP jobs and serves their state, training curves, and log tails to browser clients. Polling runs on the Host without the model; nothing here enters a model request.

```ts cordis-catalog
/**
 * List every watched job, newest first.
 * @returns one row per watch.
 */
@Remote list(): ClusterWatchRow[]

/**
 * Follow the watch list: the current rows, then the complete list after each change.
 * @param signal - stream lifetime.
 * @returns complete row lists.
 */
@Remote({ mode: 'stream' }) async *follow(signal: AbortSignal): AsyncIterable<ClusterWatchRow[]>

/**
 * Read one watched job with its curves, log tail, and job object.
 * @param watchId - watch id from a row.
 * @returns the job detail.
 */
@Remote detail(watchId: ClusterWatchId): ClusterJobDetail

/**
 * Follow one watched job: its detail now and after each change, ending when the watch is removed.
 * @param watchId - watch id from a row.
 * @param signal - stream lifetime.
 * @returns complete job details.
 */
@Remote({ mode: 'stream' }) async *followJob(watchId: ClusterWatchId, signal: AbortSignal): AsyncIterable<ClusterJobDetail>

/**
 * Start watching a job, or return the existing watch of the same job and workspace.
 * @param request - job name and optional workspace.
 * @returns the watch row.
 */
@Remote async watch(request: ClusterWatchRequest): Promise<ClusterWatchRow>

/**
 * Stop watching a job and delete its stored curves; the SSP job itself is untouched.
 * @param watchId - watch id from a row.
 * @returns after the record is deleted.
 */
@Remote async unwatch(watchId: ClusterWatchId): Promise<void>

/**
 * Poll one job now, including a finished one, and wait for the result.
 * @param watchId - watch id from a row.
 * @returns after the poll is stored.
 */
@Remote async refresh(watchId: ClusterWatchId): Promise<void>
```

Source: [`packages/experimental/cluster-monitor/src/index.ts`](../../packages/experimental/cluster-monitor/src/index.ts)

<a id="ctxsco--scogateway"></a>

### `ctx.sco` — `ScoGateway`

Adapts `sco ssp jobs` subcommands to typed operations. Every invocation is a literal argv with `--flag=value` tokens, run without a shell or sandbox confinement because the CLI needs network access and its credential profile.

```ts cordis-catalog
/**
 * List training jobs.
 * @param request - workspace, paging, filters, and sort keys.
 * @param signal - cancellation.
 * @returns the CLI's JSON listing.
 */
async listJobs(request: ListScoJobsRequest = {}, signal?: AbortSignal): Promise<JsonValue>

/**
 * Read one job's complete `TrainingJob` object, including state.
 * @param name - job name.
 * @param request - workspace.
 * @param signal - cancellation.
 * @returns the CLI's JSON job object.
 */
async describeJob(name: string, request: ScoWorkspaceRequest = {}, signal?: AbortSignal): Promise<JsonValue>

/**
 * List one job's current workers; worker names select logs.
 * @param name - job name.
 * @param request - workspace.
 * @param signal - cancellation.
 * @returns the CLI's JSON worker listing.
 */
async listWorkers(name: string, request: ScoWorkspaceRequest = {}, signal?: AbortSignal): Promise<JsonValue>

/**
 * Read one round of a running job's logs without following.
 * @param name - job name.
 * @param request - workspace, worker, and container.
 * @param signal - cancellation.
 * @returns the retained log text and whether it was truncated to the output limit.
 */
async readLogs(name: string, request: ReadScoJobLogsRequest = {}, signal?: AbortSignal): Promise<ScoJobLogs>

/**
 * Create a training job from flags, or validate it with `dryRun`.
 * Creation is not idempotent: an existing name fails in the CLI.
 * @param request - job specification.
 * @param signal - cancellation; a cancelled creation may still have been accepted remotely.
 * @returns the merged `TrainingJob` for a dry run, otherwise the created name and CLI output.
 * A real creation emits `sco/job-created` after the CLI succeeds.
 */
async createJob(request: CreateScoJobRequest, signal?: AbortSignal): Promise<ScoJobCreation>

/**
 * Stop up to 100 training jobs.
 * @param names - job names.
 * @param request - workspace.
 * @param signal - cancellation; a cancelled stop may still have been applied remotely.
 * @returns the stopped names and CLI output.
 */
async stopJobs(names: readonly string[], request: ScoWorkspaceRequest = {}, signal?: AbortSignal): Promise<ScoJobStop>
```

Source: [`packages/experimental/sco/src/index.ts`](../../packages/experimental/sco/src/index.ts)

<a id="sco-events"></a>

### `sco/*` events

<a id="scojob-created--emit"></a>

#### `sco/job-created` — emit

The CLI accepted a non-dry-run job creation; observers such as job monitors start tracking it.

```ts cordis-catalog
/**
 * The CLI accepted a non-dry-run job creation; observers such as job monitors start tracking it.
 * @mode emit
 * @param event - created job name and the workspace named on the command line.
 */
'sco/job-created'(event: ScoJobCreated): void
```

Source: [`packages/experimental/sco/src/index.ts`](../../packages/experimental/sco/src/index.ts)
<!-- END GENERATED cordis-surface -->
