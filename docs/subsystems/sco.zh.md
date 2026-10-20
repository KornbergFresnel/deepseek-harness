# SenseCore 训练任务

[English](sco.md) | 中文

实验性的 [`dsh-experimental-sco`](../../packages/experimental/sco/README.zh.md) 网关提供 `ctx.sco`，通过用户本地安装的 `sco` CLI 执行 SenseCore SSP 训练任务操作。它的消费方 [`tool-sco`](../../packages/experimental/tool-sco/README.zh.md) 把这些操作提供给模型，并在提交或停止任务前询问用户。两个包都不在默认 profile 中；需要显式组合挂载。

## 操作与权限

网关可以列出任务、查看单个任务、列出其 Worker、读取一轮日志、用参数化标志创建任务，以及停止最多 100 个任务。每个操作是一次带截止时间的 CLI 调用，参数为字面 `--flag=value`。凭据、订阅和资源组来自 CLI 自己的 profile；网关的 `workspace` 和 `queueId` 配置只填补请求中缺省的值。创建和停止会改变远端集群状态，且不是幂等操作；被取消或超时的调用可能已经生效。

CLI 不受 Session 沙箱约束，因为它需要网络访问和凭据 profile。远端变更由工具包的审批关卡控制：开启 `confirmMutations` 时，未设置 `dryRun` 的提交和所有停止操作，会在其他 pre-execute 监听器允许调用后，通过[审批](approval.zh.md)询问用户。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
