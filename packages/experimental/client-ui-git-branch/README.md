---
description: "The Git branch chip on the New Session screen: shows the working directory's branch beside the workspace picker and switches it from a menu."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-git-branch

English | [中文](README.zh.md)

## Summary

Show the Git branch of a new Session's working directory after the workspace and preset controls on the New Session screen, and switch it from a menu of local and remote-tracking branches served by [`git-branch`](../git-branch/README.md).

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

Mount it in the Host configuration beside `git-branch`; the Web client loads the chip from the package's client entry.

```yaml
- name: '@deepseek-ai/dsh-experimental-git-branch'
- name: '@deepseek-ai/dsh-experimental-client-ui-git-branch'
```

The chip occupies the `conversation.hero.context` slot. It shows the checked-out branch, or the abbreviated commit for a detached HEAD, and its tooltip names the repository root. It reads the branch when the Session changes, when the menu opens, and when the window regains focus, so a switch made in a terminal appears without a reload. The menu lists local branches, then remote-tracking branches without a local counterpart; picking a remote-tracking branch creates a local branch that tracks it. A refused switch, such as one Git rejects because uncommitted changes would be overwritten, shows Git's message in a banner and rereads the branch. Outside a repository the chip is absent; when Git cannot be read it is disabled and its tooltip carries the error.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

| Source | Responsibility |
|---|---|
| [`src/client/mount.ts`](src/client/mount.ts) | Mount the `gitBranch` Remote, the dictionaries, and the `conversation.hero.context` entry |
| [`src/client/BranchChip.tsx`](src/client/BranchChip.tsx) | The chip, its menu entries, and the failure banner |
| [`src/client/locales.ts`](src/client/locales.ts) | `git.branch` dictionaries |

Each read or switch takes a generation number; an answer that an earlier Session asked for, or that a newer read overtook, is dropped.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Git branch service](../git-branch/README.md) — the `gitBranch` Remote, its limits, and Git's switch behavior.

-----

<a id="model-experience"></a>
## Model Experience

None, as the chip reads and switches the working tree only and sends nothing to a Session.

#### KV Cache effect

No effect.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **New Session screen only** — the chip does not appear in the header of a Session that has started.
- **No search** — the menu lists up to `maxBranches` branches of each kind without filtering.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer details — click to expand</summary>

None.

</details>
