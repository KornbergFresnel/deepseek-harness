---
description: "通过 lark-cli 把飞书聊天桥接到工作区会话：聊天消息作为提示，回复以富文本卡片发回，权限批准和提问可用卡片按钮与表单作答。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-feishu-bridge

[English](README.md) | 中文

## 概述

通过 [lark-cli](https://github.com/larksuite/cli) 命令行把飞书（Lark）聊天绑定到工作区会话。绑定聊天中的消息会向其会话发送提示；会话的回复以保留 Markdown 格式的飞书卡片发回；权限请求和 `ask_user_question` 调用会变成卡片，用户可以在飞书中用卡片按钮和表单作答。

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

安装 lark-cli，并登录一个带机器人的飞书应用（`lark-cli config init`）。在应用的开发者后台为机器人订阅 `im.message.receive_v1` 和卡片回调（`card.action.trigger`），授予发送和更新消息的权限，并把机器人加入需要服务的聊天。[`feishu.patch.yml`](feishu.patch.yml) 会把桥接插件挂载到 Web 配置：填好 open_id 和工作目录后，执行 `pnpm dsh web --patch packages/experimental/feishu-bridge/feishu.patch.yml`。

```yaml
- name: '@deepseek-ai/dsh-experimental-feishu-bridge'
  config:
    allowedUsers: [ou_xxx]
    workspacePath: /home/me/project
    permissionPreset: ask
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `allowedUsers` | 必填 | 可以向会话发送提示和操作卡片的飞书 open_id（`ou_…`）；其他人私聊机器人时会收到自己的 open_id |
| `workspacePath` | 必填 | 从飞书新建的会话所用工作区的绝对路径 |
| `allowedChats` | 所有聊天 | 桥接服务的聊天 ID（`oc_…`） |
| `command` | `lark-cli` | `PATH` 中的可执行文件名或绝对路径 |
| `profile` | 当前 profile | 作为 `--profile` 传给 lark-cli 的 profile |
| `agentPreset` | 工作区默认值 | 从飞书新建会话的 Agent 预设 |
| `permissionPreset` | 会话默认值 | 应用到从飞书新建会话的权限预设 |
| `locale` | `zh` | 卡片和通知的语言，`zh` 或 `en` |
| `forwardReasoning` | `false` | 在折叠面板中转发思考过程 |
| `forwardToolCalls` | `true` | 在折叠面板中转发工具调用及其参数 |
| `forwardOtherPrompts` | `true` | 转发其他客户端发给已绑定会话的提示 |
| `maxCardChars` | `6000` | 每张回复卡片的 Markdown 字符数；更长的回复分成带编号的多张卡片 |
| `maxArgumentChars` | `1500` | 卡片上显示的单个工具调用参数字符数 |
| `deliveryMemory` | `1000` | 记住的最近飞书消息和回调 ID 数量，用于丢弃重复投递的事件 |
| `timeoutMs` | `30000` | 单次 lark-cli 消息 API 调用的期限 |
| `graceMs` | `3000` | lark-cli 进程的终止宽限时间 |
| `maxOutputBytes` | `1048576` | 单次 lark-cli 调用每个输出流捕获的字节数 |
| `restartDelayMs` | `5000` | 事件消费进程退出后重启前的等待时间 |

在聊天中，第一条消息会在配置的工作区新建会话，并把聊天绑定到该会话。下面的命令控制绑定；其他斜杠命令（例如 `/compact`）在绑定的会话中执行：

| 命令 | 作用 |
|---|---|
| `/help` | 列出桥接命令和会话命令 |
| `/new` | 新建会话并把聊天绑定到它 |
| `/bind <会话 ID>` | 把聊天绑定到已有会话，例如在 Web 客户端开始的会话 |
| `/unbind` | 解除绑定 |
| `/stop` | 取消绑定会话的当前回合 |
| `/status` | 显示绑定的会话及其状态 |

一个会话最多绑定一个聊天；绑定保存在 `feishu_bridge` 存储域中。来自绑定会话或其启动的子 Agent 的权限请求会以带 **允许一次** 和 **拒绝** 按钮的卡片送达。提问以一个表单送达，每个问题对应一个单选或多选框，以及一个自定义答案文本框。限时等待已过期的提问仍可在卡片上作答。只有允许的用户在同一聊天中的点击才会生效，卡片随后会显示作出决定的人。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节 — 点击展开</summary>

| 源文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 配置、`feishuBridge` 服务、绑定、入站路由、会话事件转发，以及批准和提问的应答器 |
| [`src/lark-cli.ts`](src/lark-cli.ts) | lark-cli 传输：两个 `event consume` 进程，以及消息发送和更新 API |
| [`src/cards.ts`](src/cards.ts) | 飞书卡片 JSON 2.0 构建函数及其文案 |
| [`src/markdown.ts`](src/markdown.ts) | 面向卡片文本的 Markdown 适配，以及按卡片大小切分 |
| [`src/commands.ts`](src/commands.ts) | 桥接命令解析和帮助文本 |
| [`src/types.ts`](src/types.ts) | 带品牌的飞书 ID、入站事件和 `FeishuTransport` 接口 |

**入站。** `lark-cli event consume im.message.receive_v1 --as bot` 和 `lark-cli event consume card.action.trigger --as bot` 在插件生命周期内持续运行并输出 NDJSON。退出的消费进程会在 `restartDelayMs` 后重启；释放插件时关闭它们的 stdin，这是 lark-cli 的正常停止方式。消息提示通过 `ctx.sessionController.prompt` 发送，请求 ID 为 `feishu-<消息 ID>`，因此重复投递的消息不会重复提示，会话也会把它记录为普通用户消息。

**出站。** 桥接监听 `session/event`；对已绑定的会话，把 `assistant/message` 转成回复卡片，把其他客户端的 `user/message` 转成带标记的卡片，把失败、停止或被截断的 `turn/end` 转成通知。同一聊天的卡片按顺序发送。每张转发的卡片携带由会话 ID 和事件序号得出的飞书幂等键。

**提示。** `approval/request` 和 `user-questions/request` 应答器以 `prepend` 注册，因此先于 Web 客户端的应答器运行。没有绑定聊天的会话的请求，以及卡片无法发送的请求，会交给下一个应答器。释放插件时，未决的批准结算为 `unavailable`，等待中的提问被拒绝。

</details>

-----

<a id="further-exploration"></a>
## 深入探索

- [会话控制器](../../api/session-controller/README.zh.md) — 会话创建、提示和取消。
- [用户批准](../../interaction/user-approval/README.zh.md) — `approval/request` 瀑布事件。
- [用户提问](../../interaction/user-questions/README.zh.md) — `user-questions/request` 瀑布事件和限时等待。
- [lark-cli](https://github.com/larksuite/cli) — 飞书开放平台命令行。

-----

<a id="model-experience"></a>
## 模型体验

通过飞书提示在绑定会话中记录的用户消息间接影响模型。

#### KV Cache 影响

本包不贡献提示文本。一条飞书消息追加一条用户消息，与 Web 提示相同。

## 已知限制与待办工作

<a id="known-limitations-and-deferred-work"></a>

- **仅文本** — 飞书中发送的图片、文件和其他附件以 lark-cli 的文本渲染进入会话；回复中的图片变成链接。
- **绑定期间 Web 不显示提示** — 桥接先于 Web 客户端应答已绑定会话的权限请求和提问，因此解除绑定前 Web 面板不会显示它们。
- **只能允许一次** — 批准卡片提供允许一次和拒绝，不提供 Web 客户端的长期授权。
- **单个应用** — 一个插件实例服务一个 lark-cli profile；服务多个机器人需要多个使用不同 profile 的实例。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者细节 — 点击展开</summary>

测试用一个 Node 脚本（`tests/fake-lark-cli.ts`）替代 lark-cli，它记录 argv 和 stdin 请求体，并根据控制文件作答，因此传输的 argv、重启和失败路径会在真实子进程上运行。桥接测试通过构造函数的第三个参数注入内存中的 `FeishuTransport`。

</details>
