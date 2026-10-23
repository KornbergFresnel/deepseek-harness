/**
 * Registered data, code, and output sources, configured job templates, cached resource options, template-based SSP submission,
 * and the `clusterConfig` Remote namespace that the cluster configuration page reads and edits.
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { ScoAfsVolume, ScoDefaults, ScoJobCreation } from '@deepseek-ai/dsh-experimental-sco'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { machineTypes, mentions, mountPath, QUEUE_ID, queueIds, RESOURCE_FAILURE, resolveSubmission, sourceName, validSource } from './resolve.ts'
import type {
  ScoConfigOverview, ScoJobSubmitted, ScoJobTemplate, ScoResolvedSubmission, ScoResourceOptions, ScoResourceOptionsRequest,
  ScoSource, ScoSourceSaveRequest, ScoSubmission, SubmitScoJobRequest,
} from './types.ts'

export type * from './types.ts'

/** Job templates and the output mount path. */
export interface Config {
  /** Job templates by name; their source references resolve at submission. */
  templates?: Record<string, ScoJobTemplate>
  /** Container path where every job mounts its output directory. */
  outputMountPath?: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    scoSubmit: ScoSubmit
  }

  interface Events {
    /**
     * A submission created a job; observers can relate the job to its template, code ref, and data.
     * @mode emit
     * @param event - created job name, workspace, and the names it was composed from.
     */
    'sco/job-submitted'(event: ScoJobSubmitted): void
  }
}

const volumeSchema = zod.discriminatedUnion('type', [
  zod.object({ type: zod.literal('afs'), id: zod.string() }),
  zod.object({ type: zod.literal('aoss'), bucket: zod.string(), endpoint: zod.string() }),
])

const sourceSchema = zod.discriminatedUnion('kind', [
  zod.object({
    kind: zod.literal('data'),
    volume: volumeSchema,
    path: zod.string().exactOptional(),
    mountPath: zod.string(),
    description: zod.string().exactOptional(),
  }),
  zod.object({
    kind: zod.literal('code'),
    volume: volumeSchema,
    root: zod.string(),
    mountPath: zod.string(),
    defaultRef: zod.string(),
    setup: zod.string().exactOptional(),
    description: zod.string().exactOptional(),
  }),
  zod.object({ kind: zod.literal('output'), volume: volumeSchema, root: zod.string(), description: zod.string().exactOptional() }),
])

const optionsSchema = zod.object({
  workspace: zod.string(),
  fetchedAt: zod.string(),
  queues: zod.array(zod.object({ id: zod.string(), cluster: zod.string(), queue: zod.string(), detail: zod.json() })),
})

const defaultsSchema = zod.object({ workspace: zod.string().exactOptional(), queueId: zod.string().exactOptional() })

const submitDomain = defineDomain({
  name: 'sco_submit',
  version: 1,
  tables: {
    sources: domainTable<string, ScoSource>(sourceSchema),
    resource_options: domainTable<string, ScoResourceOptions>(optionsSchema),
    defaults: domainTable<string, ScoDefaults>(defaultsSchema),
  },
})

const templateSchema: z<ScoJobTemplate> = z.object({
  description: z.string(),
  image: z.string(),
  imageType: z.union(['OFFICIAL', 'PRIVATE', 'THIRD_PARTY'] as const),
  code: z.string(),
  ref: z.string(),
  data: z.array(z.string()),
  output: z.string(),
  command: z.string(),
  env: z.dict(z.string()),
  framework: z.union(['PYTORCH_DDP', 'MPI', 'RAY_JOB', 'TENSORFLOW_PS', 'FRAMEWORK_CUSTOM'] as const),
  podCount: z.natural(),
  gpuCount: z.natural(),
  cpuCount: z.natural(),
  memoryGib: z.natural(),
  machineType: z.string(),
  rdmaName: z.string(),
  shmSizeGib: z.natural(),
  priority: z.union(['NORMAL', 'HIGH', 'HIGHEST'] as const),
  maxAttempts: z.natural(),
  enableQueuing: z.boolean(),
})

function message(error: unknown): string {
  /* v8 ignore next -- sco and storage failures are Error instances; String() keeps a foreign throw readable. */
  return error instanceof Error ? error.message : String(error)
}

/**
 * Composes SSP jobs from named sources and templates and submits them through `ctx.sco`.
 * Sources, resource options, and the page's default workspace and queue persist in the `sco_submit` storage domain; templates come
 * from config. Saved defaults are applied to `ctx.sco` at start and withdrawn on disposal.
 * Nothing in the `clusterConfig` namespace enters a model request; the model reaches the same records through the SSP job tools.
 */
export class ScoSubmit extends TypertRemoteService {
  static inject = ['sco', 'storageDomain']

  static Config: z<Config> = z.object({
    templates: z.dict(templateSchema).default({}),
    outputMountPath: z.string().default('/outputs'),
  })

  private readonly templates: Readonly<Record<string, ScoJobTemplate>>
  private readonly outputMountPath: string
  private readonly domain: Promise<Domain<typeof submitDomain>>
  private readonly listeners = new Set<() => void>()

  /**
   * @param ctx - Host context providing `sco` and `storageDomain`.
   * @param config - templates and the output mount path.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'scoSubmit', { namespace: 'clusterConfig' })
    // Schema defaults fill both fields.
    const resolved = config as Required<Config>
    this.templates = resolved.templates
    this.outputMountPath = mountPath('outputMountPath', resolved.outputMountPath)
    for (const [name, template] of Object.entries(this.templates)) {
      sourceName('template name', name)
      for (const reference of [template.code, template.output, template.data].flat()) {
        if (reference !== undefined) sourceName(`source name in template "${name}"`, reference)
      }
    }
    this.domain = ctx.storageDomain.open(submitDomain)
    ctx.effect(async () => {
      const domain = await this.domain
      const saved = domain.table('defaults').get(this.defaultsKey())
      if (saved !== undefined) ctx.sco.setDefaults(saved)
      return async () => {
        ctx.sco.setDefaults({})
        await domain.close()
      }
    }, 'sco-submit: open the domain and apply saved defaults; withdraw them and close the domain on disposal')
  }

  /**
   * List registered sources.
   * @returns sources by name.
   */
  async sources(): Promise<Record<string, ScoSource>> {
    return Object.fromEntries((await this.domain).table('sources').entries())
  }

  /**
   * List configured templates.
   * @returns templates by name.
   */
  listTemplates(): Record<string, ScoJobTemplate> {
    return { ...this.templates }
  }

  /** Container path where every job mounts its output directory. */
  get outputPath(): string {
    return this.outputMountPath
  }

  /**
   * Register a new source.
   * @param name - unused source name.
   * @param source - locations to mount.
   */
  async addSource(name: string, source: ScoSource): Promise<void> {
    const table = (await this.domain).table('sources')
    if (table.get(sourceName('source name', name)) !== undefined) throw new Error(`sco-submit: source "${name}" is already registered`)
    await table.put(name, validSource(source))
    this.changed()
  }

  /**
   * Replace a registered source.
   * @param name - registered source name.
   * @param source - new locations.
   */
  async updateSource(name: string, source: ScoSource): Promise<void> {
    const table = (await this.domain).table('sources')
    if (table.get(sourceName('source name', name)) === undefined) throw new Error(`sco-submit: no source named "${name}" is registered`)
    await table.put(name, validSource(source))
    this.changed()
  }

  /**
   * Remove a registered source; templates that name it fail at their next submission.
   * @param name - registered source name.
   */
  async removeSource(name: string): Promise<void> {
    if (!await (await this.domain).table('sources').delete(sourceName('source name', name))) {
      throw new Error(`sco-submit: no source named "${name}" is registered`)
    }
    this.changed()
  }

  /**
   * Read the queues and machine types a workspace offers, querying the CLI only when nothing is cached or on `refresh`.
   * @param request - workspace and refresh.
   * @param signal - cancellation.
   * @returns cached or freshly queried options.
   */
  async resourceOptions(request: ScoResourceOptionsRequest = {}, signal?: AbortSignal): Promise<ScoResourceOptions> {
    const workspace = this.ctx.sco.workspaceOf(request)
    if (workspace === undefined) throw new Error('sco-submit: resource options need a workspace from the request or the sco gateway config')
    const table = (await this.domain).table('resource_options')
    const key = this.optionsKey(workspace)
    const cached = table.get(key)
    if (cached !== undefined && request.refresh !== true) return cached
    const listing = await this.ctx.sco.listQueues({ workspace }, signal)
    const found = queueIds(listing)
    if (found.length === 0) {
      const excerpt = JSON.stringify(listing).slice(0, 600)
      throw new Error(`sco-submit: no queue resource ids (/subscriptions/…/clusters/<cluster>/queues/<queue>) in sco ssp workspaces list-queues ${workspace} output: ${excerpt}`)
    }
    const options: ScoResourceOptions = { workspace, fetchedAt: new Date().toISOString(), queues: found }
    await table.put(key, options)
    this.changed()
    return options
  }

  /**
   * Expand a submission against the registered sources and configured templates without running the CLI.
   * @param request - submission.
   * @returns creation flags and the names they were composed from.
   */
  async resolve(request: SubmitScoJobRequest): Promise<ScoResolvedSubmission> {
    const sources = new Map((await this.domain).table('sources').entries())
    return resolveSubmission(request, { sources, templates: this.templates, outputMountPath: this.outputMountPath })
  }

  /**
   * Expand and submit a job, or validate it with `dryRun`.
   * A machine type absent from cached options fails before the CLI runs; a CLI failure that names a resource
   * field refreshes the cached options before the error propagates.
   * @param request - submission.
   * @param signal - cancellation; a cancelled creation may still have been accepted remotely.
   * @returns the merged `TrainingJob` for a dry run, otherwise the created name and CLI output, each with the flags used.
   */
  async submit(request: SubmitScoJobRequest, signal?: AbortSignal): Promise<ScoSubmission> {
    const resolved = await this.resolve(request)
    const workspace = this.ctx.sco.workspaceOf(resolved.request)
    const machineType = resolved.request.machineType
    if (workspace !== undefined && machineType !== undefined) {
      const cached = (await this.domain).table('resource_options').get(this.optionsKey(workspace))
      const missing = cached === undefined ? undefined : machineType.split(',').find((code: string) => !cached.queues.some(queue => mentions(queue.detail, code)))
      if (missing !== undefined) {
        throw new Error(`sco-submit: machine type ${missing} is not among the resource options cached for workspace ${workspace}; choose a listed one or refresh the options`)
      }
    }
    let creation: ScoJobCreation
    try {
      creation = await this.ctx.sco.createJob(resolved.request, signal)
    } catch (error) {
      if (workspace === undefined || !RESOURCE_FAILURE.test(message(error))) throw error
      try {
        await this.resourceOptions({ workspace, refresh: true }, signal)
      } catch (refresh) {
        throw new Error(`${message(error)}; refreshing resource options also failed: ${message(refresh)}`, { cause: error })
      }
      throw new Error(`${message(error)}; resource options for workspace ${workspace} were refreshed`, { cause: error })
    }
    if (creation.kind === 'dry-run') return { kind: 'dry-run', resolved: resolved.request, job: creation.job }
    this.ctx.emit('sco/job-submitted', {
      name: creation.name,
      ...workspace === undefined ? {} : { workspace },
      ...resolved.template === undefined ? {} : { template: resolved.template },
      ...resolved.code === undefined ? {} : { code: resolved.code },
      data: resolved.data,
      ...resolved.output === undefined ? {} : { output: resolved.output },
    })
    return { kind: 'created', resolved: resolved.request, name: creation.name, output: creation.output }
  }

  /**
   * Read the configuration page state.
   * @returns gateway defaults, sources, templates, and the options cached for the default workspace.
   */
  @Remote
  async overview(): Promise<ScoConfigOverview> {
    const sco = this.ctx.sco
    const workspace = sco.workspaceOf({})
    const domain = await this.domain
    const cached = workspace === undefined ? undefined : domain.table('resource_options').get(this.optionsKey(workspace))
    const byName = <T>(entries: Iterable<[string, T]>) => [...entries].toSorted(([left], [right]) => left.localeCompare(right))
    return {
      ...sco.profile === undefined ? {} : { profile: sco.profile },
      ...workspace === undefined ? {} : { workspace },
      ...sco.queueId === undefined ? {} : { queueId: sco.queueId },
      configured: sco.configuredDefaults,
      saved: domain.table('defaults').get(this.defaultsKey()) ?? {},
      outputMountPath: this.outputMountPath,
      sources: byName(domain.table('sources').entries()).map(([name, source]) => ({ name, source })),
      templates: byName(Object.entries(this.templates)).map(([name, template]) => ({ name, template })),
      ...cached === undefined ? {} : {
        options: {
          workspace: cached.workspace,
          fetchedAt: cached.fetchedAt,
          queues: cached.queues.map(queue => ({ ...queue, machineTypes: machineTypes(queue.detail) })),
        },
      },
    }
  }

  /**
   * Follow the configuration page state: the overview now and after each source or option change.
   * @param signal - stream lifetime.
   * @returns complete overviews.
   */
  @Remote({ mode: 'stream' })
  async *follow(signal: AbortSignal): AsyncIterable<ScoConfigOverview> {
    let wake = Promise.withResolvers<undefined>()
    let dirty = true
    const aborted = (): boolean => signal.aborted
    const notify = (): void => { dirty = true; wake.resolve(undefined) }
    this.listeners.add(notify)
    signal.addEventListener('abort', notify, { once: true })
    try {
      while (!aborted()) {
        if (!dirty) await wake.promise
        if (aborted()) break
        wake = Promise.withResolvers<undefined>()
        dirty = false
        yield await this.overview()
      }
    } finally {
      this.listeners.delete(notify)
      signal.removeEventListener('abort', notify)
    }
  }

  /**
   * Register or replace a source from the configuration page.
   * @param request - source name, locations, and whether to replace a registered source.
   * @returns after the source is stored.
   */
  @Remote
  async saveSource(request: ScoSourceSaveRequest): Promise<void> {
    await (request.replace === true ? this.updateSource(request.name, request.source) : this.addSource(request.name, request.source))
  }

  /**
   * Remove a source from the configuration page.
   * @param name - registered source name.
   * @returns after the source is deleted.
   */
  @Remote
  async deleteSource(name: string): Promise<void> {
    await this.removeSource(name)
  }

  /**
   * Save the default workspace and queue for the current sco profile; they override the gateway config until changed.
   * @param defaults - workspace and full queue id; a blank or absent field falls back to the gateway config, then the sco profile.
   * @returns after the defaults are stored and applied.
   */
  @Remote
  async saveDefaults(defaults: ScoDefaults): Promise<void> {
    const workspace = defaults.workspace?.trim() ?? ''
    const queueId = defaults.queueId?.trim() ?? ''
    if (queueId !== '' && !QUEUE_ID.test(queueId)) {
      throw new Error(`sco-submit: queueId "${queueId}" must be a full queue resource id (/subscriptions/…/clusters/<cluster>/queues/<queue>)`)
    }
    const next: ScoDefaults = { ...workspace === '' ? {} : { workspace }, ...queueId === '' ? {} : { queueId } }
    const table = (await this.domain).table('defaults')
    await (Object.keys(next).length === 0 ? table.delete(this.defaultsKey()) : table.put(this.defaultsKey(), next))
    this.ctx.sco.setDefaults(next)
    this.changed()
  }

  /**
   * Query the queues and machine types of the default workspace again and cache them.
   * @returns after the options are stored.
   */
  @Remote
  async refreshOptions(): Promise<void> {
    await this.resourceOptions({ refresh: true })
  }

  /**
   * List the AFS volumes the sco credentials can see, for choosing where a source lives.
   * @returns volumes with capacity and used percentage.
   */
  @Remote
  volumes(): Promise<ScoAfsVolume[]> {
    return this.ctx.sco.listVolumes()
  }

  private changed(): void {
    for (const listener of this.listeners) listener()
  }

  private defaultsKey(): string {
    return this.ctx.sco.profile ?? ''
  }

  private optionsKey(workspace: string): string {
    return `${this.ctx.sco.profile ?? ''}/${workspace}`
  }
}

export default ScoSubmit
