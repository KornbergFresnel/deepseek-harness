/**
 * Feishu (Lark) chat bridge for Workspace Sessions. A bound chat prompts its
 * Session, receives the Session's replies as rich cards, and answers its
 * permission requests and `ask_user_question` calls with card buttons and forms.
 * @module @deepseek-ai/dsh-experimental-feishu-bridge
 */

import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionCreateRequest, SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {} from '@deepseek-ai/dsh-commands'
import { errorChain } from '@deepseek-ai/dsh-llm'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-permission-presets'
import { scopeChainOf } from '@deepseek-ai/dsh-scope'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-subprocess'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type { AskUserQuestionAnswer, AskUserQuestionAnswerItem, AskUserQuestionItem, AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import {
  approvalCard, assistantCard, choiceField, noticeCard, optionValue, questionCard, textField, userPromptCard,
  WORKSPACE_FIELD, workspaceCard,
} from './cards.ts'
import type {
  ApprovalCardInput, ApprovalCardState, CardLocale, CardToolCall, QuestionCardState, WorkspaceCardState, WorkspaceChoice,
} from './cards.ts'
import { HELP, parseBridgeCommand } from './commands.ts'
import { LarkCliTransport } from './lark-cli.ts'
import { splitMarkdown, truncate } from './markdown.ts'
import type {
  FeishuCard, FeishuCardAction, FeishuChatBinding, FeishuChatId, FeishuChatSummary, FeishuConnectRequest, FeishuInbound,
  FeishuInboundMessage, FeishuMessageId, FeishuOpenId, FeishuSeenChat, FeishuSessionStatus, FeishuTransport,
} from './types.ts'

export type * from './types.ts'
export type { CardLocale } from './cards.ts'
export { LarkCliTransport, parseCardActionEvent, parseMessageEvent } from './lark-cli.ts'
export { adaptMarkdown, splitMarkdown } from './markdown.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    feishuBridge: FeishuBridge
  }
}

/** lark-cli invocation, access control, Session placement, and forwarding policy. */
export interface Config {
  /** Executable name on PATH or absolute path of lark-cli. */
  command?: string
  /** lark-cli profile passed as `--profile`; omitted uses the active profile. */
  profile?: string
  /** Feishu open_ids (`ou_…`) allowed to prompt, run commands, approve, and answer; required and non-empty. */
  allowedUsers: string[]
  /** Chats (`oc_…`) the bridge serves; omitted or empty serves every chat an allowed user writes in. */
  allowedChats?: string[]
  /**
   * Absolute directory of the Workspace that Sessions created from Feishu join without asking. Omitted, a chat
   * without a Session gets a card to choose one of the registered Workspaces.
   */
  workspacePath?: string
  /** Agent preset for Sessions created from Feishu; omitted uses the deployment default. */
  agentPreset?: string
  /** Permission preset applied to Sessions created from Feishu; omitted keeps the deployment default. */
  permissionPreset?: string
  /** Language of the bridge's own card text. */
  locale?: CardLocale
  /** Show the model's reasoning in a collapsed panel above each reply. */
  forwardReasoning?: boolean
  /** Show the tool calls of each assistant message in a collapsed panel. */
  forwardToolCalls?: boolean
  /** Forward prompts that other clients, such as the Web UI, send to a bound Session. */
  forwardOtherPrompts?: boolean
  /** Maximum characters of Markdown in one card; longer replies are split. */
  maxCardChars?: number
  /** Maximum characters of one tool call's arguments shown in a card. */
  maxArgumentChars?: number
  /** Inbound message and callback ids remembered for duplicate-delivery detection. */
  deliveryMemory?: number
  /** Deadline in milliseconds for one lark-cli message API call. */
  timeoutMs?: number
  /** Subprocess termination grace in milliseconds. */
  graceMs?: number
  /** Maximum captured bytes per lark-cli output stream. */
  maxOutputBytes?: number
  /** Wait in milliseconds before restarting a lark-cli event consumer that exited. */
  restartDelayMs?: number
}

type ResolvedConfig = Required<Omit<Config, 'profile' | 'allowedChats' | 'workspacePath' | 'agentPreset' | 'permissionPreset'>> & Config

/** Replaceable integrations for tests. */
export interface FeishuBridgeInternals {
  /** Feishu transport; defaults to {@link LarkCliTransport}. */
  readonly transport?: FeishuTransport
}

const bindingSchema = zod.object({ sessionId: zod.string(), boundAt: zod.string(), boundBy: zod.string() })
const seenSchema = zod.object({ chatType: zod.enum(['p2p', 'group']), name: zod.string().nullable(), lastSeenAt: zod.string() })

const bridgeDomain = defineDomain({
  name: 'feishu_bridge',
  version: 1,
  tables: {
    chats: domainTable<string, FeishuChatBinding>(bindingSchema),
    seen: domainTable<string, FeishuSeenChat>(seenSchema),
  },
})

/** Positive integer fields validated at load. */
const POSITIVE_FIELDS = ['maxCardChars', 'maxArgumentChars', 'deliveryMemory', 'timeoutMs', 'graceMs', 'maxOutputBytes', 'restartDelayMs'] as const

/** A permission request waiting for a card button. */
interface PendingApproval {
  readonly kind: 'approval'
  readonly chatId: FeishuChatId
  readonly input: ApprovalCardInput
  readonly settle: (outcome: ApprovalOutcome, operator?: FeishuOpenId) => void
}

/** An `ask_user_question` call waiting for a card form. */
interface PendingQuestion {
  readonly kind: 'question'
  readonly chatId: FeishuChatId
  readonly agent: Agent
  readonly questions: readonly AskUserQuestionItem[]
  /** Set while the asking tool call still waits; cleared when its wait ended and the question continued. */
  waiting: ((answer: AskUserQuestionAnswer) => void) | undefined
  /** Ends the asking tool call's wait without an answer. */
  readonly abandon: (reason: unknown) => void
  /** Tool call to answer after the wait ended; undefined for a question that cannot continue. */
  readonly callId: ToolCallId | undefined
}

/** A message that arrived before its chat had a Session, delivered once one starts. */
interface StashedMessage {
  readonly messageId: FeishuMessageId
  readonly text: string
}

/** A workspace picker card waiting for its form. */
interface PendingWorkspace {
  readonly kind: 'workspace'
  readonly chatId: FeishuChatId
  readonly choices: readonly WorkspaceChoice[]
  /** The card as sent, re-rendered with an error after an empty submission. */
  readonly card: Extract<WorkspaceCardState, { kind: 'pending' }>
  readonly stashed: StashedMessage | undefined
}

type PendingInteraction = PendingApproval | PendingQuestion | PendingWorkspace

/** The Web client's `boundBy` marker. */
const WEB_BINDER = 'web'

/** Remembers the most recent delivery ids, forgetting the oldest beyond a fixed count. */
class DeliveryMemory {
  private readonly ids = new Set<string>()

  constructor(private readonly limit: number) {}

  /** @returns true when the id was already remembered; otherwise remembers it. */
  seen(id: string): boolean {
    if (this.ids.has(id)) return true
    this.ids.add(id)
    if (this.ids.size > this.limit) this.ids.delete(this.ids.values().next().value as string)
    return false
  }
}

/** A short stable Feishu idempotency key (`uuid`, at most 50 characters). */
function idempotencyKey(...parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 40)
}

/**
 * The Feishu bridge service. Chats bind to Sessions durably in the
 * `feishu_bridge` storage domain; one Session is bound to at most one chat.
 * The `feishuBridge` Remote namespace lets the Web client connect the open
 * Session to a chat in which an allowed user wrote to the bot.
 */
export class FeishuBridge extends TypertRemoteService {
  static inject = ['agents', 'sessionController', 'storageDomain', 'subprocess', 'workspaceRegistry']

  static Config: z<Config> = z.object({
    command: z.string().default('lark-cli'),
    profile: z.string(),
    allowedUsers: z.array(z.string()).required(),
    allowedChats: z.array(z.string()),
    workspacePath: z.string(),
    agentPreset: z.string(),
    permissionPreset: z.string(),
    locale: z.union(['zh', 'en'] as const).default('zh'),
    forwardReasoning: z.boolean().default(false),
    forwardToolCalls: z.boolean().default(true),
    forwardOtherPrompts: z.boolean().default(true),
    maxCardChars: z.natural().default(6000),
    maxArgumentChars: z.natural().default(1500),
    deliveryMemory: z.natural().default(1000),
    timeoutMs: z.natural().default(30_000),
    graceMs: z.natural().default(3_000),
    maxOutputBytes: z.natural().default(1_048_576),
    restartDelayMs: z.natural().default(5_000),
  })

  private readonly config: ResolvedConfig
  private readonly transport: FeishuTransport
  private readonly allowedUsers: ReadonlySet<string>
  private readonly allowedChats: ReadonlySet<string> | undefined
  private readonly lifetime = new AbortController()
  private readonly domain: Promise<Domain<typeof bridgeDomain>>
  private readonly bindings = new Map<FeishuChatId, FeishuChatBinding>()
  private readonly seen = new Map<FeishuChatId, FeishuSeenChat>()
  /** Chats whose name was read, or tried, in this process. */
  private readonly named = new Set<FeishuChatId>()
  private readonly queues = new Map<FeishuChatId, Promise<void>>()
  private readonly pending = new Map<FeishuMessageId, PendingInteraction>()
  private readonly toolCalls = new Map<SessionId, Map<string, CardToolCall>>()
  private readonly deliveries: DeliveryMemory

  /**
   * @param ctx - Host context with Agents, the Session Controller, storage domains, subprocesses, and the Workspace registry.
   * @param config - validated plugin config.
   * @param internals - replaceable transport for tests.
   */
  constructor(ctx: Context, config: Config, internals: FeishuBridgeInternals = {}) {
    super(ctx, 'feishuBridge', { namespace: 'feishuBridge' })
    this.config = config as ResolvedConfig
    if (this.config.allowedUsers.length === 0 || this.config.allowedUsers.some(id => !/^ou_\w+$/.test(id))) {
      throw new Error('feishu-bridge: allowedUsers must list at least one Feishu open_id (ou_…)')
    }
    if (this.config.allowedChats?.some(id => !/^oc_\w+$/.test(id)) === true) {
      throw new Error('feishu-bridge: allowedChats must list Feishu chat ids (oc_…)')
    }
    if (this.config.workspacePath !== undefined && !isAbsolute(this.config.workspacePath)) {
      throw new Error('feishu-bridge: workspacePath must be an absolute directory')
    }
    for (const field of POSITIVE_FIELDS) {
      if (!Number.isSafeInteger(this.config[field]) || this.config[field] <= 0) {
        throw new Error(`feishu-bridge: ${field} must be a positive integer`)
      }
    }
    this.allowedUsers = new Set(this.config.allowedUsers)
    this.allowedChats = this.config.allowedChats === undefined || this.config.allowedChats.length === 0
      ? undefined
      : new Set(this.config.allowedChats)
    this.deliveries = new DeliveryMemory(this.config.deliveryMemory)
    this.transport = internals.transport ?? new LarkCliTransport(ctx, {
      command: this.config.command,
      profile: this.config.profile,
      timeoutMs: this.config.timeoutMs,
      graceMs: this.config.graceMs,
      maxOutputBytes: this.config.maxOutputBytes,
      restartDelayMs: this.config.restartDelayMs,
    })

    this.domain = ctx.storageDomain.open(bridgeDomain)
    ctx.effect(() => {
      const consumption = this.domain.then((domain) => {
        for (const [chatId, binding] of domain.table('chats').entries()) this.bindings.set(brandString<FeishuChatId>(chatId), binding)
        for (const [chatId, chat] of domain.table('seen').entries()) this.seen.set(brandString<FeishuChatId>(chatId), chat)
        return this.transport.consume((event) => { this.receive(event) }, this.lifetime.signal)
      })
      const stopped = consumption.catch((error: unknown) => {
        ctx.logger.error(`feishu-bridge: stopped: ${errorChain(error)}`)
      })
      return async () => {
        this.lifetime.abort(new Error('feishu-bridge disposed'))
        for (const interaction of this.pending.values()) this.release(interaction)
        this.pending.clear()
        await stopped
        await Promise.allSettled([...this.queues.values()])
        const domain = await Promise.allSettled([this.domain])
        if (domain[0].status === 'fulfilled') await domain[0].value.close()
      }
    }, 'feishu-bridge: load bindings and chats, consume Feishu events; release pending prompts and close the domain on disposal')

    ctx.on('session/event', (session, event) => { this.forward(session, event) })
    // A bound chat owns its Session's prompts, so these answerers run before
    // the Web client's forwarded answerers and delegate every other Session.
    ctx.on('approval/request', (request, next) => this.answerApproval(request, next), { prepend: true })
    ctx.on('user-questions/request', (request, next) => this.answerQuestion(request, next), { prepend: true })
  }

  /**
   * The chat bound to a Session.
   * @param sessionId - Session identity.
   * @returns the chat, or undefined when no chat drives the Session.
   */
  chatOf(sessionId: SessionId): FeishuChatId | undefined {
    for (const [chatId, binding] of this.bindings) if (binding.sessionId === sessionId) return chatId
    return undefined
  }

  /**
   * The Session a chat drives.
   * @param chatId - Feishu chat.
   * @returns the bound Session, or undefined.
   */
  sessionOf(chatId: FeishuChatId): SessionId | undefined {
    const binding = this.bindings.get(chatId)
    return binding === undefined ? undefined : brandString<SessionId>(binding.sessionId)
  }

  /**
   * Bind a chat to a Session, replacing the chat's previous binding.
   * @param chatId - Feishu chat.
   * @param sessionId - Session the chat drives from now on.
   * @param operator - Feishu user who asked for the binding, or `web` for the Web client.
   * @throws when the Session is bound to another chat.
   */
  async bind(chatId: FeishuChatId, sessionId: SessionId, operator: FeishuOpenId | 'web'): Promise<void> {
    const owner = this.chatOf(sessionId)
    if (owner !== undefined && owner !== chatId) throw new Error(`Session ${sessionId} is bound to another chat; unbind it there first`)
    const binding: FeishuChatBinding = { sessionId, boundAt: new Date().toISOString(), boundBy: operator }
    await (await this.domain).table('chats').put(chatId, binding)
    this.bindings.set(chatId, binding)
  }

  /**
   * Remove a chat's binding.
   * @param chatId - Feishu chat.
   * @returns whether the chat was bound.
   */
  async unbind(chatId: FeishuChatId): Promise<boolean> {
    const removed = await (await this.domain).table('chats').delete(chatId)
    this.bindings.delete(chatId)
    return removed
  }

  /**
   * Read a Session's Feishu connection and the chats it can connect to.
   * @param agent - Session owner supplied by the Gateway.
   * @returns the bound chat and the served chats in which an allowed user wrote to the bot.
   */
  @Remote
  status(agent: Agent): FeishuSessionStatus {
    const chatId = this.chatOf(agent.session.id)
    const seenAt = (id: FeishuChatId): string => this.seen.get(id)?.lastSeenAt ?? ''
    const chats = [...new Set([...this.seen.keys(), ...this.bindings.keys()])]
      .filter(id => this.serves(id))
      .sort((left, right) => seenAt(right).localeCompare(seenAt(left)))
      .map(id => this.summary(id))
    return { chat: chatId === undefined ? null : this.summary(chatId), chats }
  }

  /**
   * Connect a Session to a chat from the Web client. The Session's previous chat and the chat's previous Session are
   * disconnected, and both chats are told.
   * @param agent - Session owner supplied by the Gateway.
   * @param request - the chat, one listed by {@link FeishuBridge.status}.
   * @returns the Session's connection afterwards.
   * @throws when the chat is not served or no allowed user wrote in it.
   */
  @Remote
  async connect(agent: Agent, request: FeishuConnectRequest): Promise<FeishuSessionStatus> {
    const sessionId = agent.session.id
    const chatId = request.chatId
    if (!this.serves(chatId) || (!this.seen.has(chatId) && !this.bindings.has(chatId))) {
      throw new Error(`Feishu chat ${chatId} is not available; an allowed user must first write to the bot there`)
    }
    const previous = this.chatOf(sessionId)
    if (previous === chatId) return this.status(agent)
    if (previous !== undefined) {
      await this.unbind(previous)
      this.notify(previous, this.text(
        `这个聊天已断开会话 \`${sessionId}\`：它在 Web 中改为连接另一个聊天。`,
        `This chat was disconnected from Session \`${sessionId}\`, which was connected to another chat in the Web client.`,
      ))
    }
    await this.bind(chatId, sessionId, WEB_BINDER)
    const workspace = this.workspaceOf(sessionId)
    this.notify(chatId, this.text(
      `已在 Web 中把这个聊天连接到会话 \`${sessionId}\`${workspace === undefined ? '' : `（工作区 **${workspace.title}** \`${workspace.path}\`）`}。`,
      `The Web client connected this chat to Session \`${sessionId}\`${workspace === undefined ? '' : ` in workspace **${workspace.title}** \`${workspace.path}\``}.`,
    ))
    return this.status(agent)
  }

  /**
   * Disconnect a Session from its chat from the Web client, and tell the chat.
   * @param agent - Session owner supplied by the Gateway.
   * @returns the Session's connection afterwards.
   */
  @Remote
  async disconnect(agent: Agent): Promise<FeishuSessionStatus> {
    const chatId = this.chatOf(agent.session.id)
    if (chatId !== undefined) {
      await this.unbind(chatId)
      this.notify(chatId, this.text(
        `已在 Web 中断开这个聊天和会话 \`${agent.session.id}\` 的连接。下一条消息会创建新会话。`,
        `The Web client disconnected this chat from Session \`${agent.session.id}\`. The next message starts a new Session.`,
      ))
    }
    return this.status(agent)
  }

  /** One chat as the Web client lists it. */
  private summary(chatId: FeishuChatId): FeishuChatSummary {
    const seen = this.seen.get(chatId)
    const binding = this.bindings.get(chatId)
    return {
      chatId,
      chatType: seen?.chatType ?? 'group',
      name: seen?.name ?? null,
      sessionId: binding === undefined ? null : brandString<SessionId>(binding.sessionId),
    }
  }

  /** The registered Workspace a Session belongs to. */
  private workspaceOf(sessionId: SessionId): Workspace | undefined {
    return this.ctx.workspaceRegistry.list().find(workspace => workspace.sessionIds.includes(sessionId))
  }

  /** Remember a chat an allowed user wrote in, reading an unnamed group's name once per process. */
  private async remember(message: FeishuInboundMessage): Promise<void> {
    const chatId = message.chatId
    const lastSeenAt = new Date().toISOString()
    let name = this.seen.get(chatId)?.name ?? null
    if (name === null && message.chatType === 'group' && !this.named.has(chatId)) {
      this.named.add(chatId)
      name = await this.transport.chatName(chatId, this.lifetime.signal) ?? null
    }
    const chat: FeishuSeenChat = { chatType: message.chatType, name, lastSeenAt }
    this.seen.set(chatId, chat)
    await (await this.domain).table('seen').put(chatId, chat)
  }

  /** Handle one inbound event; failures are reported to the chat or logged. */
  private receive(event: FeishuInbound): void {
    if (this.deliveries.seen(event.kind === 'message' ? event.messageId : event.eventId)) return
    const task = event.kind === 'message' ? this.receiveMessage(event) : this.receiveAction(event)
    task.catch((error: unknown) => {
      this.ctx.logger.warn(`feishu-bridge: ${event.kind} in chat ${event.chatId} failed: ${errorChain(error)}`)
      this.notify(event.chatId, `${this.text('处理失败', 'Failed')}: ${errorChain(error)}`, 'error')
    })
  }

  /** Whether a chat is served. */
  private serves(chatId: FeishuChatId): boolean {
    return this.allowedChats === undefined || this.allowedChats.has(chatId)
  }

  private async receiveMessage(message: FeishuInboundMessage): Promise<void> {
    if (message.senderType === 'bot' || !this.serves(message.chatId)) return
    if (!this.allowedUsers.has(message.senderId)) {
      this.ctx.logger.info(`feishu-bridge: ignored a message from ${message.senderId}, who is not in allowedUsers`)
      if (message.chatType === 'p2p') {
        this.notify(message.chatId, this.text(
          `你没有使用这个机器人的权限。请管理员把你的 open_id \`${message.senderId}\` 加入 allowedUsers。`,
          `You are not allowed to use this bot. Ask the administrator to add your open_id \`${message.senderId}\` to allowedUsers.`,
        ), 'error')
      }
      return
    }
    this.remember(message).catch((error: unknown) => {
      this.ctx.logger.warn(`feishu-bridge: could not remember chat ${message.chatId}: ${errorChain(error)}`)
    })
    const text = message.text.trim()
    if (text === '') return
    const command = parseBridgeCommand(text)
    if (command !== undefined) {
      await this.runBridgeCommand(message, command.name, command.argument)
      return
    }
    const bound = this.sessionOf(message.chatId)
    if (bound !== undefined) {
      await this.deliver(message.chatId, bound, { messageId: message.messageId, text })
      return
    }
    if (this.config.workspacePath === undefined) {
      await this.offerWorkspaces(message.chatId, { messageId: message.messageId, text })
      return
    }
    const workspace = await this.ctx.workspaceRegistry.create(this.config.workspacePath)
    const sessionId = await this.createSession(message.chatId, message.senderId, workspace)
    await this.deliver(message.chatId, sessionId, { messageId: message.messageId, text })
  }

  /** Send one chat message to a Session: a slash line runs as a Session command, anything else is a prompt. */
  private async deliver(chatId: FeishuChatId, sessionId: SessionId, message: StashedMessage): Promise<void> {
    if (/^\/[a-z0-9_-]+(?:\s|$)/.test(message.text)) {
      await this.runSessionCommand(chatId, sessionId, message.text)
      return
    }
    await this.ctx.sessionController.prompt({
      requestId: brandString<SessionRequestId>(`feishu-${message.messageId}`),
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: message.text }],
    }, this.lifetime.signal)
  }

  /**
   * Send a card to choose the Workspace of a new Session, or tell the chat how to add one when none is registered.
   * @param stashed - message to deliver once the Session starts.
   */
  private async offerWorkspaces(chatId: FeishuChatId, stashed?: StashedMessage): Promise<void> {
    const choices: WorkspaceChoice[] = this.ctx.workspaceRegistry.list().map(({ id, title, path }) => ({ id, title, path }))
    if (choices.length === 0) {
      this.notify(chatId, this.text(
        '还没有工作区。请先在 Web 中打开一个工作区，或发送 `/new <绝对路径>`。',
        'There is no workspace yet. Open one in the Web client first, or send `/new <absolute path>`.',
      ), 'error')
      return
    }
    const bound = this.sessionOf(chatId)
    const preferred = (bound === undefined ? undefined : this.workspaceOf(bound))?.path ?? this.config.workspacePath
    const selectedId = choices.find(choice => choice.path === preferred)?.id
    const card: PendingWorkspace['card'] = { kind: 'pending', ...selectedId === undefined ? {} : { selectedId }, stashed: stashed !== undefined }
    const messageId = await this.send(chatId, workspaceCard(this.config.locale, choices, card), randomUUID())
    this.pending.set(messageId, { kind: 'workspace', chatId, choices, card, stashed })
  }

  /** Create a Session in a Workspace and bind the chat to it. */
  private async createSession(chatId: FeishuChatId, operator: FeishuOpenId, workspace: Workspace): Promise<SessionId> {
    const presets = this.ctx.get('permissionPresets')
    if (this.config.permissionPreset !== undefined) {
      if (presets === undefined) throw new Error('feishu-bridge: permissionPreset is configured but no permission presets service is mounted')
      presets.resolve(this.config.permissionPreset)
    }
    const request: SessionCreateRequest = {
      workspaceId: workspace.id,
      ...this.config.agentPreset === undefined ? {} : { agentPreset: this.config.agentPreset },
    }
    const { sessionId } = await this.ctx.sessionController.create(request)
    if (this.config.permissionPreset !== undefined && presets !== undefined) {
      presets.set((await this.agentOf(sessionId)).session, this.config.permissionPreset)
    }
    await this.bind(chatId, sessionId, operator)
    this.notify(chatId, this.text(
      `已在工作区 **${workspace.title}** \`${workspace.path}\` 创建新会话 \`${sessionId}\`。`,
      `Started Session \`${sessionId}\` in workspace **${workspace.title}** \`${workspace.path}\`.`,
    ))
    return sessionId
  }

  /** Resolve or resume a Session's live Agent. */
  private async agentOf(sessionId: SessionId): Promise<Agent> {
    const result = await this.ctx.sessionController.resolveAgent(sessionId)
    if ('error' in result) throw result.error
    return result.agent
  }

  private async runBridgeCommand(message: FeishuInboundMessage, name: string, argument: string): Promise<void> {
    const chatId = message.chatId
    const bound = this.sessionOf(chatId)
    switch (name) {
      case 'help': {
        const commands = bound === undefined ? [] : this.ctx.get('commands')?.list(await this.agentOf(bound)) ?? []
        const extra = commands.map(command => `- \`/${command.name}\` ${command.description}`)
        this.notify(chatId, [HELP[this.config.locale], ...extra.length === 0 ? [] : ['', this.text('**会话命令**', '**Session commands**'), ...extra]].join('\n'))
        return
      }
      case 'new': {
        const path = argument.trim()
        // A bare /new asks, unless the configured directory is the only place a Session can start.
        const directory = path === '' ? this.config.workspacePath : path
        if (directory === undefined || (path === '' && this.ctx.workspaceRegistry.list().length > 0)) {
          await this.offerWorkspaces(chatId)
          return
        }
        if (!isAbsolute(directory)) {
          this.notify(chatId, this.text('用法：`/new` 或 `/new <绝对路径>`', 'Usage: `/new` or `/new <absolute path>`'), 'error')
          return
        }
        await this.createSession(chatId, message.senderId, await this.ctx.workspaceRegistry.create(directory))
        return
      }
      case 'bind': {
        const target = argument.trim()
        if (target === '') {
          this.notify(chatId, this.text('用法：`/bind <会话 ID>`', 'Usage: `/bind <session id>`'), 'error')
          return
        }
        const sessionId = brandString<SessionId>(target)
        await this.agentOf(sessionId)
        await this.bind(chatId, sessionId, message.senderId)
        this.notify(chatId, this.text(`已绑定会话 \`${sessionId}\`。`, `Bound Session \`${sessionId}\`.`))
        return
      }
      case 'unbind':
        this.notify(chatId, await this.unbind(chatId)
          ? this.text('已解除绑定。下一条消息会创建新会话。', 'Unbound. The next message starts a new Session.')
          : this.text('这个聊天没有绑定会话。', 'This chat is not bound to a Session.'))
        return
      case 'stop':
        if (bound === undefined) {
          this.notify(chatId, this.text('这个聊天没有绑定会话。', 'This chat is not bound to a Session.'), 'error')
          return
        }
        this.ctx.sessionController.cancel({ sessionId: bound })
        this.notify(chatId, this.text('已请求停止当前回合。', 'Asked the Session to stop its current turn.'))
        return
      case 'status': {
        if (bound === undefined) {
          this.notify(chatId, this.text('这个聊天没有绑定会话。发送任意消息即可开始。', 'This chat is not bound to a Session. Send any message to start one.'))
          return
        }
        const agent = this.ctx.agents.get(bound)
        const workspace = this.workspaceOf(bound)
        this.notify(chatId, [
          `**Session** \`${bound}\``,
          `**${this.text('状态', 'Status')}** ${agent?.status ?? this.text('未加载', 'not loaded')}`,
          ...workspace === undefined ? [] : [`**${this.text('工作区', 'Workspace')}** ${workspace.title} \`${workspace.path}\``],
        ].join('\n'))
        return
      }
      /* v8 ignore next 2 -- parseBridgeCommand returns only the names above. */
      default:
        throw new Error(`unknown bridge command ${name}`)
    }
  }

  /** Run a Session slash command through the commands service and post its result. */
  private async runSessionCommand(chatId: FeishuChatId, sessionId: SessionId, line: string): Promise<void> {
    const commands = this.ctx.get('commands')
    const execution = commands === undefined
      ? undefined
      : await commands.execute(await this.agentOf(sessionId), line, [], this.lifetime.signal)
    if (execution === undefined) {
      this.notify(chatId, this.text('未知命令。发送 `/help` 查看可用命令。', 'Unknown command. Send `/help` for the available commands.'), 'error')
      return
    }
    const { result } = execution
    this.notify(chatId, result.text ?? (result.kind === 'success' ? '✅' : '❌'), result.kind === 'error' ? 'error' : 'info')
  }

  private async receiveAction(action: FeishuCardAction): Promise<void> {
    const interaction = this.pending.get(action.messageId)
    if (interaction === undefined || interaction.chatId !== action.chatId) return
    if (!this.allowedUsers.has(action.operatorId)) {
      this.ctx.logger.info(`feishu-bridge: ignored a card action from ${action.operatorId}, who is not in allowedUsers`)
      return
    }
    if (interaction.kind === 'approval') {
      const value = action.value
      const decision = typeof value === 'object' && value !== null && 'decision' in value ? value.decision : undefined
      if (decision !== 'allow' && decision !== 'reject') return
      this.pending.delete(action.messageId)
      interaction.settle(decision === 'allow' ? 'allowed-once' : 'rejected', action.operatorId)
      return
    }
    if (interaction.kind === 'workspace') {
      await this.chooseWorkspace(action, interaction)
      return
    }
    if (action.formValue === undefined) return
    const answers = parseAnswers(interaction.questions, action.formValue)
    if (answers === undefined) {
      await this.updateCard(action.messageId, questionCard(this.config.locale, interaction.questions, {
        kind: interaction.waiting === undefined ? 'continued' : 'pending', error: true,
      }))
      return
    }
    this.pending.delete(action.messageId)
    const answer: AskUserQuestionAnswer = { answers }
    let state: QuestionCardState = { kind: 'answered', operator: action.operatorId, answers }
    if (interaction.waiting !== undefined) {
      interaction.waiting(answer)
    } else {
      const service = this.ctx.get('userQuestions')
      if (interaction.callId === undefined || service === undefined || !service.answer(interaction.agent, interaction.callId, answer)) {
        state = { kind: 'closed' }
      }
    }
    await this.updateCard(action.messageId, questionCard(this.config.locale, interaction.questions, state))
  }

  /** Start a Session in the Workspace a picker card submitted, then deliver the message that waited for it. */
  private async chooseWorkspace(action: FeishuCardAction, interaction: PendingWorkspace): Promise<void> {
    const chosen = action.formValue?.[WORKSPACE_FIELD]
    const workspace = typeof chosen === 'string' && interaction.choices.some(choice => choice.id === chosen)
      ? this.ctx.workspaceRegistry.list().find(item => item.id === chosen)
      : undefined
    if (workspace === undefined) {
      await this.updateCard(action.messageId, workspaceCard(this.config.locale, interaction.choices, { ...interaction.card, error: true }))
      return
    }
    this.pending.delete(action.messageId)
    const sessionId = await this.createSession(action.chatId, action.operatorId, workspace)
    await this.updateCard(action.messageId, workspaceCard(this.config.locale, interaction.choices, {
      kind: 'started', workspace: { id: workspace.id, title: workspace.title, path: workspace.path }, sessionId, operator: action.operatorId,
    }))
    if (interaction.stashed !== undefined) await this.deliver(action.chatId, sessionId, interaction.stashed)
  }

  /** The bound chat of an Agent or its nearest bound ancestor. */
  private chatForAgent(agent: Agent): FeishuChatId | undefined {
    for (const key of scopeChainOf(agent)) {
      if (!('session' in key) || typeof key.session !== 'object' || key.session === null || !('id' in key.session)) continue
      const chatId = this.chatOf(brandString<SessionId>(String(key.session.id)))
      if (chatId !== undefined) return chatId
    }
    return undefined
  }

  private async answerApproval(request: ApprovalRequest, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome> {
    const chatId = this.chatForAgent(request.agent)
    if (chatId === undefined || this.lifetime.signal.aborted) return next()
    const call = request.callId === undefined ? undefined : this.toolCalls.get(request.agent.session.id)?.get(request.callId)
    const input: ApprovalCardInput = {
      toolName: request.toolName,
      ...request.reason === undefined ? {} : { reason: request.reason },
      ...call === undefined ? {} : { arguments: call.arguments },
      argumentLimit: this.config.maxArgumentChars,
    }
    let messageId: FeishuMessageId
    try {
      messageId = await this.send(chatId, approvalCard(this.config.locale, input, { kind: 'pending' }), randomUUID())
    } catch (error: unknown) {
      this.ctx.logger.warn(`feishu-bridge: permission request could not reach chat ${chatId}; delegating: ${errorChain(error)}`)
      return next()
    }
    const decided = Promise.withResolvers<ApprovalOutcome>()
    // Each path deletes the pending entry and removes the abort listener before settling, so a request settles once.
    const settle = (outcome: ApprovalOutcome, operator?: FeishuOpenId): void => {
      this.pending.delete(messageId)
      request.signal?.removeEventListener('abort', onAbort)
      decided.resolve(outcome)
      const state: ApprovalCardState = operator !== undefined && (outcome === 'allowed-once' || outcome === 'rejected')
        ? { kind: outcome === 'allowed-once' ? 'allowed' : 'rejected', operator }
        : { kind: 'cancelled' }
      void this.updateCard(messageId, approvalCard(this.config.locale, input, state))
    }
    const onAbort = (): void => { settle('cancelled') }
    this.pending.set(messageId, { kind: 'approval', chatId, input, settle })
    request.signal?.addEventListener('abort', onAbort, { once: true })
    if (request.signal?.aborted === true) onAbort()
    return decided.promise
  }

  private async answerQuestion(
    request: AskUserQuestionRequest,
    next: () => Promise<AskUserQuestionAnswer>,
  ): Promise<AskUserQuestionAnswer> {
    const agent = request.agent
    const chatId = agent === undefined ? undefined : this.chatForAgent(agent)
    if (agent === undefined || chatId === undefined || this.lifetime.signal.aborted) return next()
    const questions = request.questions
    let messageId: FeishuMessageId
    try {
      messageId = await this.send(chatId, questionCard(this.config.locale, questions, { kind: 'pending' }), randomUUID())
    } catch (error: unknown) {
      this.ctx.logger.warn(`feishu-bridge: question could not reach chat ${chatId}; delegating: ${errorChain(error)}`)
      return next()
    }
    const answered = Promise.withResolvers<AskUserQuestionAnswer>()
    const interaction: PendingQuestion = {
      kind: 'question',
      chatId,
      agent,
      questions,
      callId: request.wait?.callId,
      waiting: (answer) => {
        interaction.waiting = undefined
        request.signal?.removeEventListener('abort', onAbort)
        answered.resolve(answer)
      },
      abandon: (reason) => {
        if (interaction.waiting === undefined) return
        interaction.waiting = undefined
        request.signal?.removeEventListener('abort', onAbort)
        answered.reject(reason)
      },
    }
    const onAbort = (): void => {
      const reason: unknown = request.signal?.reason
      const continues = interaction.callId !== undefined && !this.lifetime.signal.aborted
        && typeof reason === 'object' && reason !== null && 'code' in reason && reason.code === 'ASK_TIMED_OUT'
      if (!continues) this.pending.delete(messageId)
      void this.updateCard(messageId, questionCard(this.config.locale, questions, { kind: continues ? 'continued' : 'closed' }))
      interaction.abandon(reason)
    }
    this.pending.set(messageId, interaction)
    request.signal?.addEventListener('abort', onAbort, { once: true })
    if (request.signal?.aborted === true) onAbort()
    return answered.promise
  }

  /** Settle a pending interaction when the bridge stops: approvals fail closed, questions abort, and pickers lapse. */
  private release(interaction: PendingInteraction): void {
    switch (interaction.kind) {
      case 'approval':
        interaction.settle('unavailable')
        return
      case 'question':
        interaction.abandon(new Error('feishu-bridge stopped before the question was answered'))
        return
      case 'workspace':
        return
      /* v8 ignore next 2 -- closed union. */
      default:
        assertNever(interaction, 'pending interaction')
    }
  }

  /** Forward one committed event of a bound Session to its chat. */
  private forward(session: Session, event: SessionEvent): void {
    const chatId = this.chatOf(session.id)
    if (chatId === undefined) return
    switch (event.type) {
      case 'assistant/message': {
        const calls = this.toolCalls.get(session.id) ?? new Map<string, CardToolCall>()
        this.toolCalls.set(session.id, calls)
        const text: string[] = []
        const reasoning: string[] = []
        const toolCalls: CardToolCall[] = []
        for (const block of event.data.message.content) {
          if (block.type === 'text') text.push(block.text)
          else if (block.type === 'reasoning') reasoning.push(block.text)
          else if (block.type === 'tool-call') {
            const call = { name: block.name, arguments: block.arguments }
            calls.set(block.id, call)
            toolCalls.push(call)
          }
        }
        this.sendReply(chatId, session.id, event.seq, text.join('\n\n'), reasoning.join('\n\n'), toolCalls)
        return
      }
      case 'user/message': {
        const source = event.data.source
        if (!this.config.forwardOtherPrompts || source.kind !== 'user') return
        if ('rpcId' in source && typeof source.rpcId === 'string' && source.rpcId.startsWith('feishu-')) return
        const text = event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n\n')
        if (text.trim() !== '') this.post(chatId, userPromptCard(this.config.locale, text), idempotencyKey(session.id, String(event.seq)))
        return
      }
      case 'turn/end': {
        this.toolCalls.delete(session.id)
        const reason = event.data.reason
        const notice = reason.kind === 'error'
          ? this.text(`本回合失败：${reason.error.message}`, `The turn failed: ${reason.error.message}`)
          : reason.kind === 'aborted'
            ? this.text('本回合已停止。', 'The turn was stopped.')
            : reason.kind === 'max-tokens'
              ? this.text('回复达到了输出 token 上限。', 'The reply reached its output-token limit.')
              : undefined
        if (notice !== undefined) {
          this.post(chatId, noticeCard(notice, reason.kind === 'error' ? 'error' : 'info'), idempotencyKey(session.id, String(event.seq)))
        }
        return
      }
      default:
    }
  }

  /** Send one assistant message as one or more cards. */
  private sendReply(
    chatId: FeishuChatId, sessionId: SessionId, seq: number, text: string, reasoning: string, toolCalls: readonly CardToolCall[],
  ): void {
    const chunks = splitMarkdown(text, this.config.maxCardChars)
    chunks.forEach((chunk, index) => {
      const card = assistantCard(this.config.locale, {
        text: chunk,
        ...index === 0 && this.config.forwardReasoning ? { reasoning: truncate(reasoning, this.config.maxCardChars) } : {},
        ...index === chunks.length - 1 && this.config.forwardToolCalls ? { toolCalls } : {},
        ...chunks.length > 1 ? { part: { index: index + 1, total: chunks.length } } : {},
        argumentLimit: this.config.maxArgumentChars,
      })
      if (card !== undefined) this.post(chatId, card, idempotencyKey(sessionId, String(seq), String(index)))
    })
  }

  /** Localized bridge text. */
  private text(zh: string, en: string): string {
    return this.config.locale === 'zh' ? zh : en
  }

  /** Post a notice card; failures are logged. */
  private notify(chatId: FeishuChatId, text: string, tone: 'info' | 'error' = 'info'): void {
    this.post(chatId, noticeCard(text, tone), randomUUID())
  }

  /** Send a card in chat order without waiting; failures are logged. */
  private post(chatId: FeishuChatId, card: FeishuCard, key: string): void {
    this.send(chatId, card, key).catch((error: unknown) => {
      this.ctx.logger.warn(`feishu-bridge: card to chat ${chatId} failed: ${errorChain(error)}`)
    })
  }

  /** Send a card after every earlier card of the same chat. */
  private send(chatId: FeishuChatId, card: FeishuCard, key: string): Promise<FeishuMessageId> {
    const previous = this.queues.get(chatId) ?? Promise.resolve()
    const sent = previous.then(() => this.transport.sendCard(chatId, card, key, this.lifetime.signal))
    const tail = sent.then(() => undefined, () => undefined)
    this.queues.set(chatId, tail)
    void tail.then(() => {
      if (this.queues.get(chatId) === tail) this.queues.delete(chatId)
    })
    return sent
  }

  /** Replace a card's content; failures are logged. */
  private async updateCard(messageId: FeishuMessageId, card: FeishuCard): Promise<void> {
    try {
      await this.transport.updateCard(messageId, card, this.lifetime.signal)
    } catch (error: unknown) {
      if (!this.lifetime.signal.aborted) this.ctx.logger.warn(`feishu-bridge: card ${messageId} update failed: ${errorChain(error)}`)
    }
  }
}

/**
 * Read one submitted question form.
 * @param questions - the asked questions, in field order.
 * @param form - submitted form values keyed by field name.
 * @returns one answer per question, or undefined when a question has neither a choice nor text.
 */
export function parseAnswers(
  questions: readonly AskUserQuestionItem[],
  form: Readonly<Record<string, unknown>>,
): AskUserQuestionAnswerItem[] | undefined {
  const answers: AskUserQuestionAnswerItem[] = []
  for (const [index, question] of questions.entries()) {
    const options = question.options ?? []
    const picked = form[choiceField(index)]
    const values = Array.isArray(picked) ? picked : picked === undefined || picked === '' ? [] : [picked]
    const selected = values.flatMap((value) => {
      const option = options.find((_option, optionIndex) => optionValue(optionIndex) === value)
      return option === undefined ? [] : [option.label]
    })
    const raw = form[textField(index)]
    const custom = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined
    if (selected.length === 0 && custom === undefined) return undefined
    answers.push(question.multiSelect === true || custom === undefined
      ? { id: question.id, selected, ...custom === undefined ? {} : { custom } }
      : { id: question.id, selected: [], custom })
  }
  return answers
}

export default FeishuBridge
