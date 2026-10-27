import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-questions'
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import FeishuBridge from '../src/index.ts'
import type { Config, FeishuCard, FeishuChatId, FeishuInbound, FeishuMessageId, FeishuOpenId, FeishuTransport } from '../src/index.ts'

const cleanup: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  createdSessions = 0
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true })
})

const ALICE = 'ou_alice'
let createdSessions = 0
const MALLORY = 'ou_mallory'
const CHAT = 'oc_team'

/** In-memory Feishu: records sent and updated cards and delivers inbound events. */
class FakeTransport implements FeishuTransport {
  readonly sent: { chatId: string; card: FeishuCard; key: string; messageId: FeishuMessageId }[] = []
  readonly updates: { messageId: string; card: FeishuCard }[] = []
  failSends = false
  failUpdates = false
  private deliver: ((event: FeishuInbound) => void) | undefined

  consume(onEvent: (event: FeishuInbound) => void, signal: AbortSignal): Promise<void> {
    this.deliver = onEvent
    return new Promise((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
  }

  sendCard(chatId: FeishuChatId, card: FeishuCard, key: string): Promise<FeishuMessageId> {
    if (this.failSends) return Promise.reject(new Error('send refused'))
    const messageId = brandString<FeishuMessageId>(`om_${String(this.sent.length + 1)}`)
    this.sent.push({ chatId, card, key, messageId })
    return Promise.resolve(messageId)
  }

  updateCard(messageId: FeishuMessageId, card: FeishuCard): Promise<void> {
    if (this.failUpdates) return Promise.reject(new Error('update refused'))
    this.updates.push({ messageId, card })
    return Promise.resolve()
  }

  get ready(): boolean {
    return this.deliver !== undefined
  }

  message(text: string, options: { id?: string; sender?: string; chat?: string; chatType?: 'p2p' | 'group'; senderType?: 'user' | 'bot' } = {}): void {
    this.deliver?.({
      kind: 'message',
      messageId: brandString<FeishuMessageId>(options.id ?? `om_in_${String(Math.random()).slice(2)}`),
      chatId: brandString<FeishuChatId>(options.chat ?? CHAT),
      chatType: options.chatType ?? 'group',
      senderId: brandString<FeishuOpenId>(options.sender ?? ALICE),
      senderType: options.senderType ?? 'user',
      messageType: 'text',
      text,
    })
  }

  action(messageId: string, value: unknown, options: { operator?: string; form?: Record<string, unknown>; chat?: string } = {}): void {
    this.deliver?.({
      kind: 'card-action',
      eventId: `ev_${String(Math.random()).slice(2)}`,
      messageId: brandString<FeishuMessageId>(messageId),
      chatId: brandString<FeishuChatId>(options.chat ?? CHAT),
      operatorId: brandString<FeishuOpenId>(options.operator ?? ALICE),
      value,
      formValue: options.form,
    })
  }

  /** Text of every markdown element in a sent card. */
  texts(index: number): string {
    return JSON.stringify(this.sent[index]?.card)
  }
}

/** A Session and Agent stand-in carrying only what the bridge reads. */
function fakeAgent(id: string, status = 'idle'): Agent {
  const session = { id: brandString<SessionId>(id), header: { id } }
  return { id, session, status } as never
}

interface Harness {
  ctx: Context
  transport: FakeTransport
  root: string
  agents: Map<string, Agent>
  calls: {
    created: unknown[]
    prompts: { requestId: string; sessionId: string; content: unknown }[]
    cancels: unknown[]
    presets: [string, string][]
    executed: string[]
    answered: unknown[]
  }
}

interface BootOptions {
  root?: string
  transport?: FakeTransport
  services?: boolean
}

async function boot(config: Partial<Config> = {}, options: BootOptions = {}): Promise<Harness> {
  const root = options.root ?? await realpath(await mkdtemp(join(tmpdir(), 'dsh-feishu-')))
  if (options.root === undefined) cleanup.push(root)
  const transport = options.transport ?? new FakeTransport()
  const agents = new Map<string, Agent>()
  const calls: Harness['calls'] = { created: [], prompts: [], cancels: [], presets: [], executed: [], answered: [] }
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  ctx.provide('subprocess', {} as never)
  ctx.provide('agents', { get: (id: string) => agents.get(id) } as never)
  ctx.provide('workspaceRegistry', { create: (path: string) => Promise.resolve({ id: 'ws-1', path }) } as never)
  ctx.provide('sessionController', {
    create(request: unknown) {
      calls.created.push(request)
      createdSessions += 1
      const id = `session-${String(createdSessions)}`
      agents.set(id, fakeAgent(id))
      return Promise.resolve({ sessionId: id })
    },
    prompt(request: Harness['calls']['prompts'][number]) {
      calls.prompts.push(request)
      return Promise.resolve({ accepted: true })
    },
    cancel(request: unknown) {
      calls.cancels.push(request)
      return { accepted: true }
    },
    resolveAgent(sessionId: string) {
      const agent = agents.get(sessionId)
      return Promise.resolve(agent === undefined ? { error: new Error(`session "${sessionId}" not found`) } : { agent })
    },
  } as never)
  if (options.services !== false) {
    ctx.provide('permissionPresets', {
      resolve: (name: string) => {
        if (name === 'nope') throw new Error('permission: unknown preset "nope"')
        return {}
      },
      set: (session: Session, name: string) => { calls.presets.push([session.id, name]) },
    } as never)
    ctx.provide('commands', {
      list: () => [{ name: 'compact', description: 'Compact the conversation' }],
      execute: (_agent: Agent, line: string) => {
        calls.executed.push(line)
        if (line.startsWith('/compact')) return Promise.resolve({ commandId: 'c', result: { kind: 'success', text: 'compacted' } })
        if (line.startsWith('/fail')) return Promise.resolve({ commandId: 'c', result: { kind: 'error', text: 'failed' } })
        if (line.startsWith('/quiet')) return Promise.resolve({ commandId: 'c', result: { kind: 'success' } })
        if (line.startsWith('/broken')) return Promise.resolve({ commandId: 'c', result: { kind: 'error' } })
        return Promise.resolve(undefined)
      },
    } as never)
    ctx.provide('userQuestions', {
      answer: (_agent: Agent, callId: string, answer: unknown) => {
        calls.answered.push({ callId, answer })
        return callId !== 'call-gone'
      },
    } as never)
  }
  class TestBridge extends FeishuBridge {
    constructor(scope: Context, value: Config) {
      super(scope, value, { transport })
    }
  }
  await ctx.plugin(TestBridge, { allowedUsers: [ALICE], workspacePath: '/work/rlh', locale: 'en', ...config })
  await vi.waitFor(() => { expect(transport.ready).toBe(true) })
  return { ctx, transport, root, agents, calls }
}

/** Emit one committed Session event to the bridge. */
let nextSeq = 100

function emitEvent(ctx: Context, agent: Agent, event: Omit<SessionEvent, 'seq' | 'time'> & { seq?: number }): void {
  nextSeq += 1
  ctx.emit(scopeTarget(agent.session, undefined), 'session/event', agent.session, { time: 0, ...event, seq: SessionSeq(event.seq ?? nextSeq) } as never)
}

/** Ask for approval on behalf of an Agent. */
function askApproval(ctx: Context, agent: Agent, options: { signal?: AbortSignal; callId?: string } = {}): Promise<ApprovalOutcome> {
  return ctx.waterfall(scopeTarget(agent, agent), 'approval/request', {
    agent,
    toolName: 'bash',
    reason: 'needs network',
    ...options.callId === undefined ? {} : { callId: ToolCallId(options.callId) },
    ...options.signal === undefined ? {} : { signal: options.signal },
  }, () => Promise.resolve('unavailable' as const))
}

/** Ask questions on behalf of an Agent. */
function askQuestions(
  ctx: Context, agent: Agent | undefined, questions: AskUserQuestionItem[], options: { signal?: AbortSignal; callId?: string } = {},
): Promise<AskUserQuestionAnswer> {
  const request = {
    questions,
    ...agent === undefined ? {} : { agent },
    ...options.signal === undefined ? {} : { signal: options.signal },
    ...options.callId === undefined ? {} : { wait: { callId: ToolCallId(options.callId), timed: true } },
  }
  const next = (): Promise<AskUserQuestionAnswer> => Promise.reject(new Error('no answerer'))
  return agent === undefined
    ? ctx.waterfall('user-questions/request', request, next)
    : ctx.waterfall(scopeTarget(agent, agent), 'user-questions/request', request, next)
}

/** Start a bound Session by sending a first message. */
async function bound(harness: Harness): Promise<Agent> {
  harness.transport.message('hello', { id: 'om_first' })
  await vi.waitFor(() => { expect(harness.calls.prompts).toHaveLength(1) })
  return harness.agents.get(harness.calls.prompts[0]!.sessionId)!
}

describe('configuration', () => {
  it('fails loud on missing users, malformed ids, a relative workspace, and non-positive limits', async () => {
    await expect(boot({ allowedUsers: [] })).rejects.toThrow('allowedUsers must list at least one Feishu open_id')
    await expect(boot({ allowedUsers: ['alice'] })).rejects.toThrow('allowedUsers must list')
    await expect(boot({ allowedChats: ['team'] })).rejects.toThrow('allowedChats must list Feishu chat ids')
    await expect(boot({ workspacePath: 'rlh' })).rejects.toThrow('workspacePath must be an absolute directory')
    await expect(boot({ maxCardChars: 0 })).rejects.toThrow('maxCardChars must be a positive integer')
  })
})

describe('chat to Session', () => {
  it('starts and binds a Session on the first message and prompts it once per delivery', async () => {
    const harness = await boot({ agentPreset: 'research', permissionPreset: 'ask' })
    harness.transport.message('train the policy', { id: 'om_a' })
    harness.transport.message('train the policy', { id: 'om_a' })
    await vi.waitFor(() => { expect(harness.calls.prompts).toHaveLength(1) })
    expect(harness.calls.created).toEqual([{ workspaceId: 'ws-1', agentPreset: 'research' }])
    expect(harness.calls.presets).toEqual([['session-1', 'ask']])
    expect(harness.calls.prompts[0]).toEqual({
      requestId: 'feishu-om_a', sessionId: 'session-1', mode: 'queue', content: [{ type: 'text', text: 'train the policy' }],
    })
    expect(harness.ctx.feishuBridge.sessionOf(brandString<FeishuChatId>(CHAT))).toBe('session-1')
    expect(harness.ctx.feishuBridge.chatOf(brandString<SessionId>('session-1'))).toBe(CHAT)
    await vi.waitFor(() => { expect(harness.transport.texts(0)).toContain('Started Session `session-1`') })
    harness.transport.message('again', { id: 'om_b' })
    await vi.waitFor(() => { expect(harness.calls.prompts).toHaveLength(2) })
    expect(harness.calls.created).toHaveLength(1)
  })

  it('ignores bots, other chats, blank text, and unknown users, telling a direct-message stranger their open_id', async () => {
    const harness = await boot({ allowedChats: [CHAT] })
    harness.transport.message('hi', { senderType: 'bot' })
    harness.transport.message('hi', { chat: 'oc_other' })
    harness.transport.message('   ')
    harness.transport.message('hi', { sender: MALLORY })
    harness.transport.message('hi', { sender: MALLORY, chatType: 'p2p' })
    await vi.waitFor(() => { expect(harness.transport.sent).toHaveLength(1) })
    expect(harness.transport.texts(0)).toContain('`ou_mallory`')
    expect(harness.calls.prompts).toEqual([])
    const zh = await boot({ locale: 'zh' })
    zh.transport.message('hi', { sender: MALLORY, chatType: 'p2p' })
    await vi.waitFor(() => { expect(zh.transport.texts(0)).toContain('没有使用这个机器人的权限') })
  })

  it('reports Session failures in the chat', async () => {
    const harness = await boot({ permissionPreset: 'nope' })
    harness.transport.message('hi')
    await vi.waitFor(() => { expect(harness.transport.texts(0)).toContain('Failed: permission: unknown preset') })
    const missing = await boot({ permissionPreset: 'ask' }, { services: false })
    missing.transport.message('hi')
    await vi.waitFor(() => { expect(missing.transport.texts(0)).toContain('no permission presets service is mounted') })
  })

  it('keeps bindings across restarts and runs the bridge commands', async () => {
    const first = await boot()
    await bound(first)
    contexts.splice(contexts.indexOf(first.ctx), 1)
    await first.ctx.fiber.dispose()

    const harness = await boot({}, { root: first.root })
    harness.agents.set('session-1', fakeAgent('session-1', 'running'))
    expect(harness.ctx.feishuBridge.sessionOf(brandString<FeishuChatId>(CHAT))).toBe('session-1')
    const reply = async (text: string): Promise<string> => {
      const before = harness.transport.sent.length
      harness.transport.message(text)
      await vi.waitFor(() => { expect(harness.transport.sent.length).toBeGreaterThan(before) })
      return harness.transport.texts(harness.transport.sent.length - 1)
    }
    expect(await reply('/status')).toContain('running')
    expect(await reply('/help')).toContain('Compact the conversation')
    expect(await reply('/stop')).toContain('stop its current turn')
    expect(harness.calls.cancels).toEqual([{ sessionId: 'session-1' }])
    expect(await reply('/compact')).toContain('compacted')
    expect(await reply('/fail now')).toContain("color='red'>failed")
    expect(await reply('/quiet')).toContain('✅')
    expect(await reply('/broken')).toContain('❌')
    expect(await reply('/missing')).toContain('Unknown command')
    expect(await reply('/bind')).toContain('Usage')
    expect(await reply('/bind session-9')).toContain('Failed: session \\"session-9\\" not found')
    expect(await reply('/unbind')).toContain('Unbound')
    expect(await reply('/unbind')).toContain('not bound')
    expect(await reply('/status')).toContain('not bound')
    expect(await reply('/stop')).toContain('not bound')
    expect(await reply('/help')).not.toContain('Session commands')
    expect(await reply('/bind session-1')).toContain('Bound Session `session-1`')
    harness.agents.delete('session-1')
    expect(await reply('/status')).toContain('not loaded')
    expect(await reply('/new')).toContain('Started Session `session-2`')
    harness.transport.message('/bind session-2', { chat: 'oc_other' })
    await vi.waitFor(() => { expect(harness.transport.texts(harness.transport.sent.length - 1)).toContain('bound to another chat') })
  })

  it('rejects Session commands when no commands service is mounted', async () => {
    const harness = await boot({}, { services: false })
    await bound(harness)
    harness.transport.message('/compact')
    await vi.waitFor(() => { expect(harness.transport.texts(harness.transport.sent.length - 1)).toContain('Unknown command') })
    harness.transport.message('/help')
    await vi.waitFor(() => { expect(harness.transport.texts(harness.transport.sent.length - 1)).toContain('Feishu bridge commands') })
  })
})

describe('Session to chat', () => {
  it('forwards replies, prompts from other clients, and turn failures in order', async () => {
    const harness = await boot({ forwardReasoning: true, maxCardChars: 20 })
    const agent = await bound(harness)
    await vi.waitFor(() => { expect(harness.transport.sent).toHaveLength(1) })
    emitEvent(harness.ctx, agent, {
      type: 'assistant/message',
      seq: 5,
      data: {
        turn: 1, step: 1, stream: [],
        message: {
          id: 'm1', role: 'assistant', source: { kind: 'model' },
          content: [
            { type: 'reasoning', text: 'plan' },
            { type: 'text', text: 'first paragraph is long' },
            { type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{"command":"ls"}' },
            { type: 'image', attachment: {} },
          ],
        },
      },
    } as never)
    emitEvent(harness.ctx, agent, { type: 'user/message', data: createUserMessage({ content: [{ type: 'text', text: 'from web' }], source: { kind: 'user', rpcId: 'web-1' } as never }) } as never)
    emitEvent(harness.ctx, agent, { type: 'user/message', data: createUserMessage({ content: [{ type: 'text', text: 'echo' }], source: { kind: 'user', rpcId: 'feishu-om_first' } as never }) } as never)
    emitEvent(harness.ctx, agent, { type: 'user/message', data: createUserMessage({ content: [{ type: 'text', text: 'note' }], source: { kind: 'webhook' } as never }) } as never)
    emitEvent(harness.ctx, agent, { type: 'user/message', data: createUserMessage({ content: [{ type: 'image', attachment: {} } as never], source: { kind: 'user' } }) } as never)
    emitEvent(harness.ctx, agent, { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { message: 'rate limited', code: 'RATE' } } } } as never)
    emitEvent(harness.ctx, agent, { type: 'turn/end', data: { turn: 2, reason: { kind: 'aborted', reason: {} } } } as never)
    emitEvent(harness.ctx, agent, { type: 'turn/end', data: { turn: 3, reason: { kind: 'max-tokens' } } } as never)
    emitEvent(harness.ctx, agent, { type: 'turn/end', data: { turn: 4, reason: { kind: 'completed' } } } as never)
    emitEvent(harness.ctx, agent, { type: 'step/start', data: { turn: 5, step: 1 } } as never)
    emitEvent(harness.ctx, fakeAgent('unbound'), { type: 'turn/end', data: { turn: 1, reason: { kind: 'max-tokens' } } } as never)
    await vi.waitFor(() => { expect(harness.transport.sent).toHaveLength(7) })
    const cards = harness.transport.sent.slice(1).map(sent => JSON.stringify(sent.card))
    expect(cards[0]).toContain('Thinking')
    expect(cards[0]).toContain('Part 1/2')
    expect(cards[1]).toContain('Tool calls (1)')
    expect(cards[2]).toContain('from web')
    expect(cards[3]).toContain('The turn failed: rate limited')
    expect(cards[4]).toContain('The turn was stopped.')
    expect(harness.transport.texts(6)).toContain('output-token limit')
    expect(new Set(harness.transport.sent.map(sent => sent.key)).size).toBe(7)
  })

  it('omits tool calls and other prompts when configured, and logs failed sends', async () => {
    const harness = await boot({ forwardToolCalls: false, forwardOtherPrompts: false, locale: 'zh' })
    const agent = await bound(harness)
    await vi.waitFor(() => { expect(harness.transport.sent).toHaveLength(1) })
    const warn = vi.spyOn(harness.ctx.logger, 'warn')
    emitEvent(harness.ctx, agent, {
      type: 'assistant/message',
      data: { turn: 1, step: 1, stream: [], message: { id: 'm', role: 'assistant', source: { kind: 'model' }, content: [{ type: 'tool-call', id: 'c', name: 'bash', arguments: '{}' }] } },
    } as never)
    emitEvent(harness.ctx, agent, { type: 'user/message', data: createUserMessage({ content: [{ type: 'text', text: 'web' }], source: { kind: 'user' } }) } as never)
    emitEvent(harness.ctx, agent, { type: 'turn/end', data: { turn: 1, reason: { kind: 'max-tokens' } } } as never)
    await vi.waitFor(() => { expect(harness.transport.sent).toHaveLength(2) })
    expect(harness.transport.texts(1)).toContain('输出 token 上限')
    harness.transport.failSends = true
    emitEvent(harness.ctx, agent, { type: 'turn/end', data: { turn: 2, reason: { kind: 'aborted', reason: {} } } } as never)
    await vi.waitFor(() => { expect(warn).toHaveBeenCalledWith(expect.stringContaining('send refused')) })
  })
})

describe('permission requests', () => {
  it('asks the bound chat with the tool arguments and applies an allowed user\'s decision', async () => {
    const harness = await boot()
    const agent = await bound(harness)
    emitEvent(harness.ctx, agent, {
      type: 'assistant/message',
      data: { turn: 1, step: 1, stream: [], message: { id: 'm', role: 'assistant', source: { kind: 'model' }, content: [{ type: 'tool-call', id: 'call-7', name: 'bash', arguments: '{"command":"curl example.com"}' }] } },
    } as never)
    const outcome = askApproval(harness.ctx, agent, { callId: 'call-7' })
    await vi.waitFor(() => { expect(harness.transport.sent.some(sent => JSON.stringify(sent.card).includes('Permission request'))).toBe(true) })
    const card = harness.transport.sent.find(sent => JSON.stringify(sent.card).includes('Permission request'))!
    expect(JSON.stringify(card.card)).toContain('curl example.com')
    harness.transport.action(card.messageId, { dsh: 'approval', decision: 'allow' }, { operator: MALLORY })
    harness.transport.action(card.messageId, { dsh: 'approval', decision: 'allow' }, { chat: 'oc_other' })
    harness.transport.action(card.messageId, { dsh: 'approval', decision: 'maybe' })
    harness.transport.action(card.messageId, 'allow')
    harness.transport.action('om_unknown', { dsh: 'approval', decision: 'allow' })
    harness.transport.action(card.messageId, { dsh: 'approval', decision: 'allow' })
    expect(await outcome).toBe('allowed-once')
    await vi.waitFor(() => { expect(harness.transport.updates).toHaveLength(1) })
    expect(JSON.stringify(harness.transport.updates[0]?.card)).toContain('Allowed by')
    expect(JSON.stringify(harness.transport.updates[0]?.card)).toContain('<at id=ou_alice></at>')

    const rejected = askApproval(harness.ctx, agent)
    await vi.waitFor(() => { expect(harness.transport.sent.filter(sent => JSON.stringify(sent.card).includes('Permission request'))).toHaveLength(2) })
    harness.transport.action(harness.transport.sent.at(-1)!.messageId, { dsh: 'approval', decision: 'reject' })
    expect(await rejected).toBe('rejected')
  })

  it('withdraws on cancellation, delegates other Sessions and failed sends, and fails closed on shutdown', async () => {
    const harness = await boot()
    const agent = await bound(harness)
    expect(await askApproval(harness.ctx, fakeAgent('elsewhere'))).toBe('unavailable')

    const controller = new AbortController()
    const withdrawn = askApproval(harness.ctx, agent, { signal: controller.signal })
    await vi.waitFor(() => { expect(harness.transport.sent.some(sent => JSON.stringify(sent.card).includes('Permission request'))).toBe(true) })
    controller.abort()
    expect(await withdrawn).toBe('cancelled')
    await vi.waitFor(() => { expect(JSON.stringify(harness.transport.updates.at(-1)?.card)).toContain('withdrew') })

    expect(await askApproval(harness.ctx, agent, { signal: AbortSignal.abort() })).toBe('cancelled')

    harness.transport.failSends = true
    expect(await askApproval(harness.ctx, agent)).toBe('unavailable')
    harness.transport.failSends = false

    const child = fakeAgent('child')
    const { bindScopeParent } = await import('@deepseek-ai/dsh-scope')
    bindScopeParent(child, { note: 'not an agent' })
    expect(await askApproval(harness.ctx, child)).toBe('unavailable')
    const grandchild = fakeAgent('grandchild')
    bindScopeParent(grandchild, agent)
    harness.transport.failUpdates = true
    const pending = askApproval(harness.ctx, grandchild)
    await vi.waitFor(() => { expect(harness.transport.sent.filter(sent => JSON.stringify(sent.card).includes('Permission request')).length).toBeGreaterThan(2) })
    const warn = vi.spyOn(harness.ctx.logger, 'warn')
    contexts.splice(contexts.indexOf(harness.ctx), 1)
    await harness.ctx.fiber.dispose()
    expect(await pending).toBe('unavailable')
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('update refused'))
  })
})

describe('questions', () => {
  const QUESTIONS: AskUserQuestionItem[] = [
    { id: 'gpus', question: 'How many GPUs?', options: [{ label: '8' }, { label: '16' }] },
  ]

  it('answers from the form and asks again when a question is left blank', async () => {
    const harness = await boot()
    const agent = await bound(harness)
    const answer = askQuestions(harness.ctx, agent, QUESTIONS)
    await vi.waitFor(() => { expect(harness.transport.sent.some(sent => JSON.stringify(sent.card).includes('has a question'))).toBe(true) })
    const card = harness.transport.sent.at(-1)!
    harness.transport.action(card.messageId, undefined)
    harness.transport.action(card.messageId, undefined, { form: { q0: '' } })
    await vi.waitFor(() => { expect(JSON.stringify(harness.transport.updates.at(-1)?.card)).toContain('Answer every question') })
    harness.transport.action(card.messageId, undefined, { form: { q0: 'o1' } })
    expect(await answer).toEqual({ answers: [{ id: 'gpus', selected: ['16'] }] })
    await vi.waitFor(() => { expect(JSON.stringify(harness.transport.updates.at(-1)?.card)).toContain('Answered by') })
  })

  it('keeps a timed-out question answerable and closes withdrawn ones', async () => {
    const harness = await boot()
    const agent = await bound(harness)
    const timeout = new AbortController()
    const timed = askQuestions(harness.ctx, agent, QUESTIONS, { signal: timeout.signal, callId: 'call-q' })
    await vi.waitFor(() => { expect(harness.transport.sent.some(sent => JSON.stringify(sent.card).includes('has a question'))).toBe(true) })
    const card = harness.transport.sent.at(-1)!
    timeout.abort(Object.assign(new Error('timed out'), { code: 'ASK_TIMED_OUT' }))
    await expect(timed).rejects.toThrow('timed out')
    await vi.waitFor(() => { expect(JSON.stringify(harness.transport.updates.at(-1)?.card)).toContain('stopped waiting') })
    harness.transport.action(card.messageId, undefined, { form: {} })
    harness.transport.action(card.messageId, undefined, { form: { q0: '' } })
    await vi.waitFor(() => { expect(harness.transport.updates.length).toBeGreaterThan(1) })
    harness.transport.action(card.messageId, undefined, { form: { q0_text: '32' } })
    await vi.waitFor(() => { expect(harness.calls.answered).toEqual([{ callId: 'call-q', answer: { answers: [{ id: 'gpus', selected: [], custom: '32' }] } }]) })
    await vi.waitFor(() => { expect(JSON.stringify(harness.transport.updates.at(-1)?.card)).toContain('Answered by') })

    const gone = new AbortController()
    const late = askQuestions(harness.ctx, agent, QUESTIONS, { signal: gone.signal, callId: 'call-gone' })
    await vi.waitFor(() => { expect(harness.transport.sent.filter(sent => JSON.stringify(sent.card).includes('has a question'))).toHaveLength(2) })
    gone.abort(Object.assign(new Error('timed out'), { code: 'ASK_TIMED_OUT' }))
    await expect(late).rejects.toThrow()
    harness.transport.action(harness.transport.sent.at(-1)!.messageId, undefined, { form: { q0: 'o0' } })
    await vi.waitFor(() => { expect(JSON.stringify(harness.transport.updates.at(-1)?.card)).toContain('This question is closed.') })

    const cancelled = new AbortController()
    const withdrawn = askQuestions(harness.ctx, agent, QUESTIONS, { signal: cancelled.signal })
    await vi.waitFor(() => { expect(harness.transport.sent.filter(sent => JSON.stringify(sent.card).includes('has a question'))).toHaveLength(3) })
    cancelled.abort(new Error('cancelled'))
    await expect(withdrawn).rejects.toThrow('cancelled')
    await vi.waitFor(() => { expect(JSON.stringify(harness.transport.updates.at(-1)?.card)).toContain('This question is closed.') })
    await expect(askQuestions(harness.ctx, agent, QUESTIONS, { signal: AbortSignal.abort(new Error('early')) })).rejects.toThrow('early')
  })

  it('delegates unbound and agentless questions and failed sends, and aborts waiting questions on shutdown', async () => {
    const harness = await boot({}, { services: false })
    const agent = await bound(harness)
    await expect(askQuestions(harness.ctx, undefined, QUESTIONS)).rejects.toThrow('no answerer')
    await expect(askQuestions(harness.ctx, fakeAgent('elsewhere'), QUESTIONS)).rejects.toThrow('no answerer')
    harness.transport.failSends = true
    await expect(askQuestions(harness.ctx, agent, QUESTIONS)).rejects.toThrow('no answerer')
    harness.transport.failSends = false

    const timeout = new AbortController()
    const timed = askQuestions(harness.ctx, agent, QUESTIONS, { signal: timeout.signal, callId: 'call-q' })
    await vi.waitFor(() => { expect(harness.transport.sent.some(sent => JSON.stringify(sent.card).includes('has a question'))).toBe(true) })
    const continued = harness.transport.sent.at(-1)!
    timeout.abort(Object.assign(new Error('timed out'), { code: 'ASK_TIMED_OUT' }))
    await expect(timed).rejects.toThrow()
    harness.transport.action(continued.messageId, undefined, { form: { q0: 'o0' } })
    await vi.waitFor(() => { expect(JSON.stringify(harness.transport.updates.at(-1)?.card)).toContain('This question is closed.') })

    const waiting = askQuestions(harness.ctx, agent, QUESTIONS)
    await vi.waitFor(() => { expect(harness.transport.sent.filter(sent => JSON.stringify(sent.card).includes('has a question'))).toHaveLength(2) })
    contexts.splice(contexts.indexOf(harness.ctx), 1)
    await harness.ctx.fiber.dispose()
    await expect(waiting).rejects.toThrow('stopped before the question was answered')
    await expect(askApproval(harness.ctx, agent)).resolves.toBe('unavailable')
  })
})

describe('lifecycle', () => {
  it('forgets the oldest delivery beyond the configured memory', async () => {
    const harness = await boot({ deliveryMemory: 1 })
    for (const id of ['om_a', 'om_b', 'om_a']) {
      harness.transport.message('hi', { id })
      await vi.waitFor(() => { expect(harness.calls.prompts.at(-1)?.requestId).toBe(`feishu-${id}`) })
    }
    expect(harness.calls.prompts).toHaveLength(3)
  })

  it('logs a failed start and a failed card update, and asks without a reason', async () => {
    const harness = await boot()
    const agent = await bound(harness)
    const outcome = harness.ctx.waterfall(scopeTarget(agent, agent), 'approval/request', { agent, toolName: 'bash' }, () => Promise.resolve('unavailable' as const))
    await vi.waitFor(() => { expect(harness.transport.sent.some(sent => JSON.stringify(sent.card).includes('Permission request'))).toBe(true) })
    const warn = vi.spyOn(harness.ctx.logger, 'warn')
    harness.transport.failUpdates = true
    harness.transport.action(harness.transport.sent.at(-1)!.messageId, { dsh: 'approval', decision: 'reject' })
    expect(await outcome).toBe('rejected')
    await vi.waitFor(() => { expect(warn).toHaveBeenCalledWith(expect.stringContaining('update refused')) })

    const ctx = new Context()
    contexts.push(ctx)
    const error = vi.spyOn(ctx.logger, 'error')
    for (const name of ['agents', 'sessionController', 'workspaceRegistry']) ctx.provide(name, {} as never)
    ctx.provide('storageDomain', { open: () => Promise.reject(new Error('disk full')) } as never)
    // A pending executable lookup that settles only on abort stands in for lark-cli.
    ctx.provide('subprocess', {
      resolveExecutable: (_command: string, _env: unknown, signal: AbortSignal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => { reject(signal.reason as Error) }, { once: true })
      }),
    } as never)
    await ctx.plugin(FeishuBridge, { allowedUsers: [ALICE], workspacePath: '/work/rlh' })
    await vi.waitFor(() => { expect(error).toHaveBeenCalledWith(expect.stringContaining('feishu-bridge: stopped: disk full')) })
  })

  it('stops the default lark-cli consumers on disposal', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-feishu-')))
    cleanup.push(root)
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root })
    await ctx.plugin(StorageDomain, { backend: 'json' })
    for (const name of ['agents', 'sessionController', 'workspaceRegistry']) ctx.provide(name, {} as never)
    const lookups: string[] = []
    ctx.provide('subprocess', {
      resolveExecutable: (command: string, _env: unknown, signal: AbortSignal) => {
        lookups.push(command)
        return new Promise((_resolve, reject) => { signal.addEventListener('abort', () => { reject(signal.reason as Error) }, { once: true }) })
      },
    } as never)
    await ctx.plugin(FeishuBridge, { allowedUsers: [ALICE], workspacePath: '/work/rlh', command: '/opt/lark-cli', profile: 'work' })
    await vi.waitFor(() => { expect(lookups).toEqual(['/opt/lark-cli', '/opt/lark-cli']) })
    const warn = vi.spyOn(ctx.logger, 'warn')
    contexts.splice(contexts.indexOf(ctx), 1)
    await ctx.fiber.dispose()
    expect(warn).not.toHaveBeenCalled()
  })

  it('abandons a continued question on shutdown without rejecting it again', async () => {
    const harness = await boot()
    const agent = await bound(harness)
    const timeout = new AbortController()
    const timed = askQuestions(harness.ctx, agent, [{ id: 'q', question: 'Name?' }], { signal: timeout.signal, callId: 'call-q' })
    await vi.waitFor(() => { expect(harness.transport.sent.some(sent => JSON.stringify(sent.card).includes('has a question'))).toBe(true) })
    timeout.abort(Object.assign(new Error('timed out'), { code: 'ASK_TIMED_OUT' }))
    await expect(timed).rejects.toThrow('timed out')
    contexts.splice(contexts.indexOf(harness.ctx), 1)
    await harness.ctx.fiber.dispose()
    expect(harness.calls.answered).toEqual([])
  })
})
