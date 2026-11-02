/** Lifecycle of the `feishuBridge` Remote contribution and the Session header Feishu chip. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-experimental-feishu-bridge/remote'
import type { FeishuChatId } from '@deepseek-ai/dsh-experimental-feishu-bridge/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { FeishuChip, type FeishuChipInjected, type Loaded } from './FeishuChip.tsx'
import { en, NS, zh, type FeishuBridgeKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Session header Feishu chip copy. */
    'feishu.bridge': FeishuBridgeKey
  }
}

/** Entry id of the chip in `conversation.session.header.utilities`. */
export const ENTRY_ID = 'feishu-bridge'

/** Services the chip registration reads. */
export const inject = ['remote', 'slots', 'locale']

function loaded<T>(result: RemoteResult<T>): Loaded<T> {
  return result.ok ? { ok: true, value: result.value } : { ok: false, message: result.error.message }
}

function registerUi(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'feishu-bridge: dictionaries')
  const injected: FeishuChipInjected = {
    status: async (sessionId: SessionId) => loaded(await ctx.remote.feishuBridge.status(sessionId)),
    connect: async (sessionId: SessionId, chatId: FeishuChatId) => loaded(await ctx.remote.feishuBridge.connect(sessionId, { chatId })),
    disconnect: async (sessionId: SessionId) => loaded(await ctx.remote.feishuBridge.disconnect(sessionId)),
  }
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities', id: ENTRY_ID, locale: NS, inject: () => injected,
  }, FeishuChip))
}

/**
 * Mount the experimental `feishuBridge` namespace and the Feishu chip that reads it.
 * @param ctx - Client runtime owning the Remote, dictionaries, and slots.
 * @param contribution - generated `feishuBridge` Remote definitions.
 * @returns disposer joining UI and Remote withdrawal.
 */
export async function mountFeishuBridge(ctx: Context, contribution: TypertRemoteContribution): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(contribution)
  const ui = ctx.inject(['remote.feishuBridge', 'slots', 'locale'], registerUi)
  try { await ui } catch (error) { await ui.dispose(); await disposeRemote(); throw error }
  return async () => { await ui.dispose(); await disposeRemote() }
}
