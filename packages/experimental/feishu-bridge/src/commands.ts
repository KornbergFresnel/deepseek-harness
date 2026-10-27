/** Chat commands the bridge answers itself; other slash commands go to the bound Session. */

import type { CardLocale } from './cards.ts'

/** Names of the bridge's own commands. */
export const BRIDGE_COMMANDS = ['help', 'new', 'bind', 'unbind', 'stop', 'status'] as const

/** One bridge command name. */
export type BridgeCommandName = typeof BRIDGE_COMMANDS[number]

/**
 * Recognize a bridge command line: a slash at the start, a bridge command name, then the end or whitespace.
 * @param text - trimmed message text.
 * @returns the command and the text after its name, or undefined for any other text.
 */
export function parseBridgeCommand(text: string): { name: BridgeCommandName; argument: string } | undefined {
  const match = /^\/([a-z]+)(?:\s+([\s\S]*))?$/.exec(text)
  const name = match?.[1]
  if (name === undefined || !(BRIDGE_COMMANDS as readonly string[]).includes(name)) return undefined
  return { name: name as BridgeCommandName, argument: match?.[2] ?? '' }
}

/** Help text listing the bridge commands, per card locale. */
export const HELP: Readonly<Record<CardLocale, string>> = {
  zh: [
    '**飞书桥接命令**',
    '- 直接发送消息：发给当前绑定的会话；还没有绑定时自动创建新会话',
    '- `/new`：创建新会话并绑定到这个聊天',
    '- `/bind <会话 ID>`：把这个聊天绑定到已有会话（例如在 Web 界面里开始的会话）',
    '- `/unbind`：解除绑定',
    '- `/stop`：停止当前回合',
    '- `/status`：查看绑定的会话和状态',
    '- 其他以 `/` 开头的命令会交给会话执行（例如 `/compact`）',
  ].join('\n'),
  en: [
    '**Feishu bridge commands**',
    '- Any other message goes to the bound Session; the first message starts one',
    '- `/new`: start a new Session and bind this chat to it',
    '- `/bind <session id>`: bind this chat to an existing Session, such as one started in the Web UI',
    '- `/unbind`: remove the binding',
    '- `/stop`: stop the current turn',
    '- `/status`: show the bound Session and its state',
    '- Other slash commands run in the Session, such as `/compact`',
  ].join('\n'),
}
