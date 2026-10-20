# SenseCore Training Jobs

English | [中文](sco.zh.md)

The experimental [`dsh-experimental-sco`](../../packages/experimental/sco/README.md) gateway provides `ctx.sco`, which runs SenseCore SSP training-job operations through the user's locally installed `sco` CLI. Its [`tool-sco`](../../packages/experimental/tool-sco/README.md) consumer exposes those operations to models and asks the user before submitting or stopping a job. Neither package ships in a default profile; explicit compositions mount both.

## Operations and authority

The gateway lists jobs, reads one job, lists its workers, reads one round of its logs, creates a job from parameterized flags, and stops up to 100 jobs. Each operation is one CLI invocation with literal `--flag=value` arguments under a deadline. The CLI's own profile supplies credentials, subscription, and resource group; the gateway's `workspace` and `queueId` configuration only fills values a request omits. Creation and stop change remote cluster state and are not idempotent; a cancelled or timed-out call may still have been applied.

The CLI is not confined by the Session sandbox because it needs network access and its credential profile. The tool package's approval gate is the control for remote changes: with `confirmMutations` on, a submission without `dryRun` and every stop ask the user through [approval](approval.md) after other pre-execute listeners allow the call.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
<!-- END GENERATED cordis-surface -->
