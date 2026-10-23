---
description: "集群任务、集群配置和作业配置页面，右侧边栏的本会话作业标签页，以及对话中的作业和开发机配置表单。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-cluster-monitor

[English](README.md) | 中文

## 概述

在 Web 侧边栏添加“集群任务”入口，列出 [`cluster-monitor`](../cluster-monitor/README.zh.md) 关注的任务，并展示所选任务的状态、时间、训练曲线、最近日志和最近一次任务对象；另加“集群配置”入口，查看和编辑 [`sco-submit`](../sco-submit/README.zh.md) 提交任务时使用的配置。本包还在右侧边栏添加“本会话作业”卡片和标签页，在对话中把 `sco_config_form` 工具调用渲染成可编辑的表单，并添加“作业配置”入口来管理已保存的作业和开发机配置。

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

在 Host 配置中与 `cluster-monitor` 和 `sco-submit` 一起挂载；Web 客户端从本包的客户端入口加载两个页面。

```yaml
- name: '@deepseek-ai/dsh-experimental-cluster-monitor'
- name: '@deepseek-ai/dsh-experimental-sco-submit'
- name: '@deepseek-ai/dsh-experimental-client-ui-cluster-monitor'
```

页面包含一个按名称、可选工作空间和可选描述关注任务的表单、显示各任务阶段、步数和描述的关注列表，以及详情面板。详情面板展示任务描述（没有描述时展示控制台显示名）并可编辑；展示指标来源并提供编辑器，可选择已注册的来源类型，设置 `logs` 的解析器、步数键和正则模式、`wandb` 的运行或其他来源的 JSON 选项，也可恢复为配置的默认来源；可按需刷新任务，取消关注前要求再按一次确认，为每个指标绘制一张带步数和数值范围的折线图，并展示日志尾部和最近一次 `describe` 输出。连接断开时保留最后的数据并提示正在重连。

集群配置页面显示 Host 配置里设置的 sco profile 和输出挂载路径，并可以编辑默认工作空间和队列：保存后对该 profile 立即生效、每次启动都生效，并覆盖 Host 配置；留空则使用配置值；有缓存的队列时从中选择队列。下面列出已登记的数据源，可以添加、编辑和删除；添加表单会列出 sco 凭据能看到的 AFS 存储卷供选择。页面还显示已配置的模板、默认工作空间缓存的队列和机型（带重新查询按钮），以及按需加载的 AFS 存储卷用量表。删除数据源前要求再按一次确认，失败信息显示在触发它的操作下方。

右侧边栏打开时，开始页显示“本会话作业”卡片，列出当前 Session 创建或关注的作业：作业数、运行中和排队的数量，以及前三行的阶段、步数、描述和最新指标。点击卡片或其中一行会打开“本会话作业”标签页，列出所有这类作业，并显示与集群任务页面相同的详情面板。手动关注的作业和引入会话归属之前创建的作业不属于任何 Session，只出现在集群任务页面。

`sco_config_form` 调用等待期间，它的工具行是一个表单，包含镜像、挂载（代码源和分支、数据源、输出源）、队列和机型、资源数量、优先级、框架、重试、排队、命令和环境变量；开发机表单不含框架、重试和排队字段。下拉框可以加载同类已保存配置，按钮可以加载 agent 推荐的配置，勾选框会在确认时以指定名称保存设置。“确认”和“取消”会回答这次调用。调用结束后，工具行列出确认的设置；如果未保存，会提示保存。

作业配置页面列出已保存配置及其类型和说明，显示所选配置的设置、原始 JSON、更新时间和上次加载时间，可在名称不变的前提下编辑、新建作业或开发机配置，删除前要求再按一次确认。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节——点击展开</summary>

| 源文件 | 职责 |
|---|---|
| [`src/client/mount.ts`](src/client/mount.ts) | 挂载 `cluster` 和 `clusterConfig` Remote、各自的词典、`main` 页面、侧边栏入口、本会话作业标签页类型和 `sco_config_form` 工具视图 |
| [`src/client/source.ts`](src/client/source.ts) | 关注列表、单个任务、配置概览和打开中配置表单的自动重连镜像 |
| [`src/client/SessionJobs.tsx`](src/client/SessionJobs.tsx) | 本会话作业的开始页卡片、标签页和标签标题 |
| [`src/client/WorkloadForm.tsx`](src/client/WorkloadForm.tsx) | 作业和开发机设置表单 |
| [`src/client/workload.ts`](src/client/workload.ts) | 表单草稿、草稿到 `ScoWorkloadSpec` 的转换和设置摘要 |
| [`src/client/FormToolRow.tsx`](src/client/FormToolRow.tsx) | `sco_config_form` 工具行 |
| [`src/client/SavedConfigsPage.tsx`](src/client/SavedConfigsPage.tsx) | 作业配置页面 |
| [`src/client/workload-locales.ts`](src/client/workload-locales.ts) | `cluster.workload` 词典 |
| [`src/client/ClusterPage.tsx`](src/client/ClusterPage.tsx) | 列表、表单和详情视图 |
| [`src/client/JobSettings.tsx`](src/client/JobSettings.tsx) | 描述和指标来源编辑器 |
| [`src/client/chart.ts`](src/client/chart.ts) | 折线图采样、缩放和数值格式化 |
| [`src/client/locales.ts`](src/client/locales.ts) | `cluster.monitor` 词典 |
| [`src/client/ConfigPage.tsx`](src/client/ConfigPage.tsx) | 配置各分区和数据源表单 |
| [`src/client/config-locales.ts`](src/client/config-locales.ts) | `cluster.config` 词典 |

列表镜像与客户端插件同生命周期；任务镜像在选中任务时打开，切换选择时关闭。图表是采样到最多 400 个点的普通 SVG 折线。本会话作业视图按行的 `sessionId` 过滤关注列表镜像。表单镜像列出所有 Session 中打开的表单，每个工具行只显示与自身调用 id 相同的表单。

</details>

-----

<a id="further-exploration"></a>
## 深入探索

- [集群监控](../cluster-monitor/README.zh.md) — 轮询、解析和 `cluster` Remote。
- [SSP 任务组装](../sco-submit/README.zh.md) — 数据源、模板、缓存选项和 `clusterConfig` Remote。

-----

<a id="model-experience"></a>
## 模型体验

无，表单回答只以 `sco_config_form` 工具结果的形式进入 Session（见 [`tool-sco`](../tool-sco/README.zh.md#model-experience)），各页面不向 Session 发送任何内容。

#### KV Cache 影响

无影响。

## 已知限制与待办工作

<a id="known-limitations-and-deferred-work"></a>

- **固定图表刻度** — 每张图按自身数值范围使用线性坐标轴，不支持缩放、对数刻度或多次运行叠加。
- **表单不创建开发机** — sco 没有创建开发机的命令，确认开发机表单只会把设置返回给 agent。
- **子 agent 的会话作业** — 子 agent 提交的作业属于子 agent 的 Session，不出现在父 Session 的标签页中。
- **模板和 Host 设置只读** — 模板、profile 和输出挂载路径在 Host 配置里修改，不能在页面上修改。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者细节——点击展开</summary>

无。

</details>
