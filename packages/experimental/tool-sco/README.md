---
description: "Model tools that list, inspect, submit, and stop SenseCore SSP training jobs and compose jobs from registered sources and templates, asking the user before remote changes."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-tool-sco

English | [中文](README.zh.md)

## Summary

Let a model manage SenseCore SSP training jobs through the user's local `sco` CLI. Six tools list, read, and stop jobs, list workers, read logs, and submit a job, and two read AFS volumes and directory quotas. `sco_job_watch` sets a watched job's description and metric source. With [sco-submit](../sco-submit/README.md) mounted, seven more register data, code, and output locations, read cached queue and machine-type options, submit jobs composed from a template, and open an in-conversation form where the user sets up a job or development machine. Submission and stop ask the user first by default; dry-run submission validates a job without asking.

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

Add this package's bundle to a profile, or mount the function plugin after the [sco gateway](../sco/README.md) and the tool registry; mount [sco-submit](../sco-submit/README.md) beside them for source and template tools. Approval needs a composed approval service with an answerer, such as the Web application's prompt.

```yaml
- name: '@deepseek-ai/dsh-experimental-sco'
- name: '@deepseek-ai/dsh-experimental-sco-submit'
- name: '@deepseek-ai/dsh-experimental-tool-sco'
  config:
    confirmMutations: true
```

| Tool | Result |
|---|---|
| `sco_job_list` | JSON job listing; defaults to `-created_at` order |
| `sco_job_describe` | JSON `TrainingJob` with state |
| `sco_job_workers` | JSON worker listing |
| `sco_job_logs` | `{ text, truncated }` for one log round |
| `sco_job_create` | `{ kind: 'dry-run', job }` or `{ kind: 'created', name, output }` |
| `sco_job_stop` | `{ names, output }` |
| `sco_job_watch` | `{ name, phase, description, metrics, metricsDefault }` of the watch (needs cluster-monitor) |
| `sco_volumes_list` | Volume records with `id`, capacities, `usedPercent` when the capacities parse, region, zone, end time, and state |
| `sco_volume_quota` | JSON directory quota rules for one volume |
| `sco_sources_list` | `{ sources, templates, configs, outputMountPath }` (needs sco-submit) |
| `sco_source_add`, `sco_source_update` | `{ name, source }` (needs sco-submit) |
| `sco_source_remove` | `{ removed }` (needs sco-submit) |
| `sco_resource_options` | Cached `{ workspace, fetchedAt, queues }` (needs sco-submit) |
| `sco_job_submit` | `{ kind: 'dry-run', resolved, job }` or `{ kind: 'created', resolved, name, output }` (needs sco-submit) |
| `sco_config_form` | `{ kind: 'confirmed', workload, spec, loaded?, savedAs? }` or `{ kind: 'cancelled' }` after the user answers (needs sco-submit) |

With `confirmMutations` (default `true`), `sco_job_create` and `sco_job_submit` without `dryRun: true` and every `sco_job_stop` ask the user through `ctx.approval` after other pre-execute listeners allow the call; a denial from another listener stands without asking. Under the `never` approval policy these calls are rejected. Volume reads, source registration, and `sco_config_form` do not ask; the form is itself the user's answer. `sco_job_create` and `sco_job_submit` record the calling agent's Session and the call's `description` on the created job, so the Web client can list a conversation's jobs and say what each does. `sco_job_watch` does not ask. `usedPercent` treats capacity units as binary (`1TB` = `1024GB`). Set `confirmMutations: false` only for unattended runs that may submit and stop jobs freely. The [generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-experimental-tool-sco) owns the exact schemas and model-facing descriptions.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[`cordis.patch.yml`](cordis.patch.yml) inserts the `sco` gateway, `sco-submit`, and `tool-sco` rows. [`src/index.ts`](src/index.ts) registers eight typed tools that forward to `ctx.sco` and render their canonical values as JSON, except logs, which render as text with a truncation marker. Inside `ctx.inject(['clusterMonitor'])` it registers `sco_job_watch`, which forwards to `ctx.clusterMonitor.watch` and `configure`. Inside `ctx.inject(['scoSubmit'])` it registers the source, option, and submission tools, which forward to `ctx.scoSubmit` and disappear when that service unloads; source tools take flat arguments and reject fields the source kind does not use. The approval gate is a `tools/pre-execute` listener that delegates first and converts only an `allow` into `ask`. Host presentation uses generic cards. `sco_config_form` waits on `ctx.scoSubmit.askForm` under the call's abort signal, so stopping the turn closes the form. Disposal unregisters the tools and the listener.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [sco gateway](../sco/README.md) — configuration, CLI mapping, and failure behavior.
- [sco-submit](../sco-submit/README.md) — sources, templates, resource-option caching, and expansion rules.
- [Approval subsystem](../../../docs/subsystems/approval.md) — `ask` and `never` policies and answerers.
- [Tool authoring](../../../docs/cookbook/adding-a-tool.md) — canonical results and pre-execute policy.

-----

<a id="model-experience"></a>
## Model Experience

### SSP job tools

#### What the model sees

The [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-experimental-tool-sco) defines the tools. `sco_resource_options` and `sco_job_submit` tell the model to offer machine types and queues as choices and to dry-run first; a dry-run result shows the expanded mounts and startup command in `resolved`. `sco_config_form` tells the model to ask for settings through the form instead of in text, to prefill what the user already said, and to suggest a saved configuration from `sco_sources_list`; its result contains the settings the user confirmed and is submitted with `sco_job_submit`. Read results contain the cluster's JSON; log results contain log text, prefixed with `[earlier output truncated]` when only the tail is kept. A submission or stop the user rejects fails with the approval denial. `sco_job_create` and `sco_job_submit` ask for a one-sentence `description` of the job. `sco_job_watch` tells the model to set the metric source from what the code repository's skills, docs, or logs show, and lists the `logs` parsers and the `wandb` run option.

#### Token effect

The eight job and volume schemas, plus `sco_job_watch` while cluster-monitor is mounted and seven more while sco-submit is mounted, have a fixed per-request cost. Each call appends its arguments and result to tool history; listings and logs are bounded by the gateway's `maxOutputBytes`.

#### KV Cache effect

Unchanged tool schemas retain their existing prefix. Calls append after prior history.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Gateway limits apply** — the [gateway limitations](../sco/README.md#known-limitations-and-deferred-work) bound what the tools can submit and read.
- **No monitoring loop** — the tools read state on request; the cluster monitor polls for the Web client, but waiting for a job to finish or reacting to failures needs repeated calls.
- **Sources take full replacements** — `sco_source_update` replaces every field; there is no partial edit.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
