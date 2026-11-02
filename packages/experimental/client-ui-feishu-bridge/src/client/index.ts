/** Browser entry for the experimental `feishuBridge` Remote contribution and the Session header Feishu chip. */
import type { Context } from '@deepseek-ai/cordis'
import feishuBridgeRemote from '@deepseek-ai/dsh-experimental-feishu-bridge/remote'
import { mountFeishuBridge } from './mount.ts'

export { inject } from './mount.ts'

/**
 * Activate the Feishu chip.
 * @param ctx - Client runtime.
 * @returns complete UI and Remote disposer.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  return await mountFeishuBridge(ctx, feishuBridgeRemote)
}
