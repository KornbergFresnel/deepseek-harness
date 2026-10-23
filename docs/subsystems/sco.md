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
 * A Session named by the request attaches to an existing watch that has none.
 * @param request - job name, optional workspace, and optional Session.
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

/**
 * List the registered metric source kinds.
 * @returns kinds in registration order, starting with `logs`.
 */
@Remote metricSources(): string[]

/**
 * Change a watch's description or metric source. A different source clears the curves and polls the job's logs again.
 * @param watchId - watch id from a row.
 * @param changes - fields to change.
 * @returns the updated row.
 */
@Remote async configure(watchId: ClusterWatchId, changes: ClusterWatchChanges): Promise<ClusterWatchRow>

/**
 * Register a metric source kind. Watches name it in `metrics.kind`; one that names a kind no plugin registers reports that on every poll.
 * @param kind - source kind; `logs` and every registered kind are taken.
 * @param provider - option validation and the metric read.
 * @returns disposer that unregisters the kind.
 */
registerMetricSource(kind: string, provider: ClusterMetricProvider): () => void
```

Source: [`packages/experimental/cluster-monitor/src/index.ts`](../../packages/experimental/cluster-monitor/src/index.ts)

<a id="ctxsco--scogateway"></a>

### `ctx.sco` — `ScoGateway`

Adapts `sco ssp jobs`, `workspaces list-queues`, `queues get`, and `afs volumes list` and `list-dir-quota` subcommands to typed operations. Every invocation is a literal argv with `--flag=value` tokens, run without a shell or sandbox confinement because the CLI needs network access and its credential profile.

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
 * @param origin - Session that requested the creation and the job's description, copied into `sco/job-created`.
 * @returns the merged `TrainingJob` for a dry run, otherwise the created name and CLI output.
 * A real creation emits `sco/job-created` after the CLI succeeds.
 */
async createJob(request: CreateScoJobRequest, signal?: AbortSignal, origin: ScoCallOrigin = {}): Promise<ScoJobCreation>

/**
 * Stop up to 100 training jobs.
 * @param names - job names.
 * @param request - workspace.
 * @param signal - cancellation; a cancelled stop may still have been applied remotely.
 * @returns the stopped names and CLI output.
 */
async stopJobs(names: readonly string[], request: ScoWorkspaceRequest = {}, signal?: AbortSignal): Promise<ScoJobStop>

/**
 * List the queues a workspace may submit to.
 * @param request - workspace; the CLI takes it positionally, so it must resolve from the request or config.
 * @param signal - cancellation.
 * @returns the CLI's JSON queue listing.
 */
async listQueues(request: ScoWorkspaceRequest = {}, signal?: AbortSignal): Promise<JsonValue>

/**
 * Read one queue, including the machine types (`spec_code`) its workloads accept.
 * @param cluster - cluster name from the queue's resource id.
 * @param queue - queue name from the queue's resource id.
 * @param signal - cancellation.
 * @returns the CLI's JSON queue object.
 */
async describeQueue(cluster: string, queue: string, signal?: AbortSignal): Promise<JsonValue>

/**
 * List the AFS volumes the active sco credentials can see, with capacity and state.
 * @param signal - cancellation.
 * @returns one record per volume with its used percentage, named from SRM when the AFS listing leaves `Name` empty; output that is not an
 *   array of objects with an `ID` fails, as does a failed SRM page.
 */
async listVolumes(signal?: AbortSignal): Promise<ScoAfsVolume[]>

/**
 * List the directory quota rules of one AFS volume.
 * @param volume - volume `ID` from `listVolumes`.
 * @param signal - cancellation.
 * @returns the CLI's JSON rule listing.
 */
async listDirectoryQuotas(volume: string, signal?: AbortSignal): Promise<JsonValue>

/**
 * Resolve the workspace an operation targets on the command line.
 * @param request - optional per-request workspace.
 * @returns the request workspace, else the runtime default, else the configured default; undefined defers to the sco profile.
 */
workspaceOf(request: ScoWorkspaceRequest): string | undefined

/**
 * Replace the runtime defaults, which take precedence over the gateway config until replaced again.
 * @param defaults - workspace and queue; an absent field falls back to the config, then the sco profile.
 */
setDefaults(defaults: ScoDefaults): void
```

Source: [`packages/experimental/sco/src/index.ts`](../../packages/experimental/sco/src/index.ts)

<a id="ctxscosubmit--scosubmit"></a>

### `ctx.scoSubmit` — `ScoSubmit`

Composes SSP jobs from named sources and templates and submits them through `ctx.sco`. Sources, resource options, and the page's default workspace and queue persist in the `sco_submit` storage domain; templates come from config. Saved defaults are applied to `ctx.sco` at start and withdrawn on disposal. Nothing in the `clusterConfig` namespace enters a model request; the model reaches the same records through the SSP job tools.

```ts cordis-catalog
/**
 * List registered sources.
 * @returns sources by name.
 */
async sources(): Promise<Record<string, ScoSource>>

/**
 * List configured templates.
 * @returns templates by name.
 */
listTemplates(): Record<string, ScoJobTemplate>

/**
 * Register a new source.
 * @param name - unused source name.
 * @param source - locations to mount.
 */
async addSource(name: string, source: ScoSource): Promise<void>

/**
 * Replace a registered source.
 * @param name - registered source name.
 * @param source - new locations.
 */
async updateSource(name: string, source: ScoSource): Promise<void>

/**
 * Remove a registered source; templates that name it fail at their next submission.
 * @param name - registered source name.
 */
async removeSource(name: string): Promise<void>

/**
 * Read the queues and machine types a workspace offers, querying the CLI only when nothing is cached or on `refresh`.
 * @param request - workspace and refresh.
 * @param signal - cancellation.
 * @returns cached or freshly queried options.
 */
async resourceOptions(request: ScoResourceOptionsRequest = {}, signal?: AbortSignal): Promise<ScoResourceOptions>

/**
 * Expand a submission against the registered sources and configured templates without running the CLI.
 * @param request - submission.
 * @returns creation flags and the names they were composed from.
 */
async resolve(request: SubmitScoJobRequest): Promise<ScoResolvedSubmission>

/**
 * Expand and submit a job, or validate it with `dryRun`.
 * A machine type absent from cached options fails before the CLI runs; a CLI failure that names a resource
 * field refreshes the cached options before the error propagates.
 * @param request - submission.
 * @param signal - cancellation; a cancelled creation may still have been accepted remotely.
 * @param origin - Session that requested the submission, passed to `createJob`.
 * @returns the merged `TrainingJob` for a dry run, otherwise the created name and CLI output, each with the flags used.
 */
async submit(request: SubmitScoJobRequest, signal?: AbortSignal, origin: ScoCallOrigin = {}): Promise<ScoSubmission>

/**
 * Read the configuration page state.
 * @returns gateway defaults, sources, templates, and the options cached for the default workspace.
 */
@Remote async overview(): Promise<ScoConfigOverview>

/**
 * Follow the configuration page state: the overview now and after each source or option change.
 * @param signal - stream lifetime.
 * @returns complete overviews.
 */
@Remote({ mode: 'stream' }) follow(signal: AbortSignal): AsyncIterable<ScoConfigOverview>

/**
 * Register or replace a source from the configuration page.
 * @param request - source name, locations, and whether to replace a registered source.
 * @returns after the source is stored.
 */
@Remote async saveSource(request: ScoSourceSaveRequest): Promise<void>

/**
 * Remove a source from the configuration page.
 * @param name - registered source name.
 * @returns after the source is deleted.
 */
@Remote async deleteSource(name: string): Promise<void>

/**
 * Save the default workspace and queue for the current sco profile; they override the gateway config until changed.
 * @param defaults - workspace and full queue id; a blank or absent field falls back to the gateway config, then the sco profile.
 * @returns after the defaults are stored and applied.
 */
@Remote async saveDefaults(defaults: ScoDefaults): Promise<void>

/**
 * Query the queues and machine types of the default workspace again and cache them.
 * @returns after the options are stored.
 */
@Remote async refreshOptions(): Promise<void>

/**
 * List the AFS volumes the sco credentials can see, for choosing where a source lives.
 * @returns volumes with capacity and used percentage.
 */
@Remote volumes(): Promise<ScoAfsVolume[]>

/**
 * List saved workload configurations.
 * @returns configurations by name.
 */
async configs(): Promise<Record<string, ScoSavedConfig>>

/**
 * Save a workload configuration for later forms to load.
 * @param request - name, kind, settings, and whether to replace a saved configuration of the same name.
 * @returns after the configuration is stored.
 */
@Remote async saveConfig(request: ScoConfigSaveRequest): Promise<void>

/**
 * Delete a saved workload configuration.
 * @param name - saved configuration name.
 * @returns after the configuration is deleted.
 */
@Remote async deleteConfig(name: string): Promise<void>

/**
 * Open a configuration form in the chat row of a tool call and wait until the user confirms or cancels it.
 * @param request - tool call, Session, kind, proposed values, and an optional saved configuration to suggest.
 * @param signal - the tool call's lifetime; aborting closes the form and rejects with the abort reason.
 * @returns the confirmed values, with the configuration loaded and the name saved under, or a cancellation.
 */
async askForm(request: Omit<ScoConfigForm, 'openedAt'>, signal: AbortSignal): Promise<ScoConfigFormOutcome>

/**
 * Follow the open configuration forms: the list now and after each form opens or closes.
 * @param signal - stream lifetime.
 * @returns complete form lists in opening order.
 */
@Remote({ mode: 'stream' }) followForms(signal: AbortSignal): AsyncIterable<ScoConfigForm[]>

/**
 * Answer an open configuration form. A save request stores the confirmed values first; a failed save leaves the form open.
 * @param callId - tool call that opened the form.
 * @param answer - confirmed values with the optional configuration loaded and save name, or a cancellation.
 * @returns after the form closes.
 */
@Remote async answerForm(callId: ToolCallId, answer: ScoConfigFormAnswer): Promise<void>
```

Types: [ToolCallId](core.md)

Source: [`packages/experimental/sco-submit/src/index.ts`](../../packages/experimental/sco-submit/src/index.ts)

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

<a id="scojob-submitted--emit"></a>

#### `sco/job-submitted` — emit

A submission created a job; observers can relate the job to its template, code ref, and data.

```ts cordis-catalog
/**
 * A submission created a job; observers can relate the job to its template, code ref, and data.
 * @mode emit
 * @param event - created job name, workspace, and the names it was composed from.
 */
'sco/job-submitted'(event: ScoJobSubmitted): void
```

Source: [`packages/experimental/sco-submit/src/index.ts`](../../packages/experimental/sco-submit/src/index.ts)
<!-- END GENERATED cordis-surface -->
