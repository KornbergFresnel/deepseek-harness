import { rm } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { LarkCliTransport, parseCardActionEvent, parseMessageEvent } from '../src/lark-cli.ts'
import type { LarkCliOptions } from '../src/lark-cli.ts'
import type { FeishuChatId, FeishuInbound, FeishuMessageId } from '../src/types.ts'
import { fakeLarkCli } from './fake-lark-cli.ts'
import type { FakeLarkCli } from './fake-lark-cli.ts'

const cleanup: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true })
})

const CHAT = brandString<FeishuChatId>('oc_chat')

async function boot(options: Partial<LarkCliOptions> = {}): Promise<{ transport: LarkCliTransport; fake: FakeLarkCli; ctx: Context }> {
  const fake = await fakeLarkCli()
  cleanup.push(fake.root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LocalSubprocessRuntime)
  const transport = new LarkCliTransport(ctx, {
    command: fake.command, profile: undefined, timeoutMs: 10_000, graceMs: 500, maxOutputBytes: 65_536, restartDelayMs: 20, ...options,
  })
  return { transport, fake, ctx }
}

describe('event parsing', () => {
  it('reads flattened message events and rejects ones without identities', () => {
    expect(parseMessageEvent({
      message_id: 'om_1', chat_id: 'oc_1', chat_type: 'group', sender_id: 'ou_1', sender_type: 'user', message_type: 'post', content: 'hi',
    })).toEqual({
      kind: 'message', messageId: 'om_1', chatId: 'oc_1', chatType: 'group', senderId: 'ou_1', senderType: 'user', messageType: 'post', text: 'hi',
    })
    expect(parseMessageEvent({ id: 'om_2', chat_id: 'oc_1', sender_id: 'ou_1', sender_type: 'bot' })).toMatchObject({
      messageId: 'om_2', chatType: 'p2p', senderType: 'bot', messageType: 'text', text: '',
    })
    expect(parseMessageEvent({ chat_id: 'oc_1' })).toBeUndefined()
    expect(parseMessageEvent('text')).toBeUndefined()
  })

  it('reads card callbacks with JSON values and forms', () => {
    expect(parseCardActionEvent({
      event_id: 'ev1', message_id: 'om_1', chat_id: 'oc_1', operator_id: 'ou_1', action_value: '{"dsh":"approval","decision":"allow"}', form_value: '',
    })).toEqual({
      kind: 'card-action', eventId: 'ev1', messageId: 'om_1', chatId: 'oc_1', operatorId: 'ou_1',
      value: { dsh: 'approval', decision: 'allow' }, formValue: undefined,
    })
    expect(parseCardActionEvent({
      event_id: 'ev2', message_id: 'om_1', chat_id: 'oc_1', operator_id: 'ou_1', action_value: 'plain', form_value: '{"q0":"o1"}',
    })).toMatchObject({ value: 'plain', formValue: { q0: 'o1' } })
    expect(parseCardActionEvent({
      event_id: 'ev3', message_id: 'om_1', chat_id: 'oc_1', operator_id: 'ou_1', action_value: { a: 1 }, form_value: '{}',
    })).toMatchObject({ value: { a: 1 }, formValue: undefined })
    expect(parseCardActionEvent({ event_id: 'ev4' })).toBeUndefined()
    expect(parseCardActionEvent(null)).toBeUndefined()
  })
})

describe('lark-cli transport', () => {
  it('sends cards and updates them through the message API with bodies on stdin', async () => {
    const { transport, fake } = await boot({ profile: 'work' })
    const card = { schema: '2.0', body: { elements: [] } }
    expect(await transport.sendCard(CHAT, card, 'k'.repeat(60))).toBe('om_1')
    await transport.updateCard(brandString<FeishuMessageId>('om_1'), card)
    const [send, update] = await fake.calls()
    expect(send?.argv).toEqual([
      '--profile', 'work', 'api', 'POST', '/open-apis/im/v1/messages', '--params', '{"receive_id_type":"chat_id"}', '--data', '-', '--as', 'bot',
    ])
    expect(send?.body).toEqual({ receive_id: 'oc_chat', msg_type: 'interactive', content: JSON.stringify(card), uuid: 'k'.repeat(50) })
    expect(update?.argv).toEqual(['--profile', 'work', 'api', 'PATCH', '/open-apis/im/v1/messages/om_1', '--data', '-', '--as', 'bot'])
    expect(update?.body).toEqual({ content: JSON.stringify(card) })
    await expect(transport.updateCard(brandString<FeishuMessageId>('om_1/../x'), card)).rejects.toThrow('invalid Feishu message id')
  })

  it('reports failed, non-JSON, and unsuccessful API output', async () => {
    const { transport, fake } = await boot()
    const card = { schema: '2.0' }
    await fake.control('envelope-api', '{"ok":true,"data":{}}')
    await expect(transport.sendCard(CHAT, card, 'k')).rejects.toThrow('returned no message_id')
    await fake.control('envelope-api', '{"ok":true,"data":null}')
    await expect(transport.sendCard(CHAT, card, 'k')).rejects.toThrow('returned no message_id: null')
    await fake.control('envelope-api', '{"ok":false}')
    await expect(transport.sendCard(CHAT, card, 'k')).rejects.toThrow('no success envelope')
    await fake.control('garbage-api')
    await expect(transport.sendCard(CHAT, card, 'k')).rejects.toThrow('non-JSON output')
    await fake.control('fail-api')
    await expect(transport.sendCard(CHAT, card, 'k')).rejects.toThrow(/api POST \/open-apis\/im\/v1\/messages failed \(1\): .*denied/)
    await rm(`${fake.root}/fail-api`)
    await fake.control('fail-api-quiet')
    await expect(transport.sendCard(CHAT, card, 'k')).rejects.toThrow('failed (2): quota exceeded')
  })

  it('streams both event kinds, skips unusable lines, restarts a stopped consumer, and stops on abort', async () => {
    const { transport, fake, ctx } = await boot()
    const warn = vi.spyOn(ctx.logger, 'warn')
    await fake.control('events-im.message.receive_v1.ndjson', [
      JSON.stringify({ message_id: 'om_1', chat_id: 'oc_1', sender_id: 'ou_1', content: 'hello' }),
      '',
      'not json',
      JSON.stringify({ chat_id: 'oc_1' }),
    ].join('\n') + '\n')
    await fake.control('events-card.action.trigger.ndjson', `${JSON.stringify({ event_id: 'e', message_id: 'om_2', chat_id: 'oc_1', operator_id: 'ou_1' })}\n`)
    await fake.control('exit-card.action.trigger')
    const events: FeishuInbound[] = []
    const controller = new AbortController()
    const done = transport.consume(event => events.push(event), controller.signal)
    await vi.waitFor(async () => {
      const consumers = (await fake.calls()).filter(call => call.argv.includes('card.action.trigger'))
      expect(consumers).toHaveLength(2)
      expect(events.filter(event => event.kind === 'card-action')).toHaveLength(2)
    }, { timeout: 10_000 })
    expect(events.filter(event => event.kind === 'message')).toEqual([expect.objectContaining({ messageId: 'om_1', text: 'hello' })])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('non-JSON line: not json'))
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/card\.action\.trigger stopped: exited \(4\): .*network.*restarting in 20 ms/))
    controller.abort()
    await done
    expect((await fake.calls())[0]?.argv).toEqual(['event', 'consume', expect.any(String), '--as', 'bot'])
  })

  it('stops a consumer waiting to restart', async () => {
    const { transport, fake } = await boot({ restartDelayMs: 60_000, command: 'definitely-not-lark-cli' })
    void fake
    const controller = new AbortController()
    const done = transport.consume(() => undefined, controller.signal)
    await new Promise(resolve => setTimeout(resolve, 50))
    controller.abort()
    await done
  })
})
