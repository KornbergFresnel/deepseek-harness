---
description: "通过本地安装的 sco CLI 执行 SenseCore SSP 训练任务操作。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-sco

[English](README.md) | 中文

## 概述

在 Host 上通过用户自己的 `sco` CLI 和凭据 profile 列出、查看、读取日志、提交和停止 SenseCore SSP 训练任务，读取工作空间的队列，并列出 AFS 存储卷及其目录配额规则。每个操作是一次带截止时间、参数为字面值的 CLI 调用；列表和详情原样返回 CLI 的 JSON。

## 目录

- [使用本包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [深入探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

先安装并初始化 `sco`（`sco init`，再执行 `sco config set subscription …` 和 `sco config set resource_group …`）。将网关与 `subprocess` 提供方一起挂载；模型需要这些操作时，再添加[工具包](../tool-sco/README.zh.md)。

```yaml
- name: '@deepseek-ai/dsh-experimental-sco'
  config:
    profile: pjlab
    workspace: my-workspace
    queueId: /subscriptions/.../queues/gpu-pool
- name: '@deepseek-ai/dsh-experimental-tool-sco'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `command` | `sco` | PATH 上的可执行文件名或绝对路径 |
| `profile` | CLI 当前 profile | 作为 `--profile` 传入 |
| `workspace` | profile `ssp.workspace_name` | 默认 `--workspace-name`；请求中的值优先 |
| `queueId` | profile `ssp.queue_id` | 创建时的默认 `--queue-id`；请求中的值优先 |
| `timeoutMs` | `120000` | 单次调用的截止时间 |
| `graceMs` | `3000` | 子进程终止宽限期 |
| `maxOutputBytes` | `1048576` | 每个输出流捕获的字节数 |

`ctx.sco` 提供 `listJobs(request?)`、`describeJob(name, request?)`、`listWorkers(name, request?)`、`readLogs(name, request?)`、`createJob(request)` 和 `stopJobs(names, request?)`，均可传入可选的 `AbortSignal`。列表、详情和 Worker 查询返回 CLI `--format=json` 输出的 JSON。`readLogs` 读取一轮不跟随的 `stream-logs`，输出超过 `maxOutputBytes` 时保留尾部并设置 `truncated`；其他操作在输出超限时失败。`createJob` 把字段映射为参数化 `sco ssp jobs create` 的标志；设置 `dryRun` 时返回合并后的 `TrainingJob` 而不创建任务，否则返回 CLI 输出。`stopJobs` 接受 1 到 100 个任务名。非零退出码会以 CLI 的 stderr 报错，stderr 为空时使用 stdout。非 dry-run 的 `createJob` 成功后会发出带任务名和解析后工作空间的 `sco/job-created` 事件，[cluster-monitor](../cluster-monitor/README.zh.md) 用它自动关注新任务。`listQueues(request?)` 对解析出的工作空间执行 `sco ssp workspaces list-queues`，解析不到工作空间时失败；`describeQueue(cluster, queue)` 执行 `sco ssp queues get`，返回的对象列出该队列接受的机型。`workspaceOf(request)` 和 `profile` 给出解析后的工作空间和配置的 profile，[sco-submit](../sco-submit/README.zh.md) 用它们作为缓存选项的键。`listVolumes()` 执行 `sco afs volumes list --format=json`，返回 CLI 给出的当前凭据能看到的存储卷数组，每项含 `ID`、`TotalCapacity`、`UsedCapacity`、`Region`、`Zone`、`EndTime` 和 `State`。`listDirectoryQuotas(volume)` 执行 `sco afs volumes list-dir-quota --instance=<volume>`，返回 CLI 的 JSON 规则。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节——点击展开</summary>

| 源文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 解析默认值，在截止时间内执行一次调用，解析 JSON，分类失败 |
| [`src/argv.ts`](src/argv.ts) | 校验名称与取值，构造 `--flag=value` 参数 |
| [`src/types.ts`](src/types.ts) | 请求与结果记录 |

每个值都作为单个 `--flag=value` 参数传递，任务名必须符合 SSP 命名规则，因此请求中的值不会被解析成其他选项。`sco afs` 命令以已安装 CLI 的 `--help` 为准，它和公开文档不同：没有 `volumes ls` 和 `dir-quota` 命令组。CLI 通过 `ctx.subprocess` 运行，不经过 shell，也不受沙箱约束，因为它需要网络访问和用户主目录下的凭据 profile。创建和停止不是幂等操作；被取消或超时的调用可能已经在远端生效。服务销毁时会中止进行中的调用。

</details>

-----

<a id="further-exploration"></a>
## 深入探索

- [SSP 任务工具](../tool-sco/README.zh.md) — 面向模型的操作与审批关卡。
- [子进程](../../subprocess/subprocess/README.zh.md) — 进程归属、输出捕获与终止。

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过 SSP 任务工具的结果。

#### KV Cache 影响

本包不提供提示词文本。工具包负责追加的工具结果。

## 已知限制与待办工作

<a id="known-limitations-and-deferred-work"></a>

- **仅支持参数化创建** — 未提供完整 `TrainingJob` 文件（`--config`）、按实例覆盖的 `--workload-file` 和 `copy`，异构实例组和 Ray 集群规格需要直接使用 CLI。
- **CLI 不受沙箱约束** — Session 沙箱不作用于 `sco`；远端变更由工具包的审批关卡控制。
- **只读存储卷** — 只列出 AFS 存储卷和配额规则，不创建或修改；未提供目录列表、AOSS 桶用量和 `sco cms metrics` 容量历史。
- **不跟随日志** — 日志每次读取一轮；未提供 `--follow` 流式输出和文件输出。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

CLI 的 JSON 输出字段没有文档，因此结果保持为无类型 JSON，而不是可能与集群 API 脱节的投影。

</details>
