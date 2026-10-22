---
description: "The gitBranch Remote: the checked-out branch, local and remote-tracking branches, and branch switching for a Session's working directory."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-git-branch

English | [中文](README.zh.md)

## Summary

Serve the Git branch state of a Session's working directory to the Web client and switch it on request. Every Git command runs through the Session's own subprocess provider in the directory its working-directory provider reports, so a Session on a remote execution environment reads and switches the remote checkout. [`client-ui-git-branch`](../client-ui-git-branch/README.md) shows the branch on the New Session screen.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount it in the Host configuration beside the client package:

```yaml
- name: '@deepseek-ai/dsh-experimental-git-branch'
- name: '@deepseek-ai/dsh-experimental-client-ui-git-branch'
```

| Field | Default | Meaning |
|---|---|---|
| `command` | `git` | Git executable path or PATH name |
| `timeoutMs` | `15000` | Milliseconds before one Git command is terminated |
| `graceMs` | `2000` | Milliseconds a terminated Git command gets to exit |
| `maxOutputBytes` | `1048576` | Bytes of output kept per Git command; a longer branch listing fails |
| `maxBranches` | `200` | Most local and most remote-tracking branches returned, each |

The service registers `ctx.gitBranch` and the `gitBranch` Remote namespace, whose methods take the Session as their Agent parameter. `status(session)` returns `{ kind: 'none', cwd }` outside a repository, and otherwise `{ kind: 'repository', cwd, root, branch, commit, local, remote, truncated }`: `branch` is null for a detached HEAD, `commit` is the abbreviated HEAD commit and empty before the first commit, `local` lists local branches and `remote` lists remote-tracking branches without a local branch of the same name as `<remote>/<branch>`, both most recently committed first and cut at `maxBranches`. `switchBranch(session, { branch, remote? })` accepts only a listed name: it runs `git switch <branch>`, or with `remote` set `git switch --track <remote>/<branch>`, which creates and checks out a local tracking branch, and returns the new state. Git keeps uncommitted changes that do not conflict and refuses the switch otherwise; the refusal reaches the caller with Git's message. A directory Git cannot read for another reason, a listing over `maxOutputBytes`, a timeout, and a missing subprocess or working-directory provider fail the call.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

| Source | Responsibility |
|---|---|
| [`src/index.ts`](src/index.ts) | Config, the Git runner, status parsing, and the `gitBranch` Remote |
| [`src/types.ts`](src/types.ts) | Status and switch request records shared with the client |

`status` runs `git rev-parse --show-toplevel`, `git symbolic-ref --quiet --short HEAD`, `git rev-parse --verify --quiet --short HEAD`, and `git for-each-ref --sort=-committerdate refs/heads refs/remotes`. Each command runs with `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`, `LC_ALL=C`, and `GIT_CONFIG_COUNT=0`, because the subprocess credential scrub removes ambient `GIT_CONFIG_KEY_n` entries. `switchBranch` reads the state first, so a name Git would parse as an option or a branch that vanished never reaches `git switch`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Git branch chip](../client-ui-git-branch/README.md) — the New Session control that reads and switches the branch.
- [Working directory](../../session/working-directory/README.md) — how a Session's directory is resolved.

-----

<a id="model-experience"></a>
## Model Experience

None, as the service serves the Web client only and adds nothing to model requests; a switch changes the files later tool calls read.

#### KV Cache effect

No effect.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No branch creation, fetch, or stash** — the service switches between branches that already exist locally or as remote-tracking refs; it does not create branches from a name, fetch remotes, or stash changes.
- **No turn guard** — the Remote does not refuse a switch while a turn runs in the same directory; the client offers it only on the New Session screen.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer details — click to expand</summary>

None.

</details>
