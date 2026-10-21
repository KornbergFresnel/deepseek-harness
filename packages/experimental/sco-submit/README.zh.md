---
description: "按登记的数据、代码和输出位置以及配置的模板组合 SenseCore SSP 任务，并缓存队列选项。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-sco-submit

[English](README.md) | 中文

## 概述

按名字而不是卷 UUID 提交 SSP 训练任务。本服务持久保存集群存储上数据、代码和输出位置的登记表，把配置的任务模板展开为 [sco 网关](../sco/README.zh.md)的创建参数，并缓存工作空间可用的队列和机型，只在缺少缓存或资源相关失败后才重新查询。

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

在 sco 网关和 `storageDomain` 设施（基础 bundle 已提供）之后挂载本服务；需要面向模型的工具时，再添加[工具包](../tool-sco/README.zh.md)。

```yaml
- name: '@deepseek-ai/dsh-experimental-sco'
  config:
    workspace: my-workspace
- name: '@deepseek-ai/dsh-experimental-sco-submit'
  config:
    templates:
      wbt-train:
        image: registry.example/rlh:wbt
        code: rlightning-humanoid
        data: [motion-lafan]
        output: wbt-outputs
        command: python scripts/rsl_rl/train.py --task Tracking-Flat-G1 --headless
- name: '@deepseek-ai/dsh-experimental-tool-sco'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `templates` | `{}` | 按名字配置的任务模板：镜像、代码、数据、输出、命令、环境变量和资源参数 |
| `outputMountPath` | `/outputs` | 每个任务在容器内挂载输出目录的路径 |

数据源在运行时登记，不写在配置里。`data` 数据源把卷里的目录（AFS）或前缀（AOSS）挂载到它的 `mountPath`。`code` 代码库在 `root` 下按 ref 各存一个快照目录，并把 `<root>/<ref>` 挂载到它的 `mountPath`；启动命令先进入该目录并执行 `setup`，再运行任务命令。`output` 输出位置把 `<root>/<任务名>` 挂载到 `outputMountPath`，每个任务写各自的目录。`ctx.scoSubmit` 提供 `sources()`、`addSource(name, source)`、`updateSource(name, source)`、`removeSource(name)`、`listTemplates()`、`outputPath`、`resourceOptions(request?)`、`resolve(request)` 和 `submit(request)`。

`resolve` 把指定模板和请求字段合并，请求字段优先；`env` 按键合并。模板里的数据源名在此时解析，所以删除的数据源会让下一次引用它的提交失败。`submit` 在有缓存时用工作空间的缓存选项校验 `machineType`，执行 `createJob`，真正创建后发出带模板、代码 ref、数据和输出名的 `sco/job-submitted` 事件。CLI 拒绝创建且错误信息提到机型、规格、队列、配额或 GPU 时，`submit` 会先刷新缓存选项再抛出错误，并在错误里说明已刷新。

`resourceOptions` 执行 `sco ssp workspaces list-queues`，保留列表中 `id` 为队列资源 id 的每个队列对象，按 sco profile 和工作空间保存结果；设置 `refresh` 之前一直返回保存的副本。它需要从请求或网关配置得到工作空间；列表里找不到任何队列 id 时失败，并在错误里附上列表片段。

本服务还为[集群配置页面](../client-ui-cluster-monitor/README.zh.md)提供 `clusterConfig` Remote 命名空间：`overview()` 返回 profile、默认工作空间和队列、`outputMountPath`、数据源、模板，以及默认工作空间的缓存选项和每个队列里识别出的机型；`follow()` 在每次数据源变化或选项刷新后推送新的概览；`saveSource({ name, source, replace? })` 添加数据源，设置 `replace` 时替换已有数据源；`deleteSource(name)`、`refreshOptions()` 和 `volumes()` 分别删除数据源、重新查询默认工作空间和列出 AFS 存储卷。记录类型从 `@deepseek-ai/dsh-experimental-sco-submit/types` 导出。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节——点击展开</summary>

| 源文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 配置校验、`sco_submit` 存储域、选项缓存、提交、事件和 `clusterConfig` Remote |
| [`src/resolve.ts`](src/resolve.ts) | 数据源校验、模板合并、挂载字符串、启动命令和无类型 JSON 扫描 |
| [`src/types.ts`](src/types.ts) | 数据源、模板、选项、提交和配置概览记录 |

数据源和选项保存在 `sco_submit` 存储域（`sources` 和 `resource_options` 两张表），无论存储域设施路由到哪个后端，重启后都保留。挂载路径和卷内子路径只允许字母、数字、`.`、`_`、`-` 和 `/`，且不含 `..`，这样每个挂载都是单个 `--volume-mount` 参数，启动命令里的路径也无需加引号。队列 id 通过在列表中查找形如 `/subscriptions/…/clusters/<cluster>/queues/<queue>` 的字符串得到，机型按队列对象中任意位置的完全相等字符串匹配，因为 CLI 没有文档说明这两种 JSON 结构；概览从 `machine_type`（如 `properties.machine_type_allocation` 中）和 `spec_code` 键读取机型。

</details>

-----

<a id="further-exploration"></a>
## 深入探索

- [sco 网关](../sco/README.zh.md) — 创建和队列查询的 CLI 映射与失败行为。
- [SSP 任务工具](../tool-sco/README.zh.md) — 面向模型的数据源、选项和提交工具。
- [存储域](../../storage/storage-domain/README.zh.md) — 持久记录与后端路由。

-----

<a id="model-experience"></a>
## 模型体验

通过 SSP 任务工具的结果间接体现。

#### KV Cache 影响

本包不贡献提示文本。追加的工具结果由工具包负责。

## 已知限制与待办工作

<a id="known-limitations-and-deferred-work"></a>

- **不上传代码** — 代码必须已经以 `<root>/<ref>/` 的形式放在集群存储上；打包本地 commit 并经开发机或任务内浅拷贝传上去的功能留待以后。
- **登记时不检查路径** — 登记数据源不确认目录是否存在；路径写错要等任务启动时才暴露。
- **模板来自配置** — 运行时不能创建或修改模板，资源预设也没有和模板分开建模。
- **选项解析靠启发式** — 队列 id 和机型按字符串形状和相等匹配，CLI 输出变化可能让选项消失而不报错。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

网关的 `sco/job-created` 仍对每次创建触发；`sco/job-submitted` 为通过 `submit` 创建的任务补充组合信息。

</details>
