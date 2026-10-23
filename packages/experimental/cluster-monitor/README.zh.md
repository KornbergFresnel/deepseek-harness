---
description: "通过本地 sco CLI 跟踪 SenseCore SSP 任务，并向 Web 客户端提供状态、训练曲线和日志。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-cluster-monitor

[English](README.md) | 中文

## 概述

在 Host 上通过 [`ctx.sco`](../sco/README.zh.md) 轮询关注的 SSP 训练任务，把状态、解析出的训练指标和日志尾部保存在存储域中，并以 `cluster` Remote 命名空间提供。网关创建的任务会被自动关注；[集群任务页面](../client-ui-cluster-monitor/README.zh.md)负责展示。

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

将本服务与 SSP 网关和 `storageDomain` 提供方一起挂载，并为 Web 客户端添加页面包。[`sco.patch.yml`](sco.patch.yml) 会把网关、SSP 任务工具、本服务、两个集群页面和 Git 分支按钮加入 Web profile：填好 `sco` 路径后，运行 `pnpm dsh web --patch packages/experimental/cluster-monitor/sco.patch.yml`。

```yaml
- name: '@deepseek-ai/dsh-experimental-sco'
- name: '@deepseek-ai/dsh-experimental-cluster-monitor'
  config:
    runningPollMs: 30000
- name: '@deepseek-ai/dsh-experimental-client-ui-cluster-monitor'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `runningPollMs` | `30000` | 任务运行时的轮询间隔（最小 5000） |
| `pendingPollMs` | `60000` | 任务排队或状态未知时的轮询间隔（最小 5000） |
| `maxConcurrentCalls` | `4` | 所有关注任务合计同时进行的 `sco` 调用数 |
| `logTailLength` | `65536` | 保留的日志尾部长度（UTF-16 码元） |
| `maxPointsPerSeries` | `2000` | 每个指标保留的点数，超过后较早的点隔一个丢一个（最小 16） |
| `describeLength` | `32768` | 最近一次任务对象 JSON 文本的保留长度 |
| `watchCreatedJobs` | `true` | 自动关注 `ctx.sco.createJob` 创建的每个任务 |
| `defaultMetricSource` | `logs` | 关注项未指定时使用的指标来源；轮询时必须已注册 |
| `logParsers` | `experiment-logger`、`json-lines`、`key-value` | 关注项未指定时 `logs` 来源使用的解析器；`regex` 模式必须能编译并包含 `step` 命名分组，否则加载失败 |

`ctx.clusterMonitor` 提供 `list()`、`detail(watchId)`、`watch({ name, workspace?, sessionId?, description?, metrics? })`、`configure(watchId, { description?, metrics? })`、`metricSources()`、`unwatch(watchId)`、`refresh(watchId)`，以及流 `follow()` 和 `followJob(watchId)`。`watch` 对同一名称和工作空间幂等。每行带有创建或关注该任务的 Session 的 `sessionId`，来自 `sco/job-created` 事件或请求；之后带 `sessionId` 的调用只会给没有 Session 的关注项补上，不会替换已有值。每次轮询读取任务对象，并把 `state` 映射为 `pending`、`running`、`succeeded`、`failed`、`stopped` 或 `unknown`；运行期间以及结束时各读取并解析一轮日志。到达终态后停止轮询；重启后恢复已保存的非终态关注；`sco` 调用失败会记录在关注项上，但不会停止轮询。每行带有最多 500 个字符的 `description`，来自请求、`sco/job-created` 或 `configure`，以及从任务对象读取的控制台 `displayName`。

训练曲线来自关注项 `metrics: { kind, options? }` 指定的指标来源，未指定时使用 `defaultMetricSource`；`configure` 传入 `metrics: null` 会恢复默认，更换来源会清空已保存的曲线。内置的 `logs` 来源用其 `parsers` 解析每轮日志：`experiment-logger` 读取 `metric  value` 表格和 `[step=N]  key=value` 行，`json-lines` 读取带数值步数键的 JSON 对象，`key-value` 读取 `step=N loss=0.5` 行，`regex` 读取以命名分组表示步数和数值的模式。其他插件通过 `registerMetricSource(kind, provider)` 注册来源，该调用返回注销函数；[`cluster-metrics-wandb`](../cluster-metrics-wandb/README.zh.md) 注册 `wandb`。读取失败或来源未注册会记录为该行的 `metricsError`，但不会停止轮询。只有带整数 `step` 且比已保存步数更新的记录才会被保留。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节——点击展开</summary>

| 源文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 关注记录、轮询计时器、调用并发上限和 `cluster` Remote |
| [`src/parse.ts`](src/parse.ts) | 任务状态与时间、日志解析器和日志尾部 |
| [`src/sources.ts`](src/sources.ts) | 指标来源提供方接口和内置 `logs` 来源 |
| [`src/types.ts`](src/types.ts) | Remote 行、详情和错误码 |

关注项保存在以工作空间和名称为键的 `cluster_monitor` 存储域中，因此不依赖 Session 也能跨重启保留。轮询运行在 Host 计时器上，从不进入模型请求。在 `unwatch` 或销毁之后才完成的轮询不会写入任何内容。销毁时会中止进行中的调用、取消计时器，并等待正在进行的轮询结束后再关闭存储域。

</details>

-----

<a id="further-exploration"></a>
## 深入探索

- [SSP 网关](../sco/README.zh.md) — CLI 调用和 `sco/job-created` 事件。
- [集群任务页面](../client-ui-cluster-monitor/README.zh.md) — 这些关注项的 Web 视图。

-----

<a id="model-experience"></a>
## 模型体验

无，轮询及其结果只留在 Host 和 Web 客户端中。

#### KV Cache 影响

无影响；本包不提供提示词文本或工具结果。

## 已知限制与待办工作

<a id="known-limitations-and-deferred-work"></a>

- **无 GPU 指标** — 不读取 CMS 的 GPU 利用率和显存；只展示状态、日志以及从日志解析的指标。
- **无 agent 通知** — 任务到达终态不会报告到 Session 中。
- **日志轮次语义** — 假定一轮不跟随的 `stream-logs` 返回最近输出；超出 `sco` 捕获字节上限的输出只保留尾部。
- **步数回退** — 训练重启后从更小的步数重新开始时，新点会被忽略，直到步数超过已保存的值。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者细节——点击展开</summary>

SSP 没有列举任务状态，因此阶段映射按关键字匹配，无法匹配的文本保持 `unknown`，并按排队间隔继续轮询。

</details>
