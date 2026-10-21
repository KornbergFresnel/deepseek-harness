# SenseCore 训练任务

[English](sco.md) | 中文

实验性的 [`dsh-experimental-sco`](../../packages/experimental/sco/README.zh.md) 网关提供 `ctx.sco`，通过用户本地安装的 `sco` CLI 执行 SenseCore SSP 训练任务操作。它的消费方 [`tool-sco`](../../packages/experimental/tool-sco/README.zh.md) 把这些操作提供给模型，并在提交或停止任务前询问用户。两个包都不在默认 profile 中；需要显式组合挂载。

## 操作与权限

网关可以列出任务、查看单个任务、列出其 Worker、读取一轮日志、用参数化标志创建任务，以及停止最多 100 个任务。每个操作是一次带截止时间的 CLI 调用，参数为字面 `--flag=value`。凭据、订阅和资源组来自 CLI 自己的 profile；网关的 `workspace` 和 `queueId` 配置只填补请求中缺省的值。创建和停止会改变远端集群状态，且不是幂等操作；被取消或超时的调用可能已经生效。

CLI 不受 Session 沙箱约束，因为它需要网络访问和凭据 profile。远端变更由工具包的审批关卡控制：开启 `confirmMutations` 时，未设置 `dryRun` 的提交和所有停止操作，会在其他 pre-execute 监听器允许调用后，通过[审批](approval.zh.md)询问用户。

## 任务监控

实验性的 [`dsh-experimental-cluster-monitor`](../../packages/experimental/cluster-monitor/README.zh.md) 服务提供 `ctx.clusterMonitor`，在 Host 计时器上通过 `ctx.sco` 轮询关注的任务，并把状态、从日志解析的训练指标和日志尾部保存在 `cluster_monitor` 存储域中。非 dry-run 的创建成功后会发出 `sco/job-created`，除非关闭 `watchCreatedJobs`，监控服务会关注该任务。[`client-ui-cluster-monitor`](../../packages/experimental/client-ui-cluster-monitor/README.zh.md) 页面读取 `cluster` Remote 命名空间。监控从不进入模型请求。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
