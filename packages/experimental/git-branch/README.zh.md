---
description: "gitBranch Remote：会话工作目录的当前分支、本地和远程跟踪分支，以及分支切换。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-git-branch

[English](README.md) | 中文

## 概述

向 Web 客户端提供会话工作目录的 Git 分支状态，并按请求切换分支。每条 Git 命令都通过会话自己的 subprocess provider，在它的 working-directory provider 给出的目录里运行，所以在远程执行环境上的会话读取和切换的是远端的检出。[`client-ui-git-branch`](../client-ui-git-branch/README.zh.md) 在新会话页面显示分支。

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

在 Host 配置里与客户端包一起挂载：

```yaml
- name: '@deepseek-ai/dsh-experimental-git-branch'
- name: '@deepseek-ai/dsh-experimental-client-ui-git-branch'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `command` | `git` | Git 可执行文件路径或 PATH 中的名称 |
| `timeoutMs` | `15000` | 单条 Git 命令被终止前的毫秒数 |
| `graceMs` | `2000` | 被终止的 Git 命令退出的宽限毫秒数 |
| `maxOutputBytes` | `1048576` | 每条 Git 命令保留的输出字节数；分支列表超出时失败 |
| `maxBranches` | `200` | 本地分支和远程跟踪分支各自最多返回的数量 |

本服务注册 `ctx.gitBranch` 和 `gitBranch` Remote 命名空间，其方法把会话作为 Agent 参数。`status(session)` 在仓库之外返回 `{ kind: 'none', cwd }`，否则返回 `{ kind: 'repository', cwd, root, branch, commit, local, remote, truncated }`：HEAD 处于分离状态时 `branch` 为 null；`commit` 是缩写的 HEAD 提交，首次提交前为空；`local` 列出本地分支，`remote` 以 `<remote>/<branch>` 形式列出没有同名本地分支的远程跟踪分支，两者都按最近提交排序并截断到 `maxBranches`。`switchBranch(session, { branch, remote? })` 只接受列表中的名称：它执行 `git switch <branch>`，设置 `remote` 时执行 `git switch --track <remote>/<branch>`，即创建并检出一个跟踪该远程分支的本地分支，然后返回新状态。Git 会保留不冲突的未提交改动，否则拒绝切换；拒绝信息原样带上 Git 的消息返回给调用方。Git 因其他原因无法读取目录、分支列表超过 `maxOutputBytes`、超时，以及缺少 subprocess 或 working-directory provider 时调用失败。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节——点击展开</summary>

| 源文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 配置、Git 运行器、状态解析和 `gitBranch` Remote |
| [`src/types.ts`](src/types.ts) | 与客户端共享的状态和切换请求记录 |

`status` 依次执行 `git rev-parse --show-toplevel`、`git symbolic-ref --quiet --short HEAD`、`git rev-parse --verify --quiet --short HEAD` 和 `git for-each-ref --sort=-committerdate refs/heads refs/remotes`。每条命令都带 `GIT_TERMINAL_PROMPT=0`、`GIT_OPTIONAL_LOCKS=0`、`LC_ALL=C` 和 `GIT_CONFIG_COUNT=0` 运行，因为 subprocess 的凭据清理会删除环境中的 `GIT_CONFIG_KEY_n`。`switchBranch` 先读取状态，所以会被 Git 当作选项的名称或已经消失的分支不会传给 `git switch`。

</details>

-----

<a id="further-exploration"></a>
## 深入探索

- [Git 分支按钮](../client-ui-git-branch/README.zh.md) — 在新会话页面读取和切换分支的控件。
- [工作目录](../../session/working-directory/README.zh.md) — 会话目录如何解析。

-----

<a id="model-experience"></a>
## 模型体验

无，本服务只服务 Web 客户端，不向模型请求添加任何内容；切换分支会改变之后工具调用读取到的文件。

#### KV Cache 影响

无影响。

## 已知限制与待办工作

<a id="known-limitations-and-deferred-work"></a>

- **不新建分支、不 fetch、不 stash** — 只在本地已有的分支或已有的远程跟踪分支之间切换；不按名称新建分支，不拉取远程，也不暂存改动。
- **不防护运行中的轮次** — Remote 不会在同一目录有轮次运行时拒绝切换；客户端只在新会话页面提供切换。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者细节——点击展开</summary>

无。

</details>
