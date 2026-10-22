---
description: "新会话页面的 Git 分支按钮：在工作区选择器旁显示工作目录的分支，并从菜单切换。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-git-branch

[English](README.md) | 中文

## 概述

在新会话页面的工作区和预设控件之后显示新会话工作目录的 Git 分支，并从 [`git-branch`](../git-branch/README.zh.md) 提供的本地分支和远程跟踪分支菜单中切换。

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

在 Host 配置里与 `git-branch` 一起挂载；Web 客户端从本包的 client 入口加载按钮。

```yaml
- name: '@deepseek-ai/dsh-experimental-git-branch'
- name: '@deepseek-ai/dsh-experimental-client-ui-git-branch'
```

按钮占用 `conversation.hero.context` 插槽。它显示当前分支，HEAD 分离时显示缩写提交，悬停提示写出仓库根目录。会话变化、打开菜单和窗口重新获得焦点时都会重新读取分支，所以在终端里切换的分支无需刷新页面就会出现。菜单先列本地分支，再列没有对应本地分支的远程跟踪分支；选择远程跟踪分支会创建一个跟踪它的本地分支。切换被拒绝时（例如 Git 因未提交的改动会被覆盖而拒绝），横幅显示 Git 的消息，并重新读取分支。不在仓库中时不显示按钮；无法读取 Git 时按钮禁用，悬停提示给出错误。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节——点击展开</summary>

| 源文件 | 职责 |
|---|---|
| [`src/client/mount.ts`](src/client/mount.ts) | 挂载 `gitBranch` Remote、词典和 `conversation.hero.context` 条目 |
| [`src/client/BranchChip.tsx`](src/client/BranchChip.tsx) | 按钮、菜单条目和失败横幅 |
| [`src/client/locales.ts`](src/client/locales.ts) | `git.branch` 词典 |

每次读取或切换都取一个代号；为之前的会话发出的回答，或已被更新的读取取代的回答，会被丢弃。

</details>

-----

<a id="further-exploration"></a>
## 深入探索

- [Git 分支服务](../git-branch/README.zh.md) — `gitBranch` Remote、它的限制和 Git 的切换行为。

-----

<a id="model-experience"></a>
## 模型体验

无，按钮只读取和切换工作区文件，不向会话发送任何内容。

#### KV Cache 影响

无影响。

## 已知限制与待办工作

<a id="known-limitations-and-deferred-work"></a>

- **只在新会话页面** — 已开始的会话标题栏里不显示按钮。
- **不能搜索** — 菜单每类最多列出 `maxBranches` 个分支，不能筛选。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者细节——点击展开</summary>

无。

</details>
