---
description: "The Cluster jobs, Cluster settings, and Job configurations pages, the Session jobs right-sidebar tab, and the in-conversation job and development machine form."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-cluster-monitor

English | [中文](README.zh.md)

## Summary

Add a Cluster jobs entry to the Web sidebar that lists the jobs [`cluster-monitor`](../cluster-monitor/README.md) watches and shows the selected job's state, times, training curves, recent logs, and last job object, and a Cluster settings entry that shows and edits what [`sco-submit`](../sco-submit/README.md) uses to submit jobs. It also adds a Session jobs card and tab to the right sidebar, renders the `sco_config_form` tool call as an editable form in the conversation, and adds a Job configurations entry that manages saved job and development machine configurations.

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

Mount it in the Host configuration beside `cluster-monitor` and `sco-submit`; the Web client loads both pages from the package's client entry.

```yaml
- name: '@deepseek-ai/dsh-experimental-cluster-monitor'
- name: '@deepseek-ai/dsh-experimental-sco-submit'
- name: '@deepseek-ai/dsh-experimental-client-ui-cluster-monitor'
```

The page has a form that watches a job by name, optional workspace, and optional description, the watch list with each job's phase, step, and description, and a detail pane. The detail pane shows the description, or the console display name when there is none, with an editor; shows the metric source with an editor that picks a registered kind, sets the `logs` parsers, step key, and regex patterns, the `wandb` run, or other sources' JSON options, and resets to the configured default; refreshes a job on demand, asks for a second press before it stops watching one, draws one line chart per metric with its step and value ranges, and shows the log tail and the last `describe` output. A lost connection keeps the last values on screen and says that it is reconnecting.

The Cluster settings page shows the sco profile and output mount path, which are set in the Host configuration, and edits the default workspace and queue: a saved value applies at once and at every start for that profile and overrides the Host configuration, an empty field falls back to the configured value, and the queue is chosen from the cached queues when there are any. Below them it lists the registered sources with add, edit, and remove; the add form offers the AFS volumes the sco credentials can see. It also shows the configured templates, the cached queues and machine types of the default workspace with a button that queries them again, and an on-demand table of AFS volumes with their usage. Removing a source asks for a second press, and failures appear under the action that caused them.

When the right sidebar opens, its start page shows a Session jobs card with the jobs the current Session created or watched: their count, how many run and wait, and the first three rows with phase, step, description, and latest metrics. The card and its rows open the Session jobs tab, which lists every such job and shows the same detail pane as the Cluster jobs page. Jobs watched by hand or created before Session attribution belong to no Session and appear only on the Cluster jobs page.

While a `sco_config_form` call waits, its tool row is a form with the image, mounts (code source and ref, data sources, output source), queue and machine type, resource counts, priority, framework, retries, queuing, command, and environment; development machine forms leave out the framework, retry, and queuing fields. A select loads a saved configuration of the same kind, a button loads the one the agent suggested, and a checkbox saves the settings under a name when they are confirmed. Confirm and Cancel answer the call. After the call ends the row lists the confirmed settings and, when they were not saved, offers to save them.

The Job configurations page lists the saved configurations with their kind and description, shows the selected one's settings, raw JSON, and update and last-load times, edits one under its fixed name, creates a job or development machine configuration, and deletes one after a second press.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

| Source | Responsibility |
|---|---|
| [`src/client/mount.ts`](src/client/mount.ts) | Mount the `cluster` and `clusterConfig` Remotes, their dictionaries, `main` pages, sidebar entries, the Session jobs tab type, and the `sco_config_form` tool view |
| [`src/client/source.ts`](src/client/source.ts) | Reconnecting mirrors of the watch list, of one job, of the configuration overview, and of the open configuration forms |
| [`src/client/SessionJobs.tsx`](src/client/SessionJobs.tsx) | The Session jobs guide card, tab, and tab title |
| [`src/client/WorkloadForm.tsx`](src/client/WorkloadForm.tsx) | The job and development machine settings form |
| [`src/client/workload.ts`](src/client/workload.ts) | Form drafts, their conversion to `ScoWorkloadSpec`, and setting summaries |
| [`src/client/FormToolRow.tsx`](src/client/FormToolRow.tsx) | The `sco_config_form` tool row |
| [`src/client/SavedConfigsPage.tsx`](src/client/SavedConfigsPage.tsx) | The Job configurations page |
| [`src/client/workload-locales.ts`](src/client/workload-locales.ts) | `cluster.workload` dictionaries |
| [`src/client/ClusterPage.tsx`](src/client/ClusterPage.tsx) | The list, form, and detail views |
| [`src/client/JobSettings.tsx`](src/client/JobSettings.tsx) | The description and metric source editors |
| [`src/client/chart.ts`](src/client/chart.ts) | Sparkline sampling, scaling, and value formatting |
| [`src/client/locales.ts`](src/client/locales.ts) | `cluster.monitor` dictionaries |
| [`src/client/ConfigPage.tsx`](src/client/ConfigPage.tsx) | Settings sections and the source form |
| [`src/client/config-locales.ts`](src/client/config-locales.ts) | `cluster.config` dictionaries |

The list mirror lives as long as the Client plugin; a job mirror opens when the job is selected and closes when the selection changes. Charts are plain SVG polylines sampled to at most 400 points. The Session jobs views filter the watch-list mirror by the row's `sessionId`. The form mirror lists the forms open in every Session, and each tool row shows only the form with its own call id.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Cluster monitor](../cluster-monitor/README.md) — polling, parsing, and the `cluster` Remote.
- [SSP job composition](../sco-submit/README.md) — sources, templates, cached options, and the `clusterConfig` Remote.

-----

<a id="model-experience"></a>
## Model Experience

None, as a form answer reaches the Session only as the `sco_config_form` tool result, which [`tool-sco`](../tool-sco/README.md#model-experience) describes, and the pages send nothing to a Session.

#### KV Cache effect

No effect.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Fixed chart scale** — each chart spans its own value range on a linear axis, with no zoom, log scale, or overlaid runs.
- **Forms do not create development machines** — sco has no development machine command, so a confirmed development machine form only returns the settings to the agent.
- **Session jobs of delegated agents** — a job submitted by a subagent belongs to the subagent's Session and does not appear in the parent Session's tab.
- **Read-only templates and Host settings** — templates, the profile, and the output mount path are changed in the Host configuration, not on the page.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer details — click to expand</summary>

None.

</details>
