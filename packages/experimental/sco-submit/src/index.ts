/**
 * Registered data, code, output, and storage sources, configured job templates, cached resource options, template-based SSP submission,
 * and the `clusterConfig` Remote namespace that the cluster configuration page reads and edits.
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { ScoAfsVolume, ScoCallOrigin, ScoDefaults, ScoJobCreation } from '@deepseek-ai/dsh-experimental-sco'
import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import {
  machineTypes, mentions, mountPath, packageArgs, QUEUE_ID, queueIds, repoEntry, RESOURCE_FAILURE, resolveSubmission, sourceName,
  validSource,
} from './resolve.ts'
import type {
  ScoConfigForm, ScoConfigFormAnswer, ScoConfigFormOutcome, ScoConfigOverview, ScoConfigSaveRequest, ScoJobSubmitted, ScoJobTemplate,
  ScoResolvedSubmission, ScoResourceOptions, ScoResourceOptionsRequest, ScoSavedConfig, ScoSource, ScoSourceSaveRequest, ScoSubmission,
  ScoWorkloadSpec, SubmitScoJobRequest,
} from './types.ts'

export type * from './types.ts'

/** Job templates, the output mount path, and the container commands that prepare storage. */
export interface Config {
  /** Job templates by name; their source references resolve at submission. */
  templates?: Record<string, ScoJobTemplate>
  /** Container path where every job mounts its output directory. */
  outputMountPath?: string
  /** Command that runs git in job containers when a repository is missing from the storage. */
  gitCommand?: string
  /** Command that runs pip in job containers to install packages from the storage and download missing ones. */
  pipCommand?: string
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
  zod.object({
    kind: zod.literal('storage'),
    volume: volumeSchema,
    path: zod.string().exactOptional(),
    mountPath: zod.string(),
    reposDir: zod.string(),
    packagesDir: zod.string(),
    description: zod.string().exactOptional(),
  }),
])

const optionsSchema = zod.object({
  workspace: zod.string(),
  fetchedAt: zod.string(),
  queues: zod.array(zod.object({ id: zod.string(), cluster: zod.string(), queue: zod.string(), detail: zod.json() })),
})

const defaultsSchema = zod.object({ workspace: zod.string().exactOptional(), queueId: zod.string().exactOptional() })

const count = zod.number().int().nonnegative()
const specSchema = zod.strictObject({
  image: zod.string().exactOptional(),
  imageType: zod.enum(['OFFICIAL', 'PRIVATE', 'THIRD_PARTY']).exactOptional(),
  code: zod.string().exactOptional(),
  ref: zod.string().exactOptional(),
  data: zod.array(zod.string()).exactOptional(),
  output: zod.string().exactOptional(),
  storage: zod.string().exactOptional(),
  repos: zod.array(zod.string()).exactOptional(),
  packages: zod.array(zod.string()).exactOptional(),
  command: zod.string().exactOptional(),
  env: zod.record(zod.string(), zod.string()).exactOptional(),
  framework: zod.enum(['PYTORCH_DDP', 'MPI', 'RAY_JOB', 'TENSORFLOW_PS', 'FRAMEWORK_CUSTOM']).exactOptional(),
  podCount: zod.number().int().positive().exactOptional(),
  gpuCount: count.exactOptional(),
  cpuCount: count.exactOptional(),
  memoryGib: count.exactOptional(),
  machineType: zod.string().exactOptional(),
  rdmaName: zod.string().exactOptional(),
  shmSizeGib: count.exactOptional(),
  priority: zod.enum(['NORMAL', 'HIGH', 'HIGHEST']).exactOptional(),
  maxAttempts: count.exactOptional(),
  enableQueuing: zod.boolean().exactOptional(),
  workspace: zod.string().exactOptional(),
  queueId: zod.string().exactOptional(),
})

const savedConfigSchema = zod.object({
  kind: zod.enum(['job', 'devmachine']),
  description: zod.string().exactOptional(),
  spec: specSchema,
  createdAt: zod.string(),
  updatedAt: zod.string(),
  lastUsedAt: zod.string().exactOptional(),
})

const submitDomain = defineDomain({
  name: 'sco_submit',
  version: 1,
  tables: {
    sources: domainTable<string, ScoSource>(sourceSchema),
    resource_options: domainTable<string, ScoResourceOptions>(optionsSchema),
    defaults: domainTable<string, ScoDefaults>(defaultsSchema),
    configs: domainTable<string, ScoSavedConfig>(savedConfigSchema),
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
  storage: z.string(),
  repos: z.array(z.string()),
  packages: z.array(z.string()),
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

/**
 * Validate workload settings that arrive from model JSON or the browser, dropping blank strings and empty lists.
 * @param spec - candidate settings.
 * @returns the settings without blank fields.
 */
export function workloadSpec(spec: ScoWorkloadSpec): ScoWorkloadSpec {
  const parsed = specSchema.safeParse(spec)
  if (!parsed.success) throw new Error(`sco-submit: invalid workload settings: ${zod.prettifyError(parsed.error)}`)
  const kept: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(parsed.data)) {
    if (typeof value === 'string') {
      if (value.trim() !== '') kept[key] = value.trim()
    } else if (Array.isArray(value)) {
      const items = value.map(item => item.trim()).filter(item => item !== '')
      if (items.length > 0) kept[key] = items
    } else {
      kept[key] = value
    }
  }
  // The schema produced every field; only blank strings and empty lists were dropped.
  const result = kept as ScoWorkloadSpec
  if (result.queueId !== undefined && !QUEUE_ID.test(result.queueId)) {
    throw new Error(`sco-submit: queueId "${result.queueId}" must be a full queue resource id (/subscriptions/…/clusters/<cluster>/queues/<queue>)`)
  }
  for (const reference of [result.code, result.output, result.storage, result.data].flat()) {
    if (reference !== undefined) sourceName('source name in workload settings', reference)
  }
  result.repos?.forEach(repoEntry)
  result.packages?.forEach(packageArgs)
  return result
}

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
    gitCommand: z.string().min(1).default('git'),
    pipCommand: z.string().min(1).default('python -m pip'),
  })

  private readonly templates: Readonly<Record<string, ScoJobTemplate>>
  private readonly outputMountPath: string
  private readonly gitCommand: string
  private readonly pipCommand: string
  private readonly domain: Promise<Domain<typeof submitDomain>>
  private readonly listeners = new Set<() => void>()
  private readonly forms = new Map<ToolCallId, {
    form: ScoConfigForm
    settle: (outcome: ScoConfigFormOutcome) => void
    fail: (error: Error) => void
  }>()
  private readonly formListeners = new Set<() => void>()

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
    this.gitCommand = resolved.gitCommand
    this.pipCommand = resolved.pipCommand
    for (const [name, template] of Object.entries(this.templates)) {
      sourceName('template name', name)
      for (const reference of [template.code, template.output, template.storage, template.data].flat()) {
        if (reference !== undefined) sourceName(`source name in template "${name}"`, reference)
      }
      template.repos?.forEach(repoEntry)
      template.packages?.forEach(packageArgs)
    }
    this.domain = ctx.storageDomain.open(submitDomain)
    ctx.effect(async () => {
      const domain = await this.domain
      const saved = domain.table('defaults').get(this.defaultsKey())
      if (saved !== undefined) ctx.sco.setDefaults(saved)
      return async () => {
        for (const pending of this.forms.values()) pending.fail(new Error('sco-submit disposed'))
        ctx.sco.setDefaults({})
        await domain.close()
      }
    }, 'sco-submit: open the domain and apply saved defaults; fail open forms, withdraw the defaults, and close the domain on disposal')
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
    return resolveSubmission(request, {
      sources, templates: this.templates, outputMountPath: this.outputMountPath, gitCommand: this.gitCommand, pipCommand: this.pipCommand,
    })
  }

  /**
   * Expand and submit a job, or validate it with `dryRun`.
   * A machine type absent from cached options fails before the CLI runs; a CLI failure that names a resource
   * field refreshes the cached options before the error propagates.
   * @param request - submission.
   * @param signal - cancellation; a cancelled creation may still have been accepted remotely.
   * @param origin - Session that requested the submission, passed to `createJob`.
   * @returns the merged `TrainingJob` for a dry run, otherwise the created name and CLI output, each with the flags used.
   */
  async submit(request: SubmitScoJobRequest, signal?: AbortSignal, origin: ScoCallOrigin = {}): Promise<ScoSubmission> {
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
      creation = await this.ctx.sco.createJob(resolved.request, signal, origin)
    } catch (error) {
      if (workspace === undefined || !RESOURCE_FAILURE.test(message(error))) throw error
      try {
        await this.resourceOptions({ workspace, refresh: true }, signal)
      } catch (refresh) {
        throw new Error(`${message(error)}; refreshing resource options also failed: ${message(refresh)}`, { cause: error })
      }
      throw new Error(`${message(error)}; resource options for workspace ${workspace} were refreshed`, { cause: error })
    }
    const storage = resolved.storage === undefined ? {} : { storage: resolved.storage }
    if (creation.kind === 'dry-run') return { kind: 'dry-run', resolved: resolved.request, job: creation.job, ...storage }
    this.ctx.emit('sco/job-submitted', {
      name: creation.name,
      ...workspace === undefined ? {} : { workspace },
      ...resolved.template === undefined ? {} : { template: resolved.template },
      ...resolved.code === undefined ? {} : { code: resolved.code },
      data: resolved.data,
      ...resolved.output === undefined ? {} : { output: resolved.output },
      ...resolved.storage === undefined ? {} : { storage: resolved.storage.name },
    })
    return { kind: 'created', resolved: resolved.request, name: creation.name, output: creation.output, ...storage }
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
      configs: byName(domain.table('configs').entries()).map(([name, config]) => ({ name, config })),
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
  follow(signal: AbortSignal): AsyncIterable<ScoConfigOverview> {
    return this.stream(this.listeners, signal, () => this.overview())
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

  /**
   * List saved workload configurations.
   * @returns configurations by name.
   */
  async configs(): Promise<Record<string, ScoSavedConfig>> {
    return Object.fromEntries((await this.domain).table('configs').entries())
  }

  /**
   * Save a workload configuration for later forms to load.
   * @param request - name, kind, settings, and whether to replace a saved configuration of the same name.
   * @returns after the configuration is stored.
   */
  @Remote
  async saveConfig(request: ScoConfigSaveRequest): Promise<void> {
    const name = sourceName('configuration name', request.name.trim())
    const spec = workloadSpec(request.spec)
    const table = (await this.domain).table('configs')
    const existing = table.get(name)
    if (existing !== undefined && request.replace !== true) throw new Error(`sco-submit: configuration "${name}" already exists`)
    const now = new Date().toISOString()
    const description = request.description?.trim() ?? ''
    await table.put(name, {
      kind: request.kind,
      ...description === '' ? {} : { description },
      spec,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      ...existing?.lastUsedAt === undefined ? {} : { lastUsedAt: existing.lastUsedAt },
    })
    this.changed()
  }

  /**
   * Delete a saved workload configuration.
   * @param name - saved configuration name.
   * @returns after the configuration is deleted.
   */
  @Remote
  async deleteConfig(name: string): Promise<void> {
    if (!await (await this.domain).table('configs').delete(name)) throw new Error(`sco-submit: no configuration named "${name}" is saved`)
    this.changed()
  }

  /**
   * Open a configuration form in the chat row of a tool call and wait until the user confirms or cancels it.
   * @param request - tool call, Session, kind, proposed values, and an optional saved configuration to suggest.
   * @param signal - the tool call's lifetime; aborting closes the form and rejects with the abort reason.
   * @returns the confirmed values, with the configuration loaded and the name saved under, or a cancellation.
   */
  async askForm(request: Omit<ScoConfigForm, 'openedAt'>, signal: AbortSignal): Promise<ScoConfigFormOutcome> {
    signal.throwIfAborted()
    if (this.forms.has(request.callId)) throw new Error(`sco-submit: a configuration form for call ${request.callId} is already open`)
    const initial = workloadSpec(request.initial)
    if (request.suggested !== undefined && (await this.domain).table('configs').get(request.suggested) === undefined) {
      throw new Error(`sco-submit: no configuration named "${request.suggested}" is saved`)
    }
    const { promise, resolve, reject } = Promise.withResolvers<ScoConfigFormOutcome>()
    const abort = (): void => { reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    this.forms.set(request.callId, { form: { ...request, initial, openedAt: new Date().toISOString() }, settle: resolve, fail: reject })
    this.formsChanged()
    try {
      return await promise
    } finally {
      signal.removeEventListener('abort', abort)
      this.forms.delete(request.callId)
      this.formsChanged()
    }
  }

  /**
   * Follow the open configuration forms: the list now and after each form opens or closes.
   * @param signal - stream lifetime.
   * @returns complete form lists in opening order.
   */
  @Remote({ mode: 'stream' })
  followForms(signal: AbortSignal): AsyncIterable<ScoConfigForm[]> {
    return this.stream(this.formListeners, signal, () => [...this.forms.values()].map(pending => pending.form))
  }

  /**
   * Answer an open configuration form. A save request stores the confirmed values first; a failed save leaves the form open.
   * @param callId - tool call that opened the form.
   * @param answer - confirmed values with the optional configuration loaded and save name, or a cancellation.
   * @returns after the form closes.
   */
  @Remote
  async answerForm(callId: ToolCallId, answer: ScoConfigFormAnswer): Promise<void> {
    const pending = this.forms.get(callId)
    if (pending === undefined) throw new Error(`sco-submit: no configuration form is open for call ${callId}`)
    if (answer.kind === 'cancelled') {
      pending.settle({ kind: 'cancelled' })
      return
    }
    const spec = workloadSpec(answer.spec)
    const table = (await this.domain).table('configs')
    if (answer.save !== undefined) {
      await this.saveConfig({ name: answer.save.name, kind: pending.form.kind, spec, replace: true,
        ...answer.save.description === undefined ? {} : { description: answer.save.description } })
    }
    const loaded = answer.loaded === undefined ? undefined : table.get(answer.loaded)
    if (answer.loaded !== undefined && loaded !== undefined) {
      await table.put(answer.loaded, { ...loaded, lastUsedAt: new Date().toISOString() })
      this.changed()
    }
    pending.settle({
      kind: 'confirmed',
      workload: pending.form.kind,
      spec,
      ...answer.loaded === undefined ? {} : { loaded: answer.loaded },
      ...answer.save === undefined ? {} : { savedAs: answer.save.name.trim() },
    })
  }

  /** Yield `read()` now and after each burst of notifications on `listeners`, until the signal aborts. */
  private async *stream<T>(listeners: Set<() => void>, signal: AbortSignal, read: () => T | Promise<T>): AsyncIterable<T> {
    let wake = Promise.withResolvers<undefined>()
    let dirty = true
    const aborted = (): boolean => signal.aborted
    const notify = (): void => { dirty = true; wake.resolve(undefined) }
    listeners.add(notify)
    signal.addEventListener('abort', notify, { once: true })
    try {
      while (!aborted()) {
        if (!dirty) await wake.promise
        if (aborted()) break
        wake = Promise.withResolvers<undefined>()
        dirty = false
        yield await read()
      }
    } finally {
      listeners.delete(notify)
      signal.removeEventListener('abort', notify)
    }
  }

  private changed(): void {
    for (const listener of this.listeners) listener()
  }

  private formsChanged(): void {
    for (const listener of this.formListeners) listener()
  }

  private defaultsKey(): string {
    return this.ctx.sco.profile ?? ''
  }

  private optionsKey(workspace: string): string {
    return `${this.ctx.sco.profile ?? ''}/${workspace}`
  }
}

export default ScoSubmit
