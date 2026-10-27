/** Feishu transport over the lark-cli command line: event consumers for inbound events and the message API for cards. */

import { homedir } from 'node:os'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {} from '@deepseek-ai/dsh-subprocess'
import type { SubprocessCollectedOutputs } from '@deepseek-ai/dsh-subprocess'
import { deadline } from '@deepseek-ai/dsh-timeout'
import { errorChain } from '@deepseek-ai/dsh-llm'
import type {
  FeishuCard, FeishuCardAction, FeishuChatId, FeishuInbound, FeishuInboundMessage, FeishuMessageId, FeishuOpenId, FeishuTransport,
} from './types.ts'

/** Executable, profile, and subprocess limits for lark-cli invocations. */
export interface LarkCliOptions {
  /** Executable name on PATH or absolute path of lark-cli. */
  readonly command: string
  /** lark-cli profile passed as `--profile`; undefined uses the active profile. */
  readonly profile: string | undefined
  /** Deadline in milliseconds for one message API call. */
  readonly timeoutMs: number
  /** Subprocess termination grace in milliseconds. */
  readonly graceMs: number
  /** Maximum captured bytes per output stream of one API call, and of a consumer's stderr. */
  readonly maxOutputBytes: number
  /** Wait in milliseconds before restarting an event consumer that exited. */
  readonly restartDelayMs: number
}

/** Message identities embedded in API paths. */
const MESSAGE_ID = /^om_[A-Za-z0-9_-]+$/

/** Chat identities embedded in API paths. */
const CHAT_ID = /^oc_[A-Za-z0-9_-]+$/

/** Read a non-empty string field from a parsed event. */
function stringField(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Parse a JSON-encoded string field; undefined when absent or not JSON. */
function jsonField(record: Record<string, unknown>, field: string): unknown {
  const value = record[field]
  if (typeof value !== 'string') return value
  if (value === '') return undefined
  try {
    return JSON.parse(value)
  } catch (_notJson) {
    return value
  }
}

/** Narrow a parsed value to a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Parse one `im.message.receive_v1` line of `lark-cli event consume`.
 * @param value - one parsed NDJSON value.
 * @returns the message, or undefined when required fields are missing.
 */
export function parseMessageEvent(value: unknown): FeishuInboundMessage | undefined {
  if (!isRecord(value)) return undefined
  const messageId = stringField(value, 'message_id') ?? stringField(value, 'id')
  const chatId = stringField(value, 'chat_id')
  const senderId = stringField(value, 'sender_id')
  if (messageId === undefined || chatId === undefined || senderId === undefined) return undefined
  return {
    kind: 'message',
    messageId: brandString<FeishuMessageId>(messageId),
    chatId: brandString<FeishuChatId>(chatId),
    chatType: value['chat_type'] === 'group' ? 'group' : 'p2p',
    senderId: brandString<FeishuOpenId>(senderId),
    senderType: value['sender_type'] === 'bot' ? 'bot' : 'user',
    messageType: stringField(value, 'message_type') ?? 'text',
    text: typeof value['content'] === 'string' ? value['content'] : '',
  }
}

/**
 * Parse one `card.action.trigger` line of `lark-cli event consume`.
 * @param value - one parsed NDJSON value.
 * @returns the action, or undefined when required fields are missing.
 */
export function parseCardActionEvent(value: unknown): FeishuCardAction | undefined {
  if (!isRecord(value)) return undefined
  const eventId = stringField(value, 'event_id')
  const messageId = stringField(value, 'message_id')
  const chatId = stringField(value, 'chat_id')
  const operatorId = stringField(value, 'operator_id')
  if (eventId === undefined || messageId === undefined || chatId === undefined || operatorId === undefined) return undefined
  const form = jsonField(value, 'form_value')
  return {
    kind: 'card-action',
    eventId,
    messageId: brandString<FeishuMessageId>(messageId),
    chatId: brandString<FeishuChatId>(chatId),
    operatorId: brandString<FeishuOpenId>(operatorId),
    value: jsonField(value, 'action_value'),
    formValue: isRecord(form) && Object.keys(form).length > 0 ? form : undefined,
  }
}

/** Event keys the bridge consumes and the parser of each. */
const CONSUMERS: readonly (readonly [string, (value: unknown) => FeishuInbound | undefined])[] = [
  ['im.message.receive_v1', parseMessageEvent],
  ['card.action.trigger', parseCardActionEvent],
]

/**
 * lark-cli transport. Every invocation is a literal argv run without a shell,
 * as the bot identity (`--as bot`); request bodies travel on stdin.
 */
export class LarkCliTransport implements FeishuTransport {
  private readonly cwd = homedir()

  /**
   * @param ctx - context providing `subprocess` and the logger.
   * @param options - executable, profile, and limits.
   */
  constructor(private readonly ctx: Context, private readonly options: LarkCliOptions) {}

  async consume(onEvent: (event: FeishuInbound) => void, signal: AbortSignal): Promise<void> {
    await Promise.all(CONSUMERS.map(([key, parse]) => this.consumeKey(key, parse, onEvent, signal)))
  }

  async sendCard(chatId: FeishuChatId, card: FeishuCard, idempotencyKey: string, signal?: AbortSignal): Promise<FeishuMessageId> {
    const data = await this.api(
      'POST', '/open-apis/im/v1/messages', ['--params', JSON.stringify({ receive_id_type: 'chat_id' })],
      { receive_id: chatId, msg_type: 'interactive', content: JSON.stringify(card), uuid: idempotencyKey.slice(0, 50) },
      signal,
    )
    const messageId = isRecord(data) ? data['message_id'] : undefined
    if (typeof messageId !== 'string' || !MESSAGE_ID.test(messageId)) {
      throw new Error(`lark-cli message send returned no message_id: ${JSON.stringify(data).slice(0, 200)}`)
    }
    return brandString<FeishuMessageId>(messageId)
  }

  async updateCard(messageId: FeishuMessageId, card: FeishuCard, signal?: AbortSignal): Promise<void> {
    if (!MESSAGE_ID.test(messageId)) throw new Error(`invalid Feishu message id ${JSON.stringify(messageId)}`)
    await this.api('PATCH', `/open-apis/im/v1/messages/${messageId}`, [], { content: JSON.stringify(card) }, signal)
  }

  async chatName(chatId: FeishuChatId, signal?: AbortSignal): Promise<string | undefined> {
    if (!CHAT_ID.test(chatId)) throw new Error(`invalid Feishu chat id ${JSON.stringify(chatId)}`)
    const data = await this.api('GET', `/open-apis/im/v1/chats/${chatId}`, [], undefined, signal)
    const name = isRecord(data) ? data['name'] : undefined
    return typeof name === 'string' && name !== '' ? name : undefined
  }

  /** The executable and global flags shared by every invocation. */
  private async program(signal: AbortSignal): Promise<string[]> {
    const program = await this.ctx.subprocess.resolveExecutable(this.options.command, undefined, signal)
    return [program, ...this.options.profile === undefined ? [] : ['--profile', this.options.profile]]
  }

  /** Run one consumer, restarting it after each exit until the signal aborts. */
  private async consumeKey(
    key: string,
    parse: (value: unknown) => FeishuInbound | undefined,
    onEvent: (event: FeishuInbound) => void,
    signal: AbortSignal,
  ): Promise<void> {
    for (;;) {
      try {
        await this.consumeOnce(key, parse, onEvent, signal)
      } catch (error: unknown) {
        if (!signal.aborted) this.ctx.logger.warn(`feishu-bridge: lark-cli event consume ${key} stopped: ${errorChain(error)}; restarting in ${String(this.options.restartDelayMs)} ms`)
      }
      try {
        await delay(this.options.restartDelayMs, undefined, { signal })
      } catch (_aborted) {
        return
      }
    }
  }

  /** Run one consumer process to its exit; throws with its stderr when it exits on its own. */
  private async consumeOnce(
    key: string,
    parse: (value: unknown) => FeishuInbound | undefined,
    onEvent: (event: FeishuInbound) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const child = this.ctx.subprocess.spawn({
      argv: [...await this.program(signal), 'event', 'consume', key, '--as', 'bot'],
      cwd: this.cwd,
      signal,
      graceMs: this.options.graceMs,
      // An open stdin keeps an unbounded consumer running; closing it is lark-cli's graceful stop.
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: this.options.maxOutputBytes } },
    })
    const onAbort = (): void => { child.stdin?.end() }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      /* v8 ignore start -- 'pipe' dispositions expose the stream by the seam contract; defensive. */
      if (child.stdout === undefined) throw new Error('subprocess implementation dropped the piped stdout')
      /* v8 ignore stop */
      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
      for await (const line of lines) {
        if (line.trim() === '') continue
        let value: unknown
        try {
          value = JSON.parse(line)
        } catch (_notJson) {
          this.ctx.logger.warn(`feishu-bridge: ${key} consumer wrote a non-JSON line: ${line.slice(0, 200)}`)
          continue
        }
        const event = parse(value)
        if (event === undefined) {
          this.ctx.logger.debug(`feishu-bridge: ${key} event without required fields was skipped`)
          continue
        }
        onEvent(event)
      }
      const outcome = await child.done
      if (signal.aborted) return
      // The spawn spec collects stderr.
      const stderr = (child.collected as Required<Pick<SubprocessCollectedOutputs, 'stderr'>>).stderr.readFrom(0).text.trim()
      throw new Error(`exited (${String(outcome.signal ?? outcome.exitCode)}): ${stderr.slice(-500)}`)
    } finally {
      signal.removeEventListener('abort', onAbort)
      child.stdin?.end()
      child.terminate()
      await child.waitForExit()
    }
  }

  /** Run `lark-cli api <method> <path>`, with a JSON body on stdin when one is given; returns the success envelope's `data`. */
  private async api(
    method: string, path: string, flags: readonly string[], body: unknown, signal: AbortSignal | undefined,
  ): Promise<unknown> {
    using timeout = deadline(signal, this.options.timeoutMs, 'FEISHU_API_TIMEOUT')
    const child = this.ctx.subprocess.spawn({
      argv: [...await this.program(timeout.signal), 'api', method, path, ...flags, ...body === undefined ? [] : ['--data', '-'], '--as', 'bot'],
      cwd: this.cwd,
      signal: timeout.signal,
      graceMs: this.options.graceMs,
      stdio: {
        stdin: body === undefined ? 'ignore' : { data: JSON.stringify(body) },
        stdout: { maxBytes: this.options.maxOutputBytes },
        stderr: { maxBytes: this.options.maxOutputBytes },
      },
    })
    try {
      const outcome = await child.done
      timeout.signal.throwIfAborted()
      // The spawn spec collects both streams.
      const captured = child.collected as Required<SubprocessCollectedOutputs>
      const stdout = captured.stdout.readFrom(0).text
      if (outcome.exitCode !== 0) {
        const stderr = captured.stderr.readFrom(0).text.trim()
        throw new Error(`lark-cli api ${method} ${path} failed (${String(outcome.signal ?? outcome.exitCode)}): ${(stderr === '' ? stdout : stderr).slice(0, 500)}`)
      }
      let envelope: unknown
      try {
        envelope = JSON.parse(stdout)
      } catch (error: unknown) {
        throw new Error(`lark-cli api returned non-JSON output: ${stdout.slice(0, 200)}`, { cause: error })
      }
      if (!isRecord(envelope) || envelope['ok'] !== true) {
        throw new Error(`lark-cli api returned no success envelope: ${stdout.slice(0, 200)}`)
      }
      return envelope['data']
    } finally {
      child.terminate()
      await child.waitForExit()
    }
  }
}
