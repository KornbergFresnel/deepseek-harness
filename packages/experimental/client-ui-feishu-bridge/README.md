---
description: "The Feishu chip in the Session header: connects the open Session to a Feishu chat, or disconnects it, from a menu."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-feishu-bridge

English | [中文](README.zh.md)

## Summary

Connect the open Session, in whichever workspace the Web client opened it, to a Feishu chat that [`feishu-bridge`](../feishu-bridge/README.md) serves, or disconnect it, from a chip in the Session header.

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

Mount it in the Host configuration beside `feishu-bridge`; the Web client loads the chip from the package's client entry.

```yaml
- name: '@deepseek-ai/dsh-experimental-feishu-bridge'
  config:
    allowedUsers: [ou_xxx]
- name: '@deepseek-ai/dsh-experimental-client-ui-feishu-bridge'
```

The chip occupies the `conversation.session.header.utilities` slot. It reads **Connect Feishu** while no chat drives the Session, and the chat's name while one does. Its menu lists the chats in which an allowed user has written to the bot, most recently active first; a chat that drives another Session is marked in use, and picking it moves that chat to the open Session. **Disconnect** removes the binding. The bridge posts a notice in each chat whose binding changes. The chip reads the connection when the Session changes, when the menu opens, and when the window regains focus. A refused change shows the bridge's message in a banner; when the connection cannot be read the chip is disabled and its tooltip carries the error.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

| Source | Responsibility |
|---|---|
| [`src/client/mount.ts`](src/client/mount.ts) | Mount the `feishuBridge` Remote, the dictionaries, and the `conversation.session.header.utilities` entry |
| [`src/client/FeishuChip.tsx`](src/client/FeishuChip.tsx) | The chip, its menu entries, and the failure banner |
| [`src/client/locales.ts`](src/client/locales.ts) | `feishu.bridge` dictionaries |

Each read, connection, or disconnection takes a generation number; an answer that an earlier Session asked for, or that a newer read overtook, is dropped.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Feishu chat bridge](../feishu-bridge/README.md) — the `feishuBridge` Remote, chat commands, and the workspace picker card.

-----

<a id="model-experience"></a>
## Model Experience

None, as the chip changes which chat drives a Session and sends nothing to a Session.

#### KV Cache effect

No effect.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Chats must write first** — a chat appears in the menu only after an allowed user writes to the bot there, because the bridge learns chats from inbound messages.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer details — click to expand</summary>

None.

</details>
