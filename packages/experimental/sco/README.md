---
description: "Run SenseCore SSP training-job operations through the locally installed sco CLI."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-sco

English | [中文](README.zh.md)

## Summary

List, inspect, read logs of, submit, and stop SenseCore SSP training jobs, read workspace queues, and list AFS volumes and their directory quota rules, from the Host through the user's own `sco` CLI and credential profile. Each operation is one CLI invocation with literal arguments and a deadline; listing and inspection return the CLI's JSON unchanged.

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

Install and initialize `sco` first (`sco init`, then `sco config set subscription …` and `sco config set resource_group …`). Mount the gateway beside a `subprocess` provider, and add the [tool package](../tool-sco/README.md) when models need the operations.

```yaml
- name: '@deepseek-ai/dsh-experimental-sco'
  config:
    profile: pjlab
    workspace: my-workspace
    queueId: /subscriptions/.../queues/gpu-pool
- name: '@deepseek-ai/dsh-experimental-tool-sco'
```

| Field | Default | Meaning |
|---|---|---|
| `command` | `sco` | Executable name on PATH or absolute path |
| `profile` | CLI active profile | Passed as `--profile` |
| `workspace` | profile `ssp.workspace_name` | Default `--workspace-name`; a request value wins |
| `queueId` | profile `ssp.queue_id` | Default `--queue-id` for creation; a request value wins |
| `timeoutMs` | `120000` | Deadline for one invocation |
| `graceMs` | `3000` | Subprocess termination grace |
| `maxOutputBytes` | `1048576` | Captured bytes per output stream |

`ctx.sco` exposes `listJobs(request?)`, `describeJob(name, request?)`, `listWorkers(name, request?)`, `readLogs(name, request?)`, `createJob(request)`, and `stopJobs(names, request?)`, each with an optional `AbortSignal`. Listing, description, and worker reads return the CLI's `--format=json` output as JSON. `readLogs` reads one non-following `stream-logs` round and keeps the tail when output exceeds `maxOutputBytes`, setting `truncated`; every other operation fails on oversized output. `createJob` maps its fields onto parameterized `sco ssp jobs create` flags; with `dryRun` it returns the merged `TrainingJob` without creating anything, otherwise the CLI output. `stopJobs` accepts 1 to 100 names. A non-zero exit fails with the CLI's stderr, or stdout when stderr is empty. A successful non-dry-run `createJob` emits `sco/job-created` with the job name and the resolved workspace, which [cluster-monitor](../cluster-monitor/README.md) uses to watch new jobs. `listQueues(request?)` runs `sco ssp workspaces list-queues` for the resolved workspace and fails when none resolves; `describeQueue(cluster, queue)` runs `sco ssp queues get`, whose object lists the machine types the queue accepts. `workspaceOf(request)` and `profile` expose the resolved workspace and configured profile, which [sco-submit](../sco-submit/README.md) uses to key cached options. `listVolumes()` runs `sco afs volumes list --format=json` and returns the volumes the active credentials can see as `ScoAfsVolume` records with `id`, `name`, `type`, `totalCapacity`, `usedCapacity`, `region`, `zone`, `endTime`, and `state`, omitting empty fields; `usedPercent` is added when both capacities parse and the total is positive, treating units as binary (`1TB` = `1024GB`). Output that is not an array, or an entry without a string `ID`, fails the call. The record type is exported from `@deepseek-ai/dsh-experimental-sco/types` for client code. `listDirectoryQuotas(volume)` runs `sco afs volumes list-dir-quota --instance=<volume>` and returns the CLI's JSON rules.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

| Source | Responsibility |
|---|---|
| [`src/index.ts`](src/index.ts) | Resolve defaults, run one invocation under a deadline, parse JSON, classify failures |
| [`src/argv.ts`](src/argv.ts) | Validate names and values and build `--flag=value` arguments |
| [`src/types.ts`](src/types.ts) | Request and result records |

Every value travels as a single `--flag=value` token and job names must match the SSP name grammar, so no request value can be read as another option. The `sco afs` commands follow the installed CLI's `--help`, which differs from the published reference: it has no `volumes ls` or `dir-quota` group. The CLI runs through `ctx.subprocess` without a shell and without sandbox confinement, because it needs network access and the user's credential profile under the home directory. Creation and stop are not idempotent; a cancelled or timed-out call may still have been applied remotely. Service disposal aborts in-flight invocations.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [SSP job tools](../tool-sco/README.md) — model-facing operations and the approval gate.
- [Subprocess](../../subprocess/subprocess/README.md) — process ownership, output capture, and termination.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the SSP job tools' results.

#### KV Cache effect

This package contributes no prompt text. The tool package owns the appended tool results.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Parameterized creation only** — complete `TrainingJob` files (`--config`), per-instance `--workload-file` overrides, and `copy` are not exposed, so heterogeneous instance groups and Ray cluster specs need the CLI directly.
- **Unconfined CLI** — the Session sandbox does not apply to `sco`; the tool package's approval gate is the control for remote mutations.
- **Volume reads only** — AFS volumes and quota rules are listed, not created or changed; directory listings, AOSS bucket usage, and `sco cms metrics` capacity history are not exposed.
- **No log following** — logs are read one round at a time; `--follow` streaming and file output are not exposed.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The CLI's JSON output fields are not documented, so results stay untyped JSON rather than a projection that could drift from the cluster API.

</details>
