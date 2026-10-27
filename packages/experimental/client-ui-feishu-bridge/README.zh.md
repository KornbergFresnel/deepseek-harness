---
description: "会话标题栏里的飞书按钮：从菜单把当前会话连接到飞书聊天，或断开连接。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-feishu-bridge

[English](README.md) | 中文

## 概述

在会话标题栏的按钮里，把当前会话（无论 Web 客户端在哪个工作区打开它）连接到 [`feishu-bridge`](../feishu-bridge/README.zh.md) 服务的飞书聊天，或断开连接。

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

在 Host 配置里与 `feishu-bridge` 一起挂载；Web 客户端从本包的 client 入口加载按钮。

```yaml
- name: '@deepseek-ai/dsh-experimental-feishu-bridge'
  config:
    allowedUsers: [ou_xxx]
- name: '@deepseek-ai/dsh-experimental-client-ui-feishu-bridge'
```

按钮占用 `conversation.session.header.utilities` 插槽。没有聊天驱动会话时显示**连接飞书**，有聊天驱动时显示聊天名称。菜单列出允许的用户曾在其中给机器人发过消息的聊天，最近活跃的在前；正在驱动其他会话的聊天标为使用中，选择它会把该聊天移到当前会话。**断开连接**移除绑定。绑定变化的每个聊天都会收到机器人的通知。会话变化、打开菜单和窗口重新获得焦点时都会重新读取连接。变更被拒绝时，横幅显示桥接的消息；无法读取连接时按钮禁用，悬停提示给出错误。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节——点击展开</summary>

| 源文件 | 职责 |
|---|---|
| [`src/client/mount.ts`](src/client/mount.ts) | 挂载 `feishuBridge` Remote、词典和 `conversation.session.header.utilities` 条目 |
| [`src/client/FeishuChip.tsx`](src/client/FeishuChip.tsx) | 按钮、菜单条目和失败横幅 |
| [`src/client/locales.ts`](src/client/locales.ts) | `feishu.bridge` 词典 |

每次读取、连接或断开都取一个代号；为之前的会话发出的回答，或已被更新的读取取代的回答，会被丢弃。

</details>

-----

<a id="further-exploration"></a>
## 深入探索

- [飞书聊天桥接](../feishu-bridge/README.zh.md) — `feishuBridge` Remote、聊天命令和工作区选择卡片。

-----

<a id="model-experience"></a>
## 模型体验

无，按钮只改变由哪个聊天驱动会话，不向会话发送任何内容。

#### KV Cache 影响

无影响。

## 已知限制与待办工作

<a id="known-limitations-and-deferred-work"></a>

- **聊天需先发消息** — 桥接从收到的消息中认识聊天，所以只有允许的用户在聊天里给机器人发过消息后，它才会出现在菜单中。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者细节——点击展开</summary>

无。

</details>
