---
description: "Watch SenseCore SSP jobs through the local sco CLI and serve their state, training curves, and logs to the Web client."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-cluster-monitor

English | [中文](README.zh.md)

## Summary

Poll watched SSP training jobs on the Host through [`ctx.sco`](../sco/README.md), keep their state, parsed training metrics, and log tail in a storage domain, and expose them as the `cluster` Remote namespace. Jobs the gateway creates are watched automatically; the [Cluster jobs page](../client-ui-cluster-monitor/README.md) renders them.

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

Mount the service beside the SSP gateway and a `storageDomain` provider, and add the page package for the Web client. [`sco.patch.yml`](sco.patch.yml) adds the gateway, the SSP job tools, this service, both cluster pages, and the Git branch chip to the Web profile: fill in the `sco` path, then run `pnpm dsh web --patch packages/experimental/cluster-monitor/sco.patch.yml`.

```yaml
- name: '@deepseek-ai/dsh-experimental-sco'
- name: '@deepseek-ai/dsh-experimental-cluster-monitor'
  config:
    runningPollMs: 30000
- name: '@deepseek-ai/dsh-experimental-client-ui-cluster-monitor'
```

| Field | Default | Meaning |
|---|---|---|
| `runningPollMs` | `30000` | Poll interval while a job runs (minimum 5000) |
| `pendingPollMs` | `60000` | Poll interval while a job is pending or its state is unknown (minimum 5000) |
| `maxConcurrentCalls` | `4` | `sco` invocations in flight across all watches |
| `logTailLength` | `65536` | Retained log tail in UTF-16 code units |
| `maxPointsPerSeries` | `2000` | Points kept per metric before every other older point is dropped (minimum 16) |
| `describeLength` | `32768` | Retained length of the last job object as JSON text |
| `watchCreatedJobs` | `true` | Watch every job `ctx.sco.createJob` creates |

`ctx.clusterMonitor` serves `list()`, `detail(watchId)`, `watch({ name, workspace?, sessionId? })`, `unwatch(watchId)`, `refresh(watchId)`, and the streams `follow()` and `followJob(watchId)`. `watch` is idempotent per name and workspace. Each row carries the `sessionId` of the Session that created or watched the job, taken from `sco/job-created` or the request; a later call with a `sessionId` attaches it to a watch that has none and never replaces one. Each poll describes the job and maps its `state` to `pending`, `running`, `succeeded`, `failed`, `stopped`, or `unknown`; while it runs, and once when it ends, one log round is read and parsed. Polling stops at a terminal state, resumes for stored non-terminal watches after a restart, and records a failed `sco` call on the watch without stopping it. Metrics come from rlightning-humanoid's `metric  value` tables and `[step=N]  key=value` lines; a value is kept only when the record carries an integer `step` newer than the stored one.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

| Source | Responsibility |
|---|---|
| [`src/index.ts`](src/index.ts) | Watch records, polling timers, the call limit, and the `cluster` Remote |
| [`src/parse.ts`](src/parse.ts) | Job state and times, metric lines, and log tails |
| [`src/types.ts`](src/types.ts) | Remote rows, details, and error codes |

Watches live in the `cluster_monitor` storage domain keyed by workspace and name, so they survive restarts without a session. Polling runs on Host timers and never enters a model request. A poll that finishes after `unwatch` or disposal writes nothing. Disposal aborts in-flight calls, cancels timers, and waits for running polls before closing the domain.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [SSP gateway](../sco/README.md) — the CLI invocations and the `sco/job-created` event.
- [Cluster jobs page](../client-ui-cluster-monitor/README.md) — the Web view of these watches.

-----

<a id="model-experience"></a>
## Model Experience

None, as polling and its results stay on the Host and in the Web client.

#### KV Cache effect

No effect; this package contributes no prompt text or tool results.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No GPU metrics** — CMS GPU utilization and memory are not read; only state, logs, and log-derived metrics are shown.
- **No agent notices** — a job reaching a terminal state is not reported into a Session.
- **Log round semantics** — one non-following `stream-logs` round is assumed to return the recent output; output past `sco`'s captured byte limit keeps only its tail.
- **Step resets** — after a training restart that starts again from a lower step, new points are ignored until the step passes the stored one.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer details — click to expand</summary>

SSP does not enumerate job states, so the phase mapping matches keywords and leaves unmatched text `unknown`, which keeps polling at the pending interval.

</details>
