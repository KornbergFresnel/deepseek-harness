/** The Remote namespace, dictionaries, and Feishu chip follow Client plugin disposal. */
import { Context, Service } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { FeishuChatId } from '@deepseek-ai/dsh-experimental-feishu-bridge/types'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { RemoteError, type TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { expect, it, vi } from 'vitest'
import { apply as hostApply } from '../src/index.ts'
import { FeishuChip, type FeishuChipInjected } from '../src/client/FeishuChip.tsx'
import { NS } from '../src/client/locales.ts'
import { ENTRY_ID, inject, mountFeishuBridge } from '../src/client/mount.ts'

const REMOTE: TypertRemoteContribution = { package: '@deepseek-ai/dsh-experimental-feishu-bridge', descriptors: [] }
const session = SessionId('s1')
const EMPTY = { chat: null, chats: [] }

function isInjected(value: object): value is FeishuChipInjected {
  return 'status' in value && 'connect' in value && 'disconnect' in value
}

async function fixture(fail = false) {
  const ctx = new Context(), unmount = vi.fn(async () => {})
  class Remote extends Service {
    constructor() { super(ctx, 'remote') }
    async $mount(contribution: TypertRemoteContribution) {
      expect(contribution).toBe(REMOTE)
      return unmount
    }
  }
  new Remote()
  const feishuBridge = {
    status: vi.fn(async (): Promise<unknown> => ({ ok: true, value: EMPTY })),
    connect: vi.fn(async (): Promise<unknown> => ({ ok: false, error: new RemoteError('gateway/internal', 'not available', {}) })),
    disconnect: vi.fn(async (): Promise<unknown> => ({ ok: true, value: EMPTY })),
  }
  ctx.provide('remote.feishuBridge', feishuBridge)
  ctx.provide('locale', new LocaleRuntime(ctx))
  await ctx.plugin(SlotRegistry)
  ctx.slots.register({ name: 'root', children: {
    'conversation.session.header.utilities': { kind: 'list', scope: 'session' },
  } } as never, () => null)
  if (fail) vi.spyOn(ctx.slots, 'inject').mockImplementationOnce(() => { throw new Error('slot failed') })
  return { ctx, unmount, feishuBridge }
}

it('registers the localized chip, maps Remote results, and withdraws everything on disposal', async () => {
  hostApply()
  const b = await fixture()
  try {
    const fiber = b.ctx.plugin({ inject: [...inject], apply: ctx => mountFeishuBridge(ctx, REMOTE) })
    await fiber
    const chip = b.ctx.slots.entries('conversation.session.header.utilities').find(item => item.component === FeishuChip)!
    expect(chip).toMatchObject({ locale: NS, options: { id: ENTRY_ID } })
    const actions = chip.inject!()
    expect(isInjected(actions)).toBe(true)
    if (!isInjected(actions)) return
    const chatId = 'oc_team' as FeishuChatId
    expect(await actions.status(session)).toEqual({ ok: true, value: EMPTY })
    expect(b.feishuBridge.status).toHaveBeenCalledWith(session)
    expect(await actions.connect(session, chatId)).toEqual({ ok: false, message: 'not available' })
    expect(b.feishuBridge.connect).toHaveBeenCalledWith(session, { chatId })
    expect(await actions.disconnect(session)).toEqual({ ok: true, value: EMPTY })
    expect(b.feishuBridge.disconnect).toHaveBeenCalledWith(session)

    await fiber.dispose()
    expect(b.ctx.slots.entries('conversation.session.header.utilities')).toHaveLength(0)
    expect(b.unmount).toHaveBeenCalledOnce()
  } finally { await b.ctx.fiber.dispose() }
})

it('rolls back the Remote contribution when the slot registration fails', async () => {
  const b = await fixture(true)
  try {
    await expect(mountFeishuBridge(b.ctx, REMOTE)).rejects.toThrow('slot failed')
    expect(b.unmount).toHaveBeenCalledOnce()
  } finally { await b.ctx.fiber.dispose() }
})
