---
description: "The Cluster jobs and Cluster settings pages: watched SSP jobs with their state, curves, and logs, and the sources, templates, options, and volumes used to submit them."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-cluster-monitor

English | [中文](README.zh.md)

## Summary

Add a Cluster jobs entry to the Web sidebar that lists the jobs [`cluster-monitor`](../cluster-monitor/README.md) watches and shows the selected job's state, times, training curves, recent logs, and last job object, and a Cluster settings entry that shows and edits what [`sco-submit`](../sco-submit/README.md) uses to submit jobs.

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

The page has a form that watches a job by name and optional workspace, the watch list with each job's phase and step, and a detail pane. The detail pane refreshes a job on demand, asks for a second press before it stops watching one, draws one line chart per metric with its step and value ranges, and shows the log tail and the last `describe` output. A lost connection keeps the last values on screen and says that it is reconnecting.

The Cluster settings page shows the sco profile and output mount path, which are set in the Host configuration, and edits the default workspace and queue: a saved value applies at once and at every start for that profile and overrides the Host configuration, an empty field falls back to the configured value, and the queue is chosen from the cached queues when there are any. Below them it lists the registered sources with add, edit, and remove; the add form offers the AFS volumes the sco credentials can see. It also shows the configured templates, the cached queues and machine types of the default workspace with a button that queries them again, and an on-demand table of AFS volumes with their usage. Removing a source asks for a second press, and failures appear under the action that caused them.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

| Source | Responsibility |
|---|---|
| [`src/client/mount.ts`](src/client/mount.ts) | Mount the `cluster` and `clusterConfig` Remotes, their dictionaries, `main` pages, and sidebar entries |
| [`src/client/source.ts`](src/client/source.ts) | Reconnecting mirrors of the watch list, of one job, and of the configuration overview |
| [`src/client/ClusterPage.tsx`](src/client/ClusterPage.tsx) | The list, form, and detail views |
| [`src/client/chart.ts`](src/client/chart.ts) | Sparkline sampling, scaling, and value formatting |
| [`src/client/locales.ts`](src/client/locales.ts) | `cluster.monitor` dictionaries |
| [`src/client/ConfigPage.tsx`](src/client/ConfigPage.tsx) | Settings sections and the source form |
| [`src/client/config-locales.ts`](src/client/config-locales.ts) | `cluster.config` dictionaries |

The list mirror lives as long as the Client plugin; a job mirror opens when the job is selected and closes when the selection changes. Charts are plain SVG polylines sampled to at most 400 points.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Cluster monitor](../cluster-monitor/README.md) — polling, parsing, and the `cluster` Remote.
- [SSP job composition](../sco-submit/README.md) — sources, templates, cached options, and the `clusterConfig` Remote.

-----

<a id="model-experience"></a>
## Model Experience

None, as the page reads Host state only and sends nothing to a Session.

#### KV Cache effect

No effect.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Fixed chart scale** — each chart spans its own value range on a linear axis, with no zoom, log scale, or overlaid runs.
- **Read-only templates and Host settings** — templates, the profile, and the output mount path are changed in the Host configuration, not on the page.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer details — click to expand</summary>

None.

</details>
