---
description: "Weights & Biases metric source for the cluster job monitor: training curves from a run's history."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-cluster-metrics-wandb

English | [中文](README.zh.md)

## Summary

Register the `wandb` metric source with [`ctx.clusterMonitor`](../cluster-monitor/README.md), so a watched SSP job can draw its training curves from a W&B run's history instead of its logs.

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

Mount the plugin beside the cluster monitor and set the `WANDB_API_KEY` credential. A watch then picks `wandb` through `metrics: { kind: 'wandb', options: { run? } }`, the job detail editor, or the monitor's `defaultMetricSource: wandb`.

```yaml
- name: '@deepseek-ai/dsh-experimental-cluster-metrics-wandb'
  config:
    baseUrl: https://api.wandb.ai
```

| Field | Default | Meaning |
|---|---|---|
| `baseUrl` | `https://api.wandb.ai` | W&B API origin; `/graphql` is appended |
| `apiKeyEnv` | `WANDB_API_KEY` | Credential key holding the API key |
| `runUrlHosts` | `['wandb.ai']` | Hosts whose `https://<host>/<entity>/<project>/runs/<id>` URLs in a job log name its run; subdomains match |
| `samples` | `1000` | History rows requested per read (10 to 10000) |
| `timeoutMs` | `20000` | Timeout of one API request (minimum 1000) |

The `run` option takes `entity/project/run-id`, `entity/project/runs/run-id`, or a run URL on an accepted host; without it the source uses the last run URL the job log printed. Each read posts the run's `history(samples)` query and keeps rows with an integer `_step`, taking every finite number whose key does not start with `_` as a value. A missing run, key, project, or run, an HTTP failure, and a GraphQL error each become the row's `metricsError`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

| Source | Responsibility |
|---|---|
| [`src/index.ts`](src/index.ts) | Config, run references, the history query, and the registration |

Registration goes through `ctx.effect`, so unloading the plugin removes the source; watches that name it then record `metricsError` until it is registered again.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Cluster monitor](../cluster-monitor/README.md) — metric sources and the `logs` parsers.
- [Cluster jobs page](../client-ui-cluster-monitor/README.md) — the metric source editor.

-----

<a id="model-experience"></a>
## Model Experience

None, as reads run on the Host poll and their records reach only the Web client.

#### KV Cache effect

No effect; this package contributes no prompt text or tool results.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Sampled history** — W&B samples runs longer than `samples` rows, so curves of long runs are thinned on the server.
- **One key** — every watch reads with the same API key.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer details — click to expand</summary>

The query follows the GraphQL schema the official `wandb` Python client uses for `run.history(samples=...)`, where `history` returns each sampled row as JSON text.

</details>
