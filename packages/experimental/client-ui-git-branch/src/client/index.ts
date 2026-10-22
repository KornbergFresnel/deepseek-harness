/** Browser entry for the experimental `gitBranch` Remote contribution and the New Session branch chip. */
import type { Context } from '@deepseek-ai/cordis'
import gitBranchRemote from '@deepseek-ai/dsh-experimental-git-branch/remote'
import { mountGitBranch } from './mount.ts'

export { inject } from './mount.ts'

/**
 * Activate the branch chip.
 * @param ctx - Client runtime.
 * @returns complete UI and Remote disposer.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  return await mountGitBranch(ctx, gitBranchRemote)
}
