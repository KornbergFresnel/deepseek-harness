---
description: "Compose SenseCore SSP jobs from registered data, code, and output sources and configured templates, with cached queue options."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-sco-submit

English | [中文](README.zh.md)

## Summary

Submit SSP training jobs by name instead of by volume UUID. The service keeps a durable registry of data, code, and output locations on cluster storage, expands configured job templates into [sco gateway](../sco/README.md) creation flags, and caches the queues and machine types a workspace offers so they are queried only when missing or after a resource failure.

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

Sources are registered at runtime, not in config. A `data` source mounts a volume directory (AFS) or prefix (AOSS) at its `mountPath`. A `code` source holds one snapshot directory per ref under `root` and mounts `<root>/<ref>` at its `mountPath`; the startup command changes into that directory and runs `setup` before the job command. An `output` source mounts `<root>/<job name>` at `outputMountPath`, so every job writes to its own directory. `ctx.scoSubmit` exposes `sources()`, `addSource(name, source)`, `updateSource(name, source)`, `removeSource(name)`, `listTemplates()`, `outputPath`, `resourceOptions(request?)`, `resolve(request)`, and `submit(request)`.

`resolve` merges the named template with request fields, which win; `env` merges key by key. Template source names resolve at that point, so a removed source fails the next submission that names it. `submit` checks `machineType` against the cached options for the workspace when options are cached, runs `createJob`, and emits `sco/job-submitted` with the template, code ref, data, and output names after a real creation. When the CLI rejects a creation with a message naming a machine type, spec, queue, quota, or GPU, `submit` refreshes the cached options before rethrowing and says so in the error.

`resourceOptions` runs `sco ssp workspaces list-queues`, keeps each listed queue object whose `id` is a queue resource id, stores the result keyed by sco profile and workspace, and returns the stored copy until `refresh` is set. It needs a workspace from the request or the gateway config, and fails with an excerpt of the listing when the listing contains no queue id.

The service also serves the `clusterConfig` Remote namespace for the [Cluster settings page](../client-ui-cluster-monitor/README.md): `overview()` returns the profile, default workspace and queue, `outputMountPath`, sources, templates, and the default workspace's cached options with the machine types found in each queue; `follow()` streams a new overview after every source change or option refresh; `saveSource({ name, source, replace? })` adds a source, or replaces it when `replace` is set; `deleteSource(name)`, `refreshOptions()`, and `volumes()` remove a source, query the default workspace again, and list AFS volumes. The record types are exported from `@deepseek-ai/dsh-experimental-sco-submit/types`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

| Source | Responsibility |
|---|---|
| [`src/index.ts`](src/index.ts) | Config validation, the `sco_submit` storage domain, option caching, submission, the event, and the `clusterConfig` Remote |
| [`src/resolve.ts`](src/resolve.ts) | Source validation, template merging, mount strings, startup command, and untyped JSON scans |
| [`src/types.ts`](src/types.ts) | Source, template, option, submission, and configuration overview records |

Sources and options live in the `sco_submit` storage domain (tables `sources` and `resource_options`), so they survive restarts on whichever backend the domain facility routes to. Mount paths and volume subpaths are restricted to letters, digits, `.`, `_`, `-`, and `/` without `..`, which keeps every mount a single `--volume-mount` token and lets the startup command use paths without quoting. Queue ids are found by scanning the listing for strings shaped like `/subscriptions/…/clusters/<cluster>/queues/<queue>`, and machine types are matched as exact string values anywhere in a queue object, because the CLI does not document either JSON layout; the overview reads machine types from `machine_type` (as in `properties.machine_type_allocation`) and `spec_code` keys.

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

Indirectly, through the SSP job tools' results.

#### KV Cache effect

This package contributes no prompt text. The tool package owns the appended tool results.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No code upload** — code must already be on cluster storage as `<root>/<ref>/`; packaging a local commit and copying it through a development machine or a job-side shallow clone is deferred.
- **No path check at registration** — registering a source does not confirm that the directory exists; a wrong path surfaces when the job starts.
- **Templates come from config** — templates cannot be created or changed at runtime, and resource presets are not modeled separately from templates.
- **Heuristic option parsing** — queue ids and machine types are found by string shape and equality, so a CLI output change can hide options without failing.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

`sco/job-created` from the gateway still fires for every creation; `sco/job-submitted` adds the composition for jobs created through `submit`.

</details>
