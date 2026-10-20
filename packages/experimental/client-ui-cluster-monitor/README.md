---
description: "The Cluster jobs page: watched SSP jobs with their state, training curves, and logs."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-cluster-monitor

English | [中文](README.zh.md)

## Summary

Add a Cluster jobs entry to the Web sidebar that lists the jobs [`cluster-monitor`](../cluster-monitor/README.md) watches and shows the selected job's state, times, training curves, recent logs, and last job object.

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

Mount it in the Host configuration beside `cluster-monitor`; the Web client loads the page from the package's client entry.

```yaml
- name: '@deepseek-ai/dsh-experimental-cluster-monitor'
- name: '@deepseek-ai/dsh-experimental-client-ui-cluster-monitor'
```

The page has a form that watches a job by name and optional workspace, the watch list with each job's phase and step, and a detail pane. The detail pane refreshes a job on demand, asks for a second press before it stops watching one, draws one line chart per metric with its step and value ranges, and shows the log tail and the last `describe` output. A lost connection keeps the last values on screen and says that it is reconnecting.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

| Source | Responsibility |
|---|---|
| [`src/client/mount.ts`](src/client/mount.ts) | Mount the `cluster` Remote, the dictionaries, the `main` page, and the sidebar entry |
| [`src/client/source.ts`](src/client/source.ts) | Reconnecting mirrors of the watch list and of one job |
| [`src/client/ClusterPage.tsx`](src/client/ClusterPage.tsx) | The list, form, and detail views |
| [`src/client/chart.ts`](src/client/chart.ts) | Sparkline sampling, scaling, and value formatting |
| [`src/client/locales.ts`](src/client/locales.ts) | `cluster.monitor` dictionaries |

The list mirror lives as long as the Client plugin; a job mirror opens when the job is selected and closes when the selection changes. Charts are plain SVG polylines sampled to at most 400 points.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Cluster monitor](../cluster-monitor/README.md) — polling, parsing, and the `cluster` Remote.

-----

<a id="model-experience"></a>
## Model Experience

None, as the page reads Host state only and sends nothing to a Session.

#### KV Cache effect

No effect.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Fixed chart scale** — each chart spans its own value range on a linear axis, with no zoom, log scale, or overlaid runs.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer details — click to expand</summary>

None.

</details>
