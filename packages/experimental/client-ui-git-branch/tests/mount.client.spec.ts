/** The Remote namespace, dictionaries, and branch chip follow Client plugin disposal. */
import { Context, Service } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { RemoteError, type TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { expect, it, vi } from 'vitest'
import { apply as hostApply } from '../src/index.ts'
import { BranchChip, type BranchChipInjected } from '../src/client/BranchChip.tsx'
import { NS } from '../src/client/locales.ts'
import { ENTRY_ID, inject, mountGitBranch } from '../src/client/mount.ts'

const REMOTE: TypertRemoteContribution = { package: '@deepseek-ai/dsh-experimental-git-branch', descriptors: [] }
const session = SessionId('s1')

function isInjected(value: object): value is BranchChipInjected {
  return 'status' in value && 'switchBranch' in value
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
  const gitBranch = {
    status: vi.fn(async (): Promise<unknown> => ({ ok: true, value: { kind: 'none', cwd: '/tmp' } })),
    switchBranch: vi.fn(async (): Promise<unknown> => ({ ok: false, error: new RemoteError('gateway/internal', 'refused', {}) })),
  }
  ctx.provide('remote.gitBranch', gitBranch)
  ctx.provide('locale', new LocaleRuntime(ctx))
  await ctx.plugin(SlotRegistry)
  ctx.slots.register({ name: 'root', children: {
    'conversation.hero.context': { kind: 'list', scope: 'session' },
  } } as never, () => null)
  if (fail) vi.spyOn(ctx.slots, 'inject').mockImplementationOnce(() => { throw new Error('slot failed') })
  return { ctx, unmount, gitBranch }
}

it('registers the localized chip, maps Remote results, and withdraws everything on disposal', async () => {
  hostApply()
  const b = await fixture()
  try {
    const fiber = b.ctx.plugin({ inject: [...inject], apply: ctx => mountGitBranch(ctx, REMOTE) })
    await fiber
    const chip = b.ctx.slots.entries('conversation.hero.context').find(item => item.component === BranchChip)!
    expect(chip).toMatchObject({ locale: NS, options: { id: ENTRY_ID } })
    const actions = chip.inject!()
    expect(isInjected(actions)).toBe(true)
    if (!isInjected(actions)) return
    expect(await actions.status(session)).toEqual({ ok: true, value: { kind: 'none', cwd: '/tmp' } })
    expect(b.gitBranch.status).toHaveBeenCalledWith(session)
    expect(await actions.switchBranch(session, { branch: 'dev' })).toEqual({ ok: false, message: 'refused' })
    expect(b.gitBranch.switchBranch).toHaveBeenCalledWith(session, { branch: 'dev' })

    await fiber.dispose()
    expect(b.ctx.slots.entries('conversation.hero.context')).toHaveLength(0)
    expect(b.unmount).toHaveBeenCalledOnce()
  } finally { await b.ctx.fiber.dispose() }
})

it('rolls back the Remote contribution when the slot registration fails', async () => {
  const b = await fixture(true)
  try {
    await expect(mountGitBranch(b.ctx, REMOTE)).rejects.toThrow('slot failed')
    expect(b.unmount).toHaveBeenCalledOnce()
  } finally { await b.ctx.fiber.dispose() }
})
