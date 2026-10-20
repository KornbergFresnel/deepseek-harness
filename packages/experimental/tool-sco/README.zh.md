---
description: "面向模型的 SenseCore SSP 训练任务工具：查看、提交和停止任务，远端变更前先征求用户同意。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-tool-sco

[English](README.md) | 中文

## 概述

让模型通过用户本地的 `sco` CLI 管理 SenseCore SSP 训练任务。六个工具分别用于列出任务、查看任务、列出 Worker、读取日志、提交任务和停止任务。默认情况下提交和停止前会先询问用户；dry run 提交只校验任务，不会询问。

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

把本包的 bundle 加入 profile，或在 [sco 网关](../sco/README.zh.md)和工具注册表之后挂载这个函数插件。审批需要已组合的审批服务和应答方，例如 Web 应用的确认提示。

```yaml
- name: '@deepseek-ai/dsh-experimental-sco'
- name: '@deepseek-ai/dsh-experimental-tool-sco'
  config:
    confirmMutations: true
```

| 工具 | 结果 |
|---|---|
| `sco_job_list` | JSON 任务列表；默认按 `-created_at` 排序 |
| `sco_job_describe` | 含状态的 JSON `TrainingJob` |
| `sco_job_workers` | JSON Worker 列表 |
| `sco_job_logs` | 一轮日志的 `{ text, truncated }` |
| `sco_job_create` | `{ kind: 'dry-run', job }` 或 `{ kind: 'created', name, output }` |
| `sco_job_stop` | `{ names, output }` |

开启 `confirmMutations`（默认 `true`）时，未设置 `dryRun: true` 的 `sco_job_create` 和所有 `sco_job_stop`，在其他 pre-execute 监听器允许调用后，会通过 `ctx.approval` 询问用户；其他监听器的拒绝直接生效，不再询问。在 `never` 审批策略下这些调用会被拒绝。只有在允许无人值守地自由提交和停止任务时，才设置 `confirmMutations: false`。[生成的工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-experimental-tool-sco)给出准确的 schema 和面向模型的描述。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节——点击展开</summary>

[`cordis.patch.yml`](cordis.patch.yml) 插入 `sco` 网关行和 `tool-sco` 消费方行。[`src/index.ts`](src/index.ts) 注册六个类型化工具，转发给 `ctx.sco`，并把规范值渲染为 JSON；日志例外，渲染为带截断标记的文本。审批关卡是一个 `tools/pre-execute` 监听器，先委托给后续监听器，只把 `allow` 转为 `ask`。Host 展示使用通用卡片。销毁时会注销工具和监听器。

</details>

-----

<a id="further-exploration"></a>
## 深入探索

- [sco 网关](../sco/README.zh.md) — 配置、CLI 映射与失败行为。
- [审批子系统](../../../docs/subsystems/approval.zh.md) — `ask` 与 `never` 策略及应答方。
- [工具编写](../../../docs/cookbook/adding-a-tool.zh.md) — 规范结果与 pre-execute 策略。

-----

<a id="model-experience"></a>
## 模型体验

### SSP 任务工具

#### 模型看到什么

[工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-experimental-tool-sco)定义了这六个工具。读取类结果包含集群返回的 JSON；日志结果包含日志文本，只保留尾部时会加上 `[earlier output truncated]` 前缀。用户拒绝的提交或停止会以审批拒绝失败。

#### Token 影响

挂载期间，六个 schema 在每次请求中有固定开销。每次调用会把参数和结果追加到工具历史；列表和日志受网关 `maxOutputBytes` 限制。

#### KV Cache 影响

工具 schema 不变时保留已有前缀。调用追加在已有历史之后。

## 已知限制与待办工作

<a id="known-limitations-and-deferred-work"></a>

- **受网关限制** — [网关限制](../sco/README.zh.md#known-limitations-and-deferred-work)决定了工具能提交和读取的内容。
- **没有监控循环** — 工具按请求读取状态；等待任务结束或响应失败需要重复调用。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
