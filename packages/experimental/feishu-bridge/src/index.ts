/**
 * Feishu (Lark) chat bridge for Workspace Sessions. A bound chat prompts its
 * Session, receives the Session's replies as rich cards, and answers its
 * permission requests and `ask_user_question` calls with card buttons and forms.
 * @module @deepseek-ai/dsh-experimental-feishu-bridge
 */

import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
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
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-subprocess'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type { AskUserQuestionAnswer, AskUserQuestionAnswerItem, AskUserQuestionItem, AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-workspace'
import {
  approvalCard, assistantCard, choiceField, noticeCard, optionValue, questionCard, textField, userPromptCard,
} from './cards.ts'
import type { ApprovalCardInput, ApprovalCardState, CardLocale, CardToolCall, QuestionCardState } from './cards.ts'
import { HELP, parseBridgeCommand } from './commands.ts'
import { LarkCliTransport } from './lark-cli.ts'
import { splitMarkdown, truncate } from './markdown.ts'
import type {
  FeishuCard, FeishuCardAction, FeishuChatBinding, FeishuChatId, FeishuInbound, FeishuInboundMessage, FeishuMessageId, FeishuOpenId,
  FeishuTransport,
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
  /** Absolute directory of the Workspace that Sessions created from Feishu join. */
  workspacePath: string
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

type ResolvedConfig = Required<Omit<Config, 'profile' | 'allowedChats' | 'agentPreset' | 'permissionPreset'>> & Config

/** Replaceable integrations for tests. */
export interface FeishuBridgeInternals {
  /** Feishu transport; defaults to {@link LarkCliTransport}. */
  readonly transport?: FeishuTransport
}

const bindingSchema = zod.object({ sessionId: zod.string(), boundAt: zod.string(), boundBy: zod.string() })

const bridgeDomain = defineDomain({
  name: 'feishu_bridge',
  version: 1,
  tables: {
    chats: domainTable<string, FeishuChatBinding>(bindingSchema),
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

type PendingInteraction = PendingApproval | PendingQuestion

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
 */
export class FeishuBridge extends Service {
  static inject = ['agents', 'sessionController', 'storageDomain', 'subprocess', 'workspaceRegistry']

  static Config: z<Config> = z.object({
    command: z.string().default('lark-cli'),
    profile: z.string(),
    allowedUsers: z.array(z.string()).required(),
    allowedChats: z.array(z.string()),
    workspacePath: z.string().required(),
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
    super(ctx, 'feishuBridge')
    this.config = config as ResolvedConfig
    if (this.config.allowedUsers.length === 0 || this.config.allowedUsers.some(id => !/^ou_\w+$/.test(id))) {
      throw new Error('feishu-bridge: allowedUsers must list at least one Feishu open_id (ou_…)')
    }
    if (this.config.allowedChats?.some(id => !/^oc_\w+$/.test(id)) === true) {
      throw new Error('feishu-bridge: allowedChats must list Feishu chat ids (oc_…)')
    }
    if (!isAbsolute(this.config.workspacePath)) throw new Error('feishu-bridge: workspacePath must be an absolute directory')
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
    }, 'feishu-bridge: load bindings, consume Feishu events; release pending prompts and close the domain on disposal')

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
   * @param operator - Feishu user who asked for the binding.
   * @throws when the Session is bound to another chat.
   */
  async bind(chatId: FeishuChatId, sessionId: SessionId, operator: FeishuOpenId): Promise<void> {
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
    const text = message.text.trim()
    if (text === '') return
    const command = parseBridgeCommand(text)
    if (command !== undefined) {
      await this.runBridgeCommand(message, command.name, command.argument)
      return
    }
    const sessionId = this.sessionOf(message.chatId) ?? await this.createSession(message.chatId, message.senderId)
    if (/^\/[a-z0-9_-]+(?:\s|$)/.test(text)) {
      await this.runSessionCommand(message, sessionId, text)
      return
    }
    await this.ctx.sessionController.prompt({
      requestId: brandString<SessionRequestId>(`feishu-${message.messageId}`),
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
    }, this.lifetime.signal)
  }

  /** Create a Session in the configured Workspace and bind the chat to it. */
  private async createSession(chatId: FeishuChatId, operator: FeishuOpenId): Promise<SessionId> {
    const presets = this.ctx.get('permissionPresets')
    if (this.config.permissionPreset !== undefined) {
      if (presets === undefined) throw new Error('feishu-bridge: permissionPreset is configured but no permission presets service is mounted')
      presets.resolve(this.config.permissionPreset)
    }
    const workspace = await this.ctx.workspaceRegistry.create(this.config.workspacePath)
    const request: SessionCreateRequest = {
      workspaceId: workspace.id,
      ...this.config.agentPreset === undefined ? {} : { agentPreset: this.config.agentPreset },
    }
    const { sessionId } = await this.ctx.sessionController.create(request)
    if (this.config.permissionPreset !== undefined && presets !== undefined) {
      presets.set((await this.agentOf(sessionId)).session, this.config.permissionPreset)
    }
    await this.bind(chatId, sessionId, operator)
    this.notify(chatId, this.text(`已创建新会话 \`${sessionId}\`。`, `Started Session \`${sessionId}\`.`))
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
      case 'new':
        await this.createSession(chatId, message.senderId)
        return
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
        this.notify(chatId, [
          `**Session** \`${bound}\``,
          `**${this.text('状态', 'Status')}** ${agent?.status ?? this.text('未加载', 'not loaded')}`,
          `**Workspace** \`${this.config.workspacePath}\``,
        ].join('\n'))
        return
      }
      /* v8 ignore next 2 -- parseBridgeCommand returns only the names above. */
      default:
        throw new Error(`unknown bridge command ${name}`)
    }
  }

  /** Run a Session slash command through the commands service and post its result. */
  private async runSessionCommand(message: FeishuInboundMessage, sessionId: SessionId, line: string): Promise<void> {
    const commands = this.ctx.get('commands')
    const execution = commands === undefined
      ? undefined
      : await commands.execute(await this.agentOf(sessionId), line, [], this.lifetime.signal)
    if (execution === undefined) {
      this.notify(message.chatId, this.text('未知命令。发送 `/help` 查看可用命令。', 'Unknown command. Send `/help` for the available commands.'), 'error')
      return
    }
    const { result } = execution
    this.notify(message.chatId, result.text ?? (result.kind === 'success' ? '✅' : '❌'), result.kind === 'error' ? 'error' : 'info')
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

  /** Settle a pending interaction when the bridge stops: approvals fail closed and questions abort. */
  private release(interaction: PendingInteraction): void {
    if (interaction.kind === 'approval') interaction.settle('unavailable')
    else interaction.abandon(new Error('feishu-bridge stopped before the question was answered'))
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
