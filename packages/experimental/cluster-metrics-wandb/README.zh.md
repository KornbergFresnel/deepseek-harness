---
description: "集群任务监控的 Weights & Biases 指标来源：从运行历史读取训练曲线。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-cluster-metrics-wandb

[English](README.md) | 中文

## 概述

向 [`ctx.clusterMonitor`](../cluster-monitor/README.zh.md) 注册 `wandb` 指标来源，让关注的 SSP 任务从 W&B 运行历史而不是日志中读取训练曲线。

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

将本插件与集群监控一起挂载，并设置 `WANDB_API_KEY` 凭据。之后关注项可以通过 `metrics: { kind: 'wandb', options: { run? } }`、任务详情中的编辑器，或监控的 `defaultMetricSource: wandb` 选用 `wandb`。

```yaml
- name: '@deepseek-ai/dsh-experimental-cluster-metrics-wandb'
  config:
    baseUrl: https://api.wandb.ai
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `baseUrl` | `https://api.wandb.ai` | W&B API 地址，后面会追加 `/graphql` |
| `apiKeyEnv` | `WANDB_API_KEY` | 保存 API key 的凭据键 |
| `runUrlHosts` | `['wandb.ai']` | 任务日志中 `https://<host>/<entity>/<project>/runs/<id>` 形式的 URL 会被视为其运行；子域名也匹配 |
| `samples` | `1000` | 每次读取请求的历史行数（10 到 10000） |
| `timeoutMs` | `20000` | 单次 API 请求的超时（最小 1000） |

`run` 选项接受 `entity/project/run-id`、`entity/project/runs/run-id` 或可接受主机上的运行 URL；未设置时使用任务日志中最后打印的运行 URL。每次读取会发送该运行的 `history(samples)` 查询，保留带整数 `_step` 的行，并把键不以 `_` 开头的有限数值作为指标值。缺少运行、key、项目或运行不存在、HTTP 失败和 GraphQL 错误都会成为该行的 `metricsError`。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节——点击展开</summary>

| 源文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 配置、运行引用、历史查询和注册 |

注册通过 `ctx.effect` 完成，因此卸载插件会移除该来源；指定它的关注项在重新注册之前会记录 `metricsError`。

</details>

-----

<a id="further-exploration"></a>
## 深入探索

- [集群监控](../cluster-monitor/README.zh.md) — 指标来源和 `logs` 解析器。
- [集群任务页面](../client-ui-cluster-monitor/README.zh.md) — 指标来源编辑器。

-----

<a id="model-experience"></a>
## 模型体验

无，读取在 Host 轮询中进行，结果只到达 Web 客户端。

#### KV Cache 影响

无影响；本包不提供提示词文本或工具结果。

## 已知限制与待办工作

<a id="known-limitations-and-deferred-work"></a>

- **历史被采样** — 超过 `samples` 行的运行会由 W&B 服务端采样，长运行的曲线会变稀。
- **单一 key** — 所有关注项使用同一个 API key。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者细节——点击展开</summary>

查询沿用官方 `wandb` Python 客户端 `run.history(samples=...)` 所用的 GraphQL schema，其中 `history` 把每个采样行作为 JSON 文本返回。

</details>
