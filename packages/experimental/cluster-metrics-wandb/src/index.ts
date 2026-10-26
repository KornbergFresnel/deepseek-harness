/** Weights & Biases metric source for cluster-monitor: training curves from a run's history through the W&B GraphQL API. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-experimental-cluster-monitor'
import type { ClusterMetricProvider, ClusterMetricRecord } from '@deepseek-ai/dsh-experimental-cluster-monitor'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Cordis plugin name. */
export const name = 'cluster-metrics-wandb'
/** Services the source needs: the monitor it registers into and the credential store holding the API key. */
export const inject = ['clusterMonitor', 'credentials']

/** API endpoint, credential, run URL hosts, and read limits. */
export interface Config {
  /** W&B API origin; `/graphql` is appended. */
  baseUrl: string
  /** Credential key holding the W&B API key. */
  apiKeyEnv: string
  /** Hosts whose `https://<host>/<entity>/<project>/runs/<id>` URLs in a job log name its run. */
  runUrlHosts: string[]
  /** History rows requested per read; W&B samples longer runs down to this count. */
  samples: number
  /** Timeout of one API request in milliseconds. */
  timeoutMs: number
}

/** Validated plugin configuration. */
export const Config: z<Config> = z.object({
  baseUrl: z.string().default('https://api.wandb.ai'),
  apiKeyEnv: z.string().role('credential-ref').default('WANDB_API_KEY'),
  runUrlHosts: z.array(z.string().min(1)).default(['wandb.ai']),
  samples: z.natural().min(10).max(10_000).default(1_000),
  timeoutMs: z.natural().min(1_000).default(20_000),
})

/** One W&B run named by entity, project, and run id. */
export interface WandbRun {
  readonly entity: string
  readonly project: string
  readonly run: string
}

const SEGMENT = String.raw`[\w.-]+`
const RUN_PATH = new RegExp(String.raw`^(${SEGMENT})/(${SEGMENT})/(?:runs/)?(${SEGMENT})$`, 'u')
const RUN_URL = new RegExp(String.raw`https?://([\w.-]+(?::\d+)?)/(${SEGMENT})/(${SEGMENT})/runs/(${SEGMENT})`, 'gu')

/** Every capture group in the run patterns participates in any match. */
function group(match: RegExpExecArray, index: number): string {
  return match[index] as string
}

function hostMatches(host: string, hosts: readonly string[]): boolean {
  const bare = host.replace(/:\d+$/u, '').toLowerCase()
  return hosts.some(candidate => bare === candidate.toLowerCase() || bare.endsWith(`.${candidate.toLowerCase()}`))
}

/**
 * Read a run reference: `entity/project/run-id`, `entity/project/runs/run-id`, or a run URL on one of the hosts.
 * @param text - reference text.
 * @param hosts - accepted URL hosts.
 * @returns the run, or undefined when the text names none.
 */
export function parseRun(text: string, hosts: readonly string[]): WandbRun | undefined {
  const trimmed = text.trim()
  const path = RUN_PATH.exec(trimmed)
  if (path !== null) return { entity: group(path, 1), project: group(path, 2), run: group(path, 3) }
  return findRun(trimmed, hosts)
}

/**
 * Find the last run URL on one of the hosts in log text, as `wandb` prints it when a run starts.
 * @param text - log text.
 * @param hosts - accepted URL hosts.
 * @returns the run, or undefined when the log names none.
 */
export function findRun(text: string, hosts: readonly string[]): WandbRun | undefined {
  let found: WandbRun | undefined
  for (const match of text.matchAll(RUN_URL)) {
    if (hostMatches(group(match, 1), hosts)) found = { entity: group(match, 2), project: group(match, 3), run: group(match, 4) }
  }
  return found
}

/**
 * Turn W&B history rows into metric records: `_step` is the step, other finite numbers whose key does not start with `_` are values.
 * @param rows - JSON text of each history row.
 * @returns one record per row with an integer step.
 */
export function historyRecords(rows: readonly string[]): ClusterMetricRecord[] {
  const records: ClusterMetricRecord[] = []
  for (const text of rows) {
    let row: JsonValue
    try {
      row = JSON.parse(text) as JsonValue
    } catch (_malformedRow) {
      // W&B returns each row as JSON text; a row that does not parse carries no usable values.
      continue
    }
    if (typeof row !== 'object' || row === null || Array.isArray(row)) continue
    const step = row['_step']
    if (typeof step !== 'number' || !Number.isSafeInteger(step)) continue
    const values: Record<string, number> = {}
    for (const [key, value] of Object.entries(row)) {
      if (!key.startsWith('_') && typeof value === 'number' && Number.isFinite(value)) values[key] = value
    }
    records.push({ step, values })
  }
  return records
}

const optionsSchema = zod.strictObject({ run: zod.string().min(1).exactOptional() })

const responseSchema = zod.object({
  data: zod.object({
    project: zod.object({ run: zod.object({ history: zod.array(zod.string()) }).nullable() }).nullable(),
  }).nullable().optional(),
  errors: zod.array(zod.object({ message: zod.string() })).optional(),
})

const HISTORY_QUERY = `query RunHistory($entity: String!, $project: String!, $run: String!, $samples: Int) {
  project(name: $project, entityName: $entity) { run(name: $run) { history(samples: $samples) } }
}`

/**
 * Create the `wandb` metric source.
 * @param ctx - context providing `credentials`.
 * @param config - endpoint, credential, hosts, and limits.
 * @returns the provider to register.
 */
export function wandbSource(ctx: Context, config: Config): ClusterMetricProvider {
  const apiKey = credentialRef(config.apiKeyEnv)
  const endpoint = `${config.baseUrl.replace(/\/+$/u, '')}/graphql`
  return {
    validate(options) {
      const parsed = optionsSchema.safeParse(options)
      if (!parsed.success) throw new Error('wandb options take only run, a string')
      if (parsed.data.run !== undefined && parseRun(parsed.data.run, config.runUrlHosts) === undefined) {
        throw new Error(`run "${parsed.data.run}" is neither entity/project/run-id nor a run URL on ${config.runUrlHosts.join(', ')}`)
      }
      return options
    },
    async read(input, signal) {
      const { run: named } = optionsSchema.parse(input.options)
      const run = named === undefined ? findRun(input.logs, config.runUrlHosts) : parseRun(named, config.runUrlHosts)
      if (run === undefined) throw new Error('no W&B run URL in the job log yet; set the run as entity/project/run-id')
      const key = (await ctx.credentials.resolve(apiKey))?.value
      if (key === undefined) throw new Error(`the W&B API key ${config.apiKeyEnv} is not set`)
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Basic ${btoa(`api:${key}`)}` },
        body: JSON.stringify({ query: HISTORY_QUERY, variables: { ...run, samples: config.samples } }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]),
      })
      if (!response.ok) throw new Error(`W&B API answered ${response.status} ${response.statusText}`.trim())
      const body = responseSchema.safeParse(await response.json())
      if (!body.success) throw new Error('W&B API answered with an unexpected body')
      const failure = body.data.errors?.[0]
      if (failure !== undefined) throw new Error(`W&B API: ${failure.message}`)
      const project = body.data.data?.project
      if (project === null || project === undefined) throw new Error(`W&B project ${run.entity}/${run.project} was not found`)
      if (project.run === null) throw new Error(`W&B run ${run.entity}/${run.project}/${run.run} was not found`)
      return historyRecords(project.run.history)
    },
  }
}

/**
 * Register the `wandb` metric source with the cluster monitor.
 * @param ctx - context providing `clusterMonitor` and `credentials`.
 * @param config - endpoint, credential, hosts, and limits.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.effect(() => ctx.clusterMonitor.registerMetricSource('wandb', wandbSource(ctx, config)), 'cluster-metrics-wandb: the wandb metric source')
}
