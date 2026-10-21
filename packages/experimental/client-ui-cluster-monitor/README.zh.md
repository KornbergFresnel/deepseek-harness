---
description: "集群任务和集群配置页面：关注的 SSP 任务及其状态、曲线和日志，以及提交任务所用的数据源、模板、选项和存储卷。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-cluster-monitor

[English](README.md) | 中文

## 概述

在 Web 侧边栏添加“集群任务”入口，列出 [`cluster-monitor`](../cluster-monitor/README.zh.md) 关注的任务，并展示所选任务的状态、时间、训练曲线、最近日志和最近一次任务对象；另加“集群配置”入口，查看和编辑 [`sco-submit`](../sco-submit/README.zh.md) 提交任务时使用的配置。

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

页面包含一个按名称和可选工作空间关注任务的表单、显示各任务阶段和步数的关注列表，以及详情面板。详情面板可按需刷新任务，取消关注前要求再按一次确认，为每个指标绘制一张带步数和数值范围的折线图，并展示日志尾部和最近一次 `describe` 输出。连接断开时保留最后的数据并提示正在重连。

集群配置页面显示 sco profile、默认工作空间和队列以及输出挂载路径，这些在 Host 配置里设置，修改后需要重启。下面列出已登记的数据源，可以添加、编辑和删除；添加表单会列出 sco 凭据能看到的 AFS 存储卷供选择。页面还显示已配置的模板、默认工作空间缓存的队列和机型（带重新查询按钮），以及按需加载的 AFS 存储卷用量表。删除数据源前要求再按一次确认，失败信息显示在触发它的操作下方。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节——点击展开</summary>

| 源文件 | 职责 |
|---|---|
| [`src/client/mount.ts`](src/client/mount.ts) | 挂载 `cluster` 和 `clusterConfig` Remote、各自的词典、`main` 页面和侧边栏入口 |
| [`src/client/source.ts`](src/client/source.ts) | 关注列表、单个任务和配置概览的自动重连镜像 |
| [`src/client/ClusterPage.tsx`](src/client/ClusterPage.tsx) | 列表、表单和详情视图 |
| [`src/client/chart.ts`](src/client/chart.ts) | 折线图采样、缩放和数值格式化 |
| [`src/client/locales.ts`](src/client/locales.ts) | `cluster.monitor` 词典 |
| [`src/client/ConfigPage.tsx`](src/client/ConfigPage.tsx) | 配置各分区和数据源表单 |
| [`src/client/config-locales.ts`](src/client/config-locales.ts) | `cluster.config` 词典 |

列表镜像与客户端插件同生命周期；任务镜像在选中任务时打开，切换选择时关闭。图表是采样到最多 400 个点的普通 SVG 折线。

</details>

-----

<a id="further-exploration"></a>
## 深入探索

- [集群监控](../cluster-monitor/README.zh.md) — 轮询、解析和 `cluster` Remote。
- [SSP 任务组装](../sco-submit/README.zh.md) — 数据源、模板、缓存选项和 `clusterConfig` Remote。

-----

<a id="model-experience"></a>
## 模型体验

无，页面只读取 Host 状态，不向 Session 发送任何内容。

#### KV Cache 影响

无影响。

## 已知限制与待办工作

<a id="known-limitations-and-deferred-work"></a>

- **固定图表刻度** — 每张图按自身数值范围使用线性坐标轴，不支持缩放、对数刻度或多次运行叠加。
- **模板和默认设置只读** — 模板、profile、工作空间、队列和输出挂载路径在 Host 配置里修改，不能在页面上修改。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者细节——点击展开</summary>

无。

</details>
