---
description: "Feishu chat bridge for Workspace Sessions through lark-cli: prompts from chats, replies as rich cards, and approvals and questions answered with card buttons and forms."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-feishu-bridge

English | [中文](README.zh.md)

## Summary

Bind Feishu (Lark) chats to Workspace Sessions through the [lark-cli](https://github.com/larksuite/cli) command line. A message in a bound chat prompts its Session; the Session's replies return as Feishu cards that keep their Markdown; permission requests and `ask_user_question` calls become cards whose buttons and forms answer them from Feishu.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Install lark-cli and sign it in to a Feishu app with a bot (`lark-cli config init`). In the app's developer console, subscribe the bot to `im.message.receive_v1` and to card callbacks (`card.action.trigger`), grant it the message send and update scopes, and add it to the chats it should serve. [`feishu.patch.yml`](feishu.patch.yml) mounts the bridge in the Web profile: fill in the open ids and the workspace directory, then run `pnpm dsh web --patch packages/experimental/feishu-bridge/feishu.patch.yml`.

```yaml
- name: '@deepseek-ai/dsh-experimental-feishu-bridge'
  config:
    allowedUsers: [ou_xxx]
    workspacePath: /home/me/project
    permissionPreset: ask
```

| Field | Default | Meaning |
|---|---|---|
| `allowedUsers` | required | Feishu open ids (`ou_…`) that may prompt Sessions and answer cards; a direct message from anyone else gets their open id back |
| `workspacePath` | required | Absolute directory of the Workspace that Sessions started from Feishu use |
| `allowedChats` | all chats | Chat ids (`oc_…`) the bridge serves |
| `command` | `lark-cli` | Executable name on `PATH` or absolute path |
| `profile` | active profile | lark-cli profile passed as `--profile` |
| `agentPreset` | Workspace default | Agent preset of Sessions started from Feishu |
| `permissionPreset` | Session default | Permission preset applied to Sessions started from Feishu |
| `locale` | `zh` | Card and notice language, `zh` or `en` |
| `forwardReasoning` | `false` | Forward reasoning in a collapsed panel |
| `forwardToolCalls` | `true` | Forward tool calls and their arguments in a collapsed panel |
| `forwardOtherPrompts` | `true` | Forward prompts that other clients send to a bound Session |
| `maxCardChars` | `6000` | Markdown characters per reply card; longer replies span numbered cards |
| `maxArgumentChars` | `1500` | Characters of one tool call's arguments shown on a card |
| `deliveryMemory` | `1000` | Recent Feishu message and callback ids remembered to drop redelivered events |
| `timeoutMs` | `30000` | Deadline of one lark-cli message API call |
| `graceMs` | `3000` | Termination grace of a lark-cli process |
| `maxOutputBytes` | `1048576` | Captured bytes per output stream of one lark-cli call |
| `restartDelayMs` | `5000` | Wait before restarting an event consumer that exited |

In a chat, the first message starts a Session in the configured Workspace and binds the chat to it. These commands control the binding; any other slash command, such as `/compact`, runs in the bound Session:

| Command | Effect |
|---|---|
| `/help` | List the bridge commands and the Session's commands |
| `/new` | Start a new Session and bind the chat to it |
| `/bind <session id>` | Bind the chat to an existing Session, such as one started in the Web client |
| `/unbind` | Remove the binding |
| `/stop` | Cancel the bound Session's current turn |
| `/status` | Show the bound Session and its state |

A Session binds to at most one chat; bindings persist in the `feishu_bridge` storage domain. A permission request from the bound Session, or from a subagent it started, arrives as a card with **Allow once** and **Reject** buttons. Questions arrive as one form with a select or multi-select per question and a text field for a custom answer. A question whose timed wait expires stays answerable from its card. Only an allowed user's click in the same chat counts, and the card then names who decided.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

| Source | Responsibility |
|---|---|
| [`src/index.ts`](src/index.ts) | Config, the `feishuBridge` service, bindings, inbound routing, Session event forwarding, and the approval and question answerers |
| [`src/lark-cli.ts`](src/lark-cli.ts) | The lark-cli transport: two `event consume` processes and the message send and update API |
| [`src/cards.ts`](src/cards.ts) | Feishu card JSON 2.0 builders and their copy |
| [`src/markdown.ts`](src/markdown.ts) | Markdown adaptation for card text and splitting at the card size |
| [`src/commands.ts`](src/commands.ts) | Bridge command parsing and help text |
| [`src/types.ts`](src/types.ts) | Branded Feishu ids, inbound events, and the `FeishuTransport` interface |

**Inbound.** `lark-cli event consume im.message.receive_v1 --as bot` and `lark-cli event consume card.action.trigger --as bot` run for the plugin's lifetime and stream NDJSON. A consumer that exits is restarted after `restartDelayMs`; disposal closes their stdin, which is lark-cli's graceful stop. A message prompt goes through `ctx.sessionController.prompt` with request id `feishu-<message id>`, so a redelivered message cannot prompt twice and the Session records it as an ordinary user message.

**Outbound.** The bridge listens to `session/event` and, for a bound Session, turns `assistant/message` into reply cards, `user/message` from other clients into a marked card, and failed, stopped, or truncated `turn/end` into notices. Cards for one chat are sent in order. Each forwarded card carries a Feishu idempotency key derived from the Session id and event sequence.

**Prompts.** The `approval/request` and `user-questions/request` answerers are registered with `prepend`, so they run before the Web client's answerers. Requests from Sessions without a bound chat, and requests whose card cannot be sent, go to the next answerer. Disposal settles pending approvals as `unavailable` and rejects waiting questions.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Session controller](../../api/session-controller/README.md) — Session creation, prompts, and cancellation.
- [User approval](../../interaction/user-approval/README.md) — the `approval/request` waterfall.
- [User questions](../../interaction/user-questions/README.md) — the `user-questions/request` waterfall and timed waits.
- [lark-cli](https://github.com/larksuite/cli) — Feishu Open Platform command line.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the user messages that Feishu prompts record in the bound Session.

#### KV Cache effect

This package contributes no prompt text. A Feishu message appends one user message, as a Web prompt does.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Text only** — images, files, and other attachments sent in Feishu reach the Session as lark-cli's text rendering; images in replies become links.
- **Web prompts hidden while bound** — the bridge answers a bound Session's permission requests and questions before the Web client does, so the Web panel does not show them until the chat is unbound.
- **Allow once only** — the approval card offers allow-once and reject, not the Web client's longer-lived grants.
- **One app** — one plugin instance serves one lark-cli profile; serving several bots needs several instances with distinct profiles.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer details — click to expand</summary>

Tests replace lark-cli with a Node script (`tests/fake-lark-cli.ts`) that records argv and stdin bodies and answers from control files, so the transport's argv, restart, and failure paths run against a real subprocess. Bridge tests inject an in-memory `FeishuTransport` through the constructor's third parameter.

</details>
