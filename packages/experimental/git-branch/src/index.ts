/**
 * The `gitBranch` Remote namespace: the checked-out branch, the local and remote-tracking branches, and branch
 * switching for the Git repository containing a Session's working directory.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubprocessCollectedOutputs, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-working-directory'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { GitBranchRepository, GitBranchStatus, GitSwitchRequest } from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Branch reading and switching for Session working directories. */
    gitBranch: GitBranchController
  }
}

/** Executable and limits for every Git command. */
export interface Config {
  /** Git executable path or PATH name, resolved by the Session's subprocess provider. */
  readonly command: string
  /** Milliseconds before one Git command is terminated. */
  readonly timeoutMs: number
  /** Milliseconds a terminated Git command gets to exit. */
  readonly graceMs: number
  /** Bytes of stdout or stderr kept per Git command; a branch listing beyond it fails. */
  readonly maxOutputBytes: number
  /** Most local and most remote-tracking branches returned, each. */
  readonly maxBranches: number
}

/** Settled facts of one Git command; a non-zero exit is a result. */
interface GitRun {
  exitCode: number | null
  stdout: string
  stderr: string
  lossy: boolean
}

/** Where a Session runs Git. */
interface GitPlace {
  subprocess: SubprocessRuntime
  cwd: string
}

const NOT_A_REPOSITORY = /not a git repository/i

/**
 * Accept a Git command whose exit code is listed.
 * @param run - the settled command.
 * @param command - the Git subcommand, for the error.
 * @param accepted - exit codes that carry an answer.
 * @returns `run`.
 * @throws with Git's stderr for any other exit.
 */
function settled(run: GitRun, command: string, accepted: readonly number[]): GitRun {
  if (!accepted.some(code => code === run.exitCode)) throw new Error(`git ${command} failed (exit ${String(run.exitCode)}): ${run.stderr.trim()}`)
  return run
}

/** Serves branch state and switching to the Web client through the Session's own subprocess provider. */
export class GitBranchController extends TypertRemoteService {
  static inject = ['typert']
  static Config: z<Config> = z.object({
    command: z.string().min(1).default('git'),
    timeoutMs: z.number().step(1).min(1).default(15_000),
    graceMs: z.number().step(1).min(1).default(2_000),
    maxOutputBytes: z.number().step(1).min(1024).default(1_048_576),
    maxBranches: z.number().step(1).min(1).default(200),
  })

  /**
   * @param ctx - Host context carrying the typed Remote registry.
   * @param config - validated Git executable and limits.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'gitBranch', { namespace: 'gitBranch' })
  }

  /**
   * Read the branch state of the Session's working directory.
   * @param agent - Session owner supplied by the Gateway.
   * @param signal - request cancellation.
   * @returns `none` outside a repository, otherwise the checked-out branch and the branches available to switch to.
   */
  @Remote
  async status(agent: Agent, signal: AbortSignal): Promise<GitBranchStatus> {
    return await this.read(this.place(agent), signal)
  }

  /**
   * Check out a listed branch in the Session's working directory with `git switch`, which keeps uncommitted changes
   * that do not conflict and refuses otherwise.
   * @param agent - Session owner supplied by the Gateway.
   * @param request - the branch, and whether it names a remote-tracking branch.
   * @param signal - request cancellation; an abort after Git started leaves the outcome to Git.
   * @returns the branch state after the switch.
   * @throws when the directory is not a repository, the branch is not listed, or Git refuses the switch.
   */
  @Remote
  async switchBranch(agent: Agent, request: GitSwitchRequest, signal: AbortSignal): Promise<GitBranchRepository> {
    const place = this.place(agent)
    const before = await this.read(place, signal)
    if (before.kind === 'none') throw new Error(`${before.cwd} is not inside a Git repository`)
    const listed = request.remote === true ? before.remote : before.local
    if (!listed.includes(request.branch)) {
      throw new Error(`${request.remote === true ? 'remote-tracking ' : ''}branch "${request.branch}" is not listed in ${before.root}`)
    }
    if (request.remote !== true && request.branch === before.branch) return before
    const argv = request.remote === true ? ['switch', '--track', request.branch] : ['switch', request.branch]
    const run = await this.git(place, argv, signal)
    if (run.exitCode !== 0) throw new Error(`git ${argv.join(' ')} failed: ${run.stderr.trim()}`)
    const after = await this.read(place, signal)
    /* v8 ignore next -- a checkout that just switched branches stays a repository. */
    if (after.kind === 'none') throw new Error(`${after.cwd} is no longer inside a Git repository`)
    return after
  }

  private place(agent: Agent): GitPlace {
    const subprocess = agent.ctx.get('subprocess')
    const workingDirectory = agent.ctx.get('workingDirectory')
    if (subprocess === undefined || workingDirectory === undefined) {
      throw new Error('The Session execution environment requires subprocess and working-directory providers')
    }
    return { subprocess, cwd: workingDirectory.get(agent.session) }
  }

  private async read(place: GitPlace, signal: AbortSignal): Promise<GitBranchStatus> {
    const top = await this.git(place, ['rev-parse', '--show-toplevel'], signal)
    if (top.exitCode !== 0 && NOT_A_REPOSITORY.test(top.stderr)) return { kind: 'none', cwd: place.cwd }
    settled(top, 'rev-parse', [0])
    // symbolic-ref exits 1 for a detached HEAD.
    const head = settled(await this.git(place, ['symbolic-ref', '--quiet', '--short', 'HEAD'], signal), 'symbolic-ref', [0, 1])
    // rev-parse --verify exits 1 before the first commit.
    const commit = settled(await this.git(place, ['rev-parse', '--verify', '--quiet', '--short', 'HEAD'], signal), 'rev-parse', [0, 1])
    const refs = settled(
      await this.git(place, ['for-each-ref', '--sort=-committerdate', '--format=%(refname)', 'refs/heads', 'refs/remotes'], signal),
      'for-each-ref', [0],
    )
    if (refs.lossy) throw new Error(`git for-each-ref output exceeds maxOutputBytes (${this.config.maxOutputBytes})`)
    const local: string[] = []
    const tracking: string[] = []
    for (const ref of refs.stdout.split('\n')) {
      if (ref.startsWith('refs/heads/')) local.push(ref.slice('refs/heads/'.length))
      else if (ref.startsWith('refs/remotes/') && !ref.endsWith('/HEAD')) tracking.push(ref.slice('refs/remotes/'.length))
    }
    const localNames = new Set(local)
    const remote = tracking.filter(name => !localNames.has(name.slice(name.indexOf('/') + 1)))
    const max = this.config.maxBranches
    return {
      kind: 'repository',
      cwd: place.cwd,
      root: top.stdout.trim(),
      branch: head.exitCode === 0 ? head.stdout.trim() : null,
      commit: commit.exitCode === 0 ? commit.stdout.trim() : '',
      local: local.slice(0, max),
      remote: remote.slice(0, max),
      truncated: local.length > max || remote.length > max,
    }
  }

  /** Run `git <argv>` in the Session directory with prompts and optional locks disabled. */
  private async git(place: GitPlace, argv: readonly string[], signal: AbortSignal): Promise<GitRun> {
    const timeout = AbortSignal.timeout(this.config.timeoutMs)
    const operation = AbortSignal.any([signal, timeout])
    const program = await place.subprocess.resolveExecutable(this.config.command, undefined, operation)
    const child = place.subprocess.spawn({
      argv: [program, ...argv],
      cwd: place.cwd,
      // The subprocess credential scrub removes ambient GIT_CONFIG_KEY_n entries, so their count goes too.
      env: { GIT_CONFIG_COUNT: '0', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
      signal: operation,
      graceMs: this.config.graceMs,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: this.config.maxOutputBytes },
        stderr: { maxBytes: this.config.maxOutputBytes },
      },
    })
    const outcome = await child.done
    // A command cut short by the deadline or the caller reports the abort reason, not its signal exit.
    operation.throwIfAborted()
    // The spawn spec above collects both streams.
    const captured = child.collected as Required<SubprocessCollectedOutputs>
    const stdout = captured.stdout.readFrom(0)
    return { exitCode: outcome.exitCode, stdout: stdout.text, stderr: captured.stderr.readFrom(0).text, lossy: stdout.lossy }
  }
}

export default GitBranchController
