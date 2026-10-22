/** Branch records the `gitBranch` Remote namespace returns and accepts. */

/** A Session working directory outside any Git repository. */
export interface GitBranchNone {
  kind: 'none'
  /** The Session working directory that was inspected. */
  cwd: string
}

/** Branch state of the Git repository containing a Session working directory. */
export interface GitBranchRepository {
  kind: 'repository'
  /** The Session working directory that was inspected. */
  cwd: string
  /** Top-level directory of the checkout. */
  root: string
  /** Checked-out branch, or null when HEAD is detached. */
  branch: string | null
  /** Abbreviated HEAD commit; empty before the first commit. */
  commit: string
  /** Local branches, most recently committed first. */
  local: string[]
  /** Remote-tracking branches without a local branch of the same name, as `<remote>/<branch>`, most recently committed first. */
  remote: string[]
  /** True when `maxBranches` shortened `local` or `remote`. */
  truncated: boolean
}

/** Branch state of a Session working directory. */
export type GitBranchStatus = GitBranchNone | GitBranchRepository

/** Branch to check out in a Session working directory. */
export interface GitSwitchRequest {
  /** A name from `local`, or from `remote` when `remote` is set. */
  branch: string
  /** Create a local branch tracking the named remote-tracking branch, and check it out. */
  remote?: boolean
}
