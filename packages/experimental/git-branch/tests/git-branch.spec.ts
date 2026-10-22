/** Branch reading and switching against real repositories through the local subprocess provider. */
import { execFileSync } from 'node:child_process'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { afterEach, describe, expect, it } from 'vitest'
import { GitBranchController, type Config } from '../src/index.ts'

const config: Config = { command: 'git', timeoutMs: 15_000, graceMs: 1_000, maxOutputBytes: 1_048_576, maxBranches: 200 }
const roots: Context[] = []
const dirs: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

const signal = (): AbortSignal => new AbortController().signal

async function tempDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'dsh-git-branch-')))
  dirs.push(dir)
  return dir
}

function git(cwd: string, ...argv: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...argv], { cwd, encoding: 'utf8' })
}

/** A repository on `main` with `feature`, plus a clone whose remote also offers `remote-only`. */
async function repositories(): Promise<{ origin: string; clone: string }> {
  const origin = await tempDir()
  git(origin, 'init', '-q', '-b', 'main')
  await writeFile(join(origin, 'a.txt'), 'main\n')
  git(origin, 'add', '.')
  git(origin, 'commit', '-q', '-m', 'main')
  git(origin, 'branch', 'feature')
  git(origin, 'branch', 'remote-only')
  const clone = await tempDir()
  git(clone, 'clone', '-q', origin, '.')
  git(clone, 'branch', 'feature', 'origin/feature')
  return { origin, clone }
}

async function fixture(cwd: string, overrides: Partial<Config> = {}, local = true) {
  const ctx = new Context()
  roots.push(ctx)
  if (local) await ctx.plugin(LocalSubprocessRuntime)
  ctx.provide('workingDirectory', { get: () => cwd } as never)
  const controller = new GitBranchController(ctx, { ...config, ...overrides })
  const agent = { ctx, session: { header: { cwd } } } as Agent
  return { controller, agent }
}

describe('GitBranchController', () => {
  it('reports a directory outside any repository as none', async () => {
    const cwd = await tempDir()
    const { controller, agent } = await fixture(cwd)
    expect(await controller.status(agent, signal())).toEqual({ kind: 'none', cwd })
  })

  it('lists the checked-out branch, local branches, and remote-only tracking branches', async () => {
    const { clone } = await repositories()
    const { controller, agent } = await fixture(clone)
    const status = await controller.status(agent, signal())
    expect(status).toMatchObject({ kind: 'repository', cwd: clone, root: clone, branch: 'main', truncated: false })
    if (status.kind !== 'repository') throw new Error('expected a repository')
    expect(status.commit).toMatch(/^[0-9a-f]{4,}$/)
    expect([...status.local].sort()).toEqual(['feature', 'main'])
    expect(status.remote).toEqual(['origin/remote-only'])
  })

  it('switches to a local branch and to a remote-tracking branch, then reports the new branch', async () => {
    const { clone } = await repositories()
    const { controller, agent } = await fixture(clone)
    expect(await controller.switchBranch(agent, { branch: 'feature' }, signal())).toMatchObject({ branch: 'feature' })
    expect(await controller.switchBranch(agent, { branch: 'feature' }, signal())).toMatchObject({ branch: 'feature' })
    const tracked = await controller.switchBranch(agent, { branch: 'origin/remote-only', remote: true }, signal())
    expect(tracked).toMatchObject({ branch: 'remote-only', remote: [] })
    expect(tracked.local).toContain('remote-only')
    expect(git(clone, 'rev-parse', '--abbrev-ref', 'remote-only@{upstream}').trim()).toBe('origin/remote-only')
  })

  it('reports a detached HEAD and an unborn branch', async () => {
    const { clone } = await repositories()
    git(clone, 'switch', '-q', '--detach', 'HEAD')
    const detached = await fixture(clone)
    const status = await detached.controller.status(detached.agent, signal())
    expect(status).toMatchObject({ branch: null })
    expect(status.kind === 'repository' ? status.local : []).toContain('main')

    const empty = await tempDir()
    git(empty, 'init', '-q', '-b', 'trunk')
    const unborn = await fixture(empty)
    expect(await unborn.controller.status(unborn.agent, signal())).toEqual({
      kind: 'repository', cwd: empty, root: empty, branch: 'trunk', commit: '', local: [], remote: [], truncated: false,
    })
  })

  it('caps each branch list at maxBranches', async () => {
    const { clone } = await repositories()
    const { controller, agent } = await fixture(clone, { maxBranches: 1 })
    expect(await controller.status(agent, signal())).toMatchObject({ truncated: true, remote: ['origin/remote-only'] })
    const status = await controller.status(agent, signal())
    expect(status.kind === 'repository' ? status.local.length : 0).toBe(1)
  })

  it('refuses unlisted branches, switches outside a repository, and switches Git rejects', async () => {
    const { clone } = await repositories()
    const { controller, agent } = await fixture(clone)
    await expect(controller.switchBranch(agent, { branch: '--orphan' }, signal())).rejects.toThrow('branch "--orphan" is not listed')
    await expect(controller.switchBranch(agent, { branch: 'feature', remote: true }, signal()))
      .rejects.toThrow('remote-tracking branch "feature" is not listed')

    await writeFile(join(clone, 'a.txt'), 'changed\n')
    git(clone, 'switch', '-q', 'feature')
    await writeFile(join(clone, 'a.txt'), 'feature\n')
    git(clone, 'commit', '-q', '-am', 'feature')
    await writeFile(join(clone, 'a.txt'), 'uncommitted\n')
    await expect(controller.switchBranch(agent, { branch: 'main' }, signal())).rejects.toThrow(/git switch main failed: .*overwritten/s)

    const outside = await fixture(await tempDir())
    await expect(outside.controller.switchBranch(outside.agent, { branch: 'main' }, signal())).rejects.toThrow('is not inside a Git repository')
  })

  it('fails loudly on Git errors, oversized listings, timeouts, aborts, and missing providers', async () => {
    const { clone } = await repositories()
    const broken = await fixture(join(clone, '.git'))
    await expect(broken.controller.status(broken.agent, signal())).rejects.toThrow('git rev-parse failed')

    await writeFile(join(clone, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    const huge = await fixture(clone, { maxOutputBytes: 1024 })
    for (let index = 0; index < 60; index++) git(clone, 'branch', `branch-with-a-rather-long-name-${index}`)
    await expect(huge.controller.status(huge.agent, signal())).rejects.toThrow('exceeds maxOutputBytes (1024)')

    const slow = await fixture(clone, { timeoutMs: 1 })
    await expect(slow.controller.status(slow.agent, signal())).rejects.toThrow(/timed out after 1ms|aborted/)

    const aborted = new AbortController()
    aborted.abort(new Error('stop'))
    const { controller, agent } = await fixture(clone)
    await expect(controller.status(agent, aborted.signal)).rejects.toThrow()

    const missing = await fixture(clone, {}, false)
    await expect(missing.controller.status(missing.agent, signal())).rejects.toThrow('requires subprocess and working-directory providers')
  })
})
