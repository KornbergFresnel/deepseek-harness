/** Feishu identifiers, inbound events, card values, and the transport the bridge drives. */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Feishu chat identity (`oc_…`). */
export type FeishuChatId = Branded<'FeishuChatId'>

/** Feishu message identity (`om_…`). */
export type FeishuMessageId = Branded<'FeishuMessageId'>

/** Feishu user identity within the bot's app (`ou_…`). */
export type FeishuOpenId = Branded<'FeishuOpenId'>

/** One chat message received by the bot, as `lark-cli event consume im.message.receive_v1` flattens it. */
export interface FeishuInboundMessage {
  readonly kind: 'message'
  /** Message identity; the deduplication and prompt idempotency key. */
  readonly messageId: FeishuMessageId
  readonly chatId: FeishuChatId
  readonly chatType: 'p2p' | 'group'
  readonly senderId: FeishuOpenId
  /** `user` for people; the bridge ignores `bot` senders, including itself. */
  readonly senderType: 'user' | 'bot'
  /** Feishu message type, such as `text`, `post`, or `image`. */
  readonly messageType: string
  /** Human-readable text that lark-cli rendered from the message content, with mentions resolved to names. */
  readonly text: string
}

/** One interaction with a card the bridge sent, as `lark-cli event consume card.action.trigger` flattens it. */
export interface FeishuCardAction {
  readonly kind: 'card-action'
  /** Callback delivery identity; the deduplication key. */
  readonly eventId: string
  /** Card message the user interacted with. */
  readonly messageId: FeishuMessageId
  readonly chatId: FeishuChatId
  readonly operatorId: FeishuOpenId
  /** The `value` of the clicked button's callback behavior, parsed from JSON; undefined for a form submit button. */
  readonly value: unknown
  /** Form field values keyed by component name when a form was submitted. */
  readonly formValue: Readonly<Record<string, unknown>> | undefined
}

/** Any inbound Feishu event the bridge consumes. */
export type FeishuInbound = FeishuInboundMessage | FeishuCardAction

/** A Feishu Card JSON 2.0 document; the bridge builds it and the transport serializes it. */
export type FeishuCard = Readonly<Record<string, unknown>>

/**
 * Feishu operations the bridge needs. The shipped implementation runs lark-cli;
 * tests replace it.
 */
export interface FeishuTransport {
  /**
   * Consume inbound events until the signal aborts. Recoverable consumer
   * failures are retried by the transport; the returned promise settles after
   * the signal aborts and every consumer stopped.
   * @param onEvent - receives each event once per delivery, in arrival order per event kind.
   * @param signal - stops consumption.
   * @returns settles once every consumer exited.
   */
  consume(onEvent: (event: FeishuInbound) => void, signal: AbortSignal): Promise<void>
  /**
   * Send one interactive card to a chat.
   * @param chatId - receiving chat.
   * @param card - Card JSON 2.0 document.
   * @param idempotencyKey - Feishu `uuid`: the same key sends at most one message within an hour.
   * @param signal - cancellation; a cancelled send may still have been delivered.
   * @returns the sent message identity.
   */
  sendCard(chatId: FeishuChatId, card: FeishuCard, idempotencyKey: string, signal?: AbortSignal): Promise<FeishuMessageId>
  /**
   * Replace the content of a card message the bot sent.
   * @param messageId - card message to update.
   * @param card - complete replacement Card JSON 2.0 document.
   * @param signal - cancellation.
   */
  updateCard(messageId: FeishuMessageId, card: FeishuCard, signal?: AbortSignal): Promise<void>
  /**
   * Read a chat's display name.
   * @param chatId - chat to read.
   * @param signal - cancellation.
   * @returns the group name, or undefined when the chat has none, such as a direct chat.
   */
  chatName(chatId: FeishuChatId, signal?: AbortSignal): Promise<string | undefined>
}

/** The callback value of a permission-request card button. */
export interface ApprovalButtonValue {
  readonly dsh: 'approval'
  readonly decision: 'allow' | 'reject'
}

/** One chat's durable link to the Session it drives. */
export interface FeishuChatBinding {
  /** Bound Session identity. */
  readonly sessionId: string
  /** ISO time the chat was bound. */
  readonly boundAt: string
  /** Feishu user who bound the chat. */
  readonly boundBy: string
}

/** A chat in which an allowed user wrote to the bot, remembered so the Web client can offer it. */
export interface FeishuSeenChat {
  /** `p2p` for a direct chat with the bot. */
  readonly chatType: 'p2p' | 'group'
  /** Group name; null when unknown or for a direct chat. */
  readonly name: string | null
  /** ISO time an allowed user last wrote in the chat. */
  readonly lastSeenAt: string
}

/** One chat the Web client can connect a Session to. */
export interface FeishuChatSummary {
  /** Chat identity. */
  chatId: FeishuChatId
  /** `p2p` for a direct chat with the bot. */
  chatType: 'p2p' | 'group'
  /** Group name; null when unknown or for a direct chat. */
  name: string | null
  /** Session the chat drives; null when the chat is not bound. */
  sessionId: SessionId | null
}

/** A Session's Feishu connection, as the Web client shows it. */
export interface FeishuSessionStatus {
  /** Chat bound to the Session; null when no chat drives it. */
  chat: FeishuChatSummary | null
  /** Chats the Session can connect to, most recently active first. */
  chats: FeishuChatSummary[]
}

/** The chat to connect a Session to. */
export interface FeishuConnectRequest {
  /** A chat from {@link FeishuSessionStatus.chats}. */
  chatId: FeishuChatId
}
