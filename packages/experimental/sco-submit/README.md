---
description: "Compose SenseCore SSP jobs from registered data, code, output, and personal storage sources and configured templates, with cached queue options."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-sco-submit

English | [中文](README.zh.md)

## Summary

Submit SSP training jobs by name instead of by volume UUID. The service keeps a durable registry of data, code, output, and personal storage locations on cluster storage, reuses repositories and packages kept in personal storage, expands configured job templates into [sco gateway](../sco/README.md) creation flags, and caches the queues and machine types a workspace offers so they are queried only when missing or after a resource failure.

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

Mount the service after the sco gateway and a `storageDomain` facility, which the base bundle provides, and add the [tool package](../tool-sco/README.md) for the model-facing tools.

```yaml
- name: '@deepseek-ai/dsh-experimental-sco'
  config:
    workspace: my-workspace
- name: '@deepseek-ai/dsh-experimental-sco-submit'
  config:
    templates:
      wbt-train:
        image: registry.example/rlh:wbt
        code: rlightning-humanoid
        data: [motion-lafan]
        output: wbt-outputs
        command: python scripts/rsl_rl/train.py --task Tracking-Flat-G1 --headless
- name: '@deepseek-ai/dsh-experimental-tool-sco'
```

| Field | Default | Meaning |
|---|---|---|
| `templates` | `{}` | Job templates by name: image, code, data, output, command, env, and resource flags |
| `outputMountPath` | `/outputs` | Container path where every job mounts its output directory |
| `gitCommand` | `git` | Command that clones repositories missing from a storage source inside the job container |
| `pipCommand` | `python -m pip` | Command that installs and downloads packages inside the job container |

Sources are registered at runtime, not in config. A `data` source mounts a volume directory (AFS) or prefix (AOSS) at its `mountPath`. A `code` source holds one snapshot directory per ref under `root` and mounts `/<root>/<ref>` at its `mountPath`; the startup command changes into that directory and runs `setup` before the job command. An `output` source mounts `/<root>/<job name>` at `outputMountPath`, so every job writes to its own directory. A data `path` and a code or output `root` are volume directories written with or without the leading `/`: they are trimmed, leading and trailing `/` are removed, and the mount adds the leading `/` the CLI requires; an empty value or `/` names the volume root. A directory with characters other than letters, digits, `.`, `_`, `-`, and `/`, or with `..`, `//`, or spaces, fails registration. `ctx.scoSubmit` exposes `sources()`, `addSource(name, source)`, `updateSource(name, source)`, `removeSource(name)`, `listTemplates()`, `outputPath`, `resourceOptions(request?)`, `resolve(request)`, `submit(request, signal?, origin?)`, `configs()`, and `askForm(request, signal)`.

A `storage` source is the user's personal storage: it mounts a volume directory at its `mountPath` and keeps one git clone per repository under `reposDir` and pip package files under `packagesDir`, both directories under the mount. A submission or template that sets `storage` mounts it, and its `repos` and `packages` become startup steps that run before the code directory steps. A repository entry is a clone URL, optionally followed by `#<branch, tag, or commit>`; it lives at `<mountPath>/<reposDir>/<repo>`, or `<repo>@<ref>` with `/` in the ref written as `_`, and is cloned there only when that directory is missing (into a temporary directory first, so a failed or concurrent clone leaves no partial copy). Package entries are pip requirement specifiers or `-r <absolute path>`; they are installed with `--no-index --find-links <packagesDir>`, and only when that fails are they downloaded into `packagesDir` and installed from there. The next job that needs the same repository or package uses the stored copy without network access. `repos` or `packages` without `storage` fails. The submission outcome lists the storage name, each repository's container path, and the packages under `storage`.

`resolve` merges the named template with request fields, which win; `env` merges key by key. Template source names resolve at that point, so a removed source fails the next submission that names it. `submit` checks `machineType` against the cached options for the workspace when options are cached, runs `createJob`, and emits `sco/job-submitted` with the template, code ref, data, output, and storage names after a real creation. When the CLI rejects a creation with a message naming a machine type, spec, queue, quota, or GPU, `submit` refreshes the cached options before rethrowing and says so in the error.

`resourceOptions` runs `sco ssp workspaces list-queues`, keeps each listed queue object whose `id` is a queue resource id, stores the result keyed by sco profile and workspace, and returns the stored copy until `refresh` is set. It needs a workspace from the request or the gateway config, and fails with an excerpt of the listing when the listing contains no queue id.

The service also serves the `clusterConfig` Remote namespace for the [Cluster settings page](../client-ui-cluster-monitor/README.md): `overview()` returns the profile, the effective default workspace and queue with the `configured` and page-`saved` values behind them, `outputMountPath`, sources, templates, and the default workspace's cached options with the machine types found in each queue; `follow()` streams a new overview after every source change or option refresh; `saveSource({ name, source, replace? })` adds a source, or replaces it when `replace` is set; `deleteSource(name)`, `refreshOptions()`, and `volumes()` remove a source, query the default workspace again, and list AFS volumes; `saveDefaults({ workspace?, queueId? })` stores the page's default workspace and queue for the current sco profile and applies them through the gateway's `setDefaults` at once and at every start, so they take precedence over the configured values. A queue must be a full queue resource id; saving both fields empty deletes the record and restores the configured defaults. The record types are exported from `@deepseek-ai/dsh-experimental-sco-submit/types`.

Saved configurations are named `ScoWorkloadSpec` records of kind `job` or `devmachine`: an image, source names, a code ref, command, environment, resource counts, priority, framework, retries, queuing, workspace, and queue. `saveConfig({ name, kind, description?, spec, replace? })` stores one after trimming strings and dropping empty fields, fails when the name exists without `replace`, and keeps the creation and last-load times when it replaces; `deleteConfig(name)` removes one. The overview lists them under `configs`.

`askForm({ callId, sessionId?, kind, title?, initial, suggested? }, signal)` opens a configuration form for one tool call and resolves when the user answers it; `followForms()` streams the open forms, and `answerForm(callId, answer)` answers one with `{ kind: 'cancelled' }` or `{ kind: 'confirmed', spec, loaded?, save? }`. A confirmed answer with `save` stores the configuration first and leaves the form open when that fails; one with `loaded` records the load time on that configuration. The form closes with an error when the signal aborts or the service unloads, and a second form for the same call id or a `suggested` name that is not saved fails at once. `submit` passes `origin.sessionId` to the gateway's `createJob`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

| Source | Responsibility |
|---|---|
| [`src/index.ts`](src/index.ts) | Config validation, the `sco_submit` storage domain, option caching, submission, the event, saved configurations, configuration forms, and the `clusterConfig` Remote |
| [`src/resolve.ts`](src/resolve.ts) | Source validation, template merging, mount strings, storage steps, startup command, and untyped JSON scans |
| [`src/types.ts`](src/types.ts) | Source, template, option, submission, and configuration overview records |

Sources and options live in the `sco_submit` storage domain (tables `sources`, `resource_options`, `defaults`, and `configs`), so they survive restarts on whichever backend the domain facility routes to. Mount paths and volume subpaths are restricted to letters, digits, `.`, `_`, `-`, and `/` without `..`, which keeps every mount a single `--volume-mount` token and lets the startup command use paths without quoting. Queue ids are found by scanning the listing for strings shaped like `/subscriptions/…/clusters/<cluster>/queues/<queue>`, and machine types are matched as exact string values anywhere in a queue object, because the CLI does not document either JSON layout; the overview reads machine types from `machine_type` (as in `properties.machine_type_allocation`) and `spec_code` keys.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [sco gateway](../sco/README.md) — CLI mapping and failure behavior for creation and queue reads.
- [SSP job tools](../tool-sco/README.md) — model-facing source, option, and submission tools.
- [Storage domain](../../storage/storage-domain/README.md) — durable records and backend routing.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the SSP job tools' results, including the configuration form answer that `sco_config_form` returns.

#### KV Cache effect

This package contributes no prompt text. The tool package owns the appended tool results.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No code upload** — code must already be on cluster storage as `<root>/<ref>/`; packaging a local commit and copying it through a development machine or a job-side shallow clone is deferred.
- **Unverified downloads** — repositories and packages missing from a storage source are fetched as named, without pinning a commit or checking hashes, and a stored repository is never updated; delete its directory to fetch it again.
- **No path check at registration** — registering a source does not confirm that the directory exists; a wrong path surfaces when the job starts.
- **Templates come from config** — templates cannot be created or changed at runtime, and resource presets are not modeled separately from templates.
- **Heuristic option parsing** — queue ids and machine types are found by string shape and equality, so a CLI output change can hide options without failing.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

`sco/job-created` from the gateway still fires for every creation; `sco/job-submitted` adds the composition for jobs created through `submit`.

</details>
