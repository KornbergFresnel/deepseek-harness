/** Lifecycle of the `gitBranch` Remote contribution and the New Session branch chip. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-experimental-git-branch/remote'
import type { GitSwitchRequest } from '@deepseek-ai/dsh-experimental-git-branch/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { BranchChip, type BranchChipInjected, type Loaded } from './BranchChip.tsx'
import { en, NS, zh, type GitBranchKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** New Session branch chip copy. */
    'git.branch': GitBranchKey
  }
}

/** Entry id of the chip in `conversation.hero.context`. */
export const ENTRY_ID = 'git-branch'

/** Services the chip registration reads. */
export const inject = ['remote', 'slots', 'locale']

function loaded<T>(result: RemoteResult<T>): Loaded<T> {
  return result.ok ? { ok: true, value: result.value } : { ok: false, message: result.error.message }
}

function registerUi(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'git-branch: dictionaries')
  const injected: BranchChipInjected = {
    status: async (sessionId: SessionId) => loaded(await ctx.remote.gitBranch.status(sessionId)),
    switchBranch: async (sessionId: SessionId, request: GitSwitchRequest) =>
      loaded(await ctx.remote.gitBranch.switchBranch(sessionId, request)),
  }
  ctx.slots.inject('conversation.hero.context', () => ctx.slots.register({
    name: 'conversation.hero.context', id: ENTRY_ID, locale: NS, inject: () => injected,
  }, BranchChip))
}

/**
 * Mount the experimental `gitBranch` namespace and the branch chip that reads it.
 * @param ctx - Client runtime owning the Remote, dictionaries, and slots.
 * @param contribution - generated `gitBranch` Remote definitions.
 * @returns disposer joining UI and Remote withdrawal.
 */
export async function mountGitBranch(ctx: Context, contribution: TypertRemoteContribution): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(contribution)
  const ui = ctx.inject(['remote.gitBranch', 'slots', 'locale'], registerUi)
  try { await ui } catch (error) { await ui.dispose(); await disposeRemote(); throw error }
  return async () => { await ui.dispose(); await disposeRemote() }
}
