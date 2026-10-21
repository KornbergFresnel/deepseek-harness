/** Model tools for SenseCore SSP training jobs, AFS volumes, and template-based submission, with approval before creation and stop. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-experimental-sco'
import type { ScoSource, ScoVolume } from '@deepseek-ai/dsh-experimental-sco-submit'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'

/** Cordis plugin name. */
export const name = 'tool-sco'
/** Services required to register and execute the SSP job tools. */
export const inject = ['tools', 'sco']

/** Approval behavior for remote mutations. */
export interface Config {
  /** Ask the user before `sco_job_create` (except dry runs) and `sco_job_stop`. */
  confirmMutations?: boolean
}

/** Validated plugin configuration. */
export const Config: z<Config> = z.object({
  confirmMutations: z.boolean().default(true),
})

const WORKSPACE = { type: 'string', description: 'SSP workspace name. Omit to use the configured default.' } as const
const JOB_NAME = { type: 'string', required: true, description: 'Job name, for example job-wbt-g1-0420.' } as const

const IMAGE_TYPE = { type: 'string', enum: ['OFFICIAL', 'PRIVATE', 'THIRD_PARTY'] } as const
const ENV = { type: 'object', additionalProperties: true, description: 'Environment variables as string values.' } as const
const DRY_RUN = { type: 'boolean', description: 'Validate and return the merged TrainingJob without submitting.' } as const
const QUEUE_ID = { type: 'string', description: 'Full queue resource id. Omit to use the configured default.' } as const
/** Resource flags shared by direct creation and template submission. */
const RESOURCES = {
  framework: { type: 'string', enum: ['PYTORCH_DDP', 'MPI', 'RAY_JOB', 'TENSORFLOW_PS', 'FRAMEWORK_CUSTOM'], description: 'Defaults to PYTORCH_DDP.' },
  podCount: { type: 'integer', description: 'Pods. Defaults to 1.' },
  gpuCount: { type: 'integer', description: 'GPUs per pod. Defaults to 0.' },
  cpuCount: { type: 'integer', description: 'CPU cores per pod.' },
  memoryGib: { type: 'integer', description: 'Memory per pod in GiB.' },
  machineType: { type: 'string', description: 'Queue machine type code; comma-separate several.' },
  rdmaName: { type: 'string' },
  shmSizeGib: { type: 'integer', description: '/dev/shm per pod in GiB, below memoryGib.' },
  priority: { type: 'string', enum: ['NORMAL', 'HIGH', 'HIGHEST'] },
  maxAttempts: { type: 'integer', description: 'Retries after failure.' },
  enableQueuing: { type: 'boolean', description: 'Wait in queue when quota is insufficient.' },
} as const
const SOURCE = {
  name: { type: 'string', required: true, description: 'Source name: lowercase letters, digits, and hyphens.' },
  kind: { type: 'string', required: true, enum: ['data', 'code', 'output'], description: 'data: a dataset mounted at mountPath. code: snapshots under root/<ref>/, mounted at mountPath, where the command runs. output: job outputs under root/<job name>/, mounted at the fixed output path.' },
  volumeType: { type: 'string', required: true, enum: ['afs', 'aoss'] },
  volumeId: { type: 'string', description: 'AFS volume UUID (afs).' },
  bucket: { type: 'string', description: 'AOSS bucket (aoss).' },
  endpoint: { type: 'string', description: 'AOSS endpoint host without port (aoss).' },
  path: { type: 'string', description: 'Directory or prefix inside the volume (data); omit for the volume root.' },
  root: { type: 'string', description: 'Directory inside the volume holding one subdirectory per ref (code) or per job (output).' },
  mountPath: { type: 'string', description: 'Absolute container path (data, code).' },
  defaultRef: { type: 'string', description: 'Ref used when a submission names none (code).' },
  setup: { type: 'string', description: 'Shell command run in the code directory before the job command (code).' },
  description: { type: 'string', description: 'What the source holds.' },
} as const

/** Fields each source kind accepts beyond name, kind, volume, and description. */
const SOURCE_FIELDS = { data: ['path', 'mountPath'], code: ['root', 'mountPath', 'defaultRef', 'setup'], output: ['root'] } as const

interface SourceArgs {
  kind: ScoSource['kind']
  volumeType: ScoVolume['type']
  volumeId?: string
  bucket?: string
  endpoint?: string
  path?: string
  root?: string
  mountPath?: string
  defaultRef?: string
  setup?: string
  description?: string
}

function need(args: SourceArgs, key: 'volumeId' | 'bucket' | 'endpoint' | 'root' | 'mountPath' | 'defaultRef'): string {
  const value = args[key]
  if (value === undefined) throw new Error(`${key} is required for this source`)
  return value
}

/** Build a typed source from flat tool arguments, rejecting fields the kind does not use. */
function sourceOf(args: SourceArgs): ScoSource {
  const accepted: readonly string[] = SOURCE_FIELDS[args.kind]
  for (const key of ['path', 'root', 'mountPath', 'defaultRef', 'setup'] as const) {
    if (args[key] !== undefined && !accepted.includes(key)) throw new Error(`${key} does not apply to ${args.kind} sources`)
  }
  const volume: ScoVolume = args.volumeType === 'afs'
    ? { type: 'afs', id: need(args, 'volumeId') }
    : { type: 'aoss', bucket: need(args, 'bucket'), endpoint: need(args, 'endpoint') }
  const description = args.description === undefined ? {} : { description: args.description }
  switch (args.kind) {
    case 'data':
      return { kind: 'data', volume, mountPath: need(args, 'mountPath'), ...args.path === undefined ? {} : { path: args.path }, ...description }
    case 'code':
      return {
        kind: 'code', volume, root: need(args, 'root'), mountPath: need(args, 'mountPath'), defaultRef: need(args, 'defaultRef'),
        ...args.setup === undefined ? {} : { setup: args.setup }, ...description,
      }
    case 'output':
      return { kind: 'output', volume, root: need(args, 'root'), ...description }
  }
}

/** Reject non-string environment values from model JSON. */
function stringEnv(env: Record<string, unknown> | undefined): Record<string, string> | undefined {
  if (env === undefined) return undefined
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string') throw new Error(`env.${key} must be a string`)
    result[key] = value
  }
  return result
}

const json = (value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }]

/**
 * Register the SSP job tools and the mutation approval gate.
 * @param ctx - tool registry and sco gateway.
 * @param config - approval behavior.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'sco_job_list',
    description: 'List SenseCore SSP training jobs in a workspace, newest first unless orderBy says otherwise. Returns the cluster\'s JSON listing with each job\'s name, state, and queue.',
    parameters: {
      workspace: WORKSPACE,
      pageSize: { type: 'integer', description: 'Jobs per page, 1 to 100. Defaults to 10.' },
      skip: { type: 'integer', description: 'Jobs to skip for paging.' },
      filters: {
        type: 'array',
        description: 'AND-combined filters. name and display_name match by prefix; state, queue_id, priority, and framework match exactly.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            field: { type: 'string', required: true, enum: ['name', 'display_name', 'state', 'queue_id', 'priority', 'framework'] },
            value: { type: 'string', required: true },
          },
        },
      },
      orderBy: { type: 'string', description: 'created_at or duration, prefixed by - for descending; comma-separate several. Defaults to -created_at.' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => json(value) },
    async execute(args, exec) {
      return ctx.sco.listJobs({ ...args, orderBy: args.orderBy ?? '-created_at' }, exec.signal)
    },
    presentCall: args => ({ card: 'generic', title: 'sco_job_list', kind: 'search', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'sco_job_describe',
    description: 'Read one SSP training job\'s full TrainingJob object, including state, spec, and timestamps.',
    parameters: { name: JOB_NAME, workspace: WORKSPACE },
    output: { schema: { type: 'json' }, render: (_args, value) => json(value) },
    async execute(args, exec) {
      return ctx.sco.describeJob(args.name, args, exec.signal)
    },
    presentCall: args => ({ card: 'generic', title: `sco_job_describe ${args.name}`, kind: 'read', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'sco_job_workers',
    description: 'List an SSP training job\'s current workers. Worker names select logs in sco_job_logs.',
    parameters: { name: JOB_NAME, workspace: WORKSPACE },
    output: { schema: { type: 'json' }, render: (_args, value) => json(value) },
    async execute(args, exec) {
      return ctx.sco.listWorkers(args.name, args, exec.signal)
    },
    presentCall: args => ({ card: 'generic', title: `sco_job_workers ${args.name}`, kind: 'read', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'sco_job_logs',
    description: 'Read the current logs of a running SSP training job once, without following. Omit worker to read every worker. Long logs keep only the tail and set truncated.',
    parameters: {
      name: JOB_NAME,
      worker: { type: 'string', description: 'Worker name from sco_job_workers.' },
      container: { type: 'string', description: 'Container name. Omit for the main container.' },
      workspace: WORKSPACE,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string', required: true }, truncated: { type: 'boolean', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: value.truncated ? `[earlier output truncated]\n${value.text}` : value.text }],
    },
    async execute(args, exec) {
      return ctx.sco.readLogs(args.name, args, exec.signal)
    },
    presentCall: args => ({ card: 'generic', title: `sco_job_logs ${args.name}`, kind: 'read', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'sco_job_create',
    description: 'Submit a SenseCore SSP training job. Run with dryRun first to validate and see the merged TrainingJob; a real submission asks the user and fails if the name exists. GPU jobs need machineType; CPU-only jobs need cpuCount and memoryGib.',
    parameters: {
      name: { type: 'string', required: true, description: 'New job name: job- prefix, lowercase letters, digits, and hyphens, at most 32 characters.' },
      displayName: { type: 'string', description: 'Console display name.' },
      image: { type: 'string', required: true, description: 'Container image reference.' },
      imageType: IMAGE_TYPE,
      args: { type: 'string', required: true, description: 'Startup command, run with bash -c.' },
      ...RESOURCES,
      queueId: QUEUE_ID,
      env: ENV,
      volumeMounts: { type: 'array', items: { type: 'string' }, description: 'PV_AFS:<volume-uuid>:<mount-path>[:<subdir>] or PV_AOSS:<bucket>:<mount-path>:<endpoint>[:<prefix>].' },
      tensorboardLogPath: { type: 'string', description: 'TensorBoard log path under a mounted AFS volume.' },
      workspace: WORKSPACE,
      dryRun: DRY_RUN,
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: { kind: { type: 'string', const: 'dry-run', required: true }, job: { type: 'json', required: true } },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', const: 'created', required: true },
              name: { type: 'string', required: true },
              output: { type: 'string', required: true },
            },
          },
        ],
      },
      render: (_args, value) => json(value),
    },
    async execute(args, exec) {
      const { env, ...rest } = args
      const strings = stringEnv(env)
      return ctx.sco.createJob({ ...rest, ...strings === undefined ? {} : { env: strings } }, exec.signal)
    },
    presentCall: args => ({ card: 'generic', title: `sco_job_create ${args.name}${args.dryRun === true ? ' (dry run)' : ''}`, rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'sco_job_stop',
    description: 'Stop one or more SSP training jobs. Asks the user first.',
    parameters: {
      names: { type: 'array', required: true, items: { type: 'string' }, description: '1 to 100 job names.' },
      workspace: WORKSPACE,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { names: { type: 'array', required: true, items: { type: 'string' } }, output: { type: 'string', required: true } },
      },
      render: (_args, value) => json(value),
    },
    async execute(args, exec) {
      return ctx.sco.stopJobs(args.names, args, exec.signal)
    },
    presentCall: args => ({ card: 'generic', title: `sco_job_stop ${args.names.join(' ')}`, rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'sco_volumes_list',
    description: 'List the AFS storage volumes the user\'s sco credentials can see: id, totalCapacity, usedCapacity, usedPercent (binary units, 1TB = 1024GB), region, zone, endTime, and state. Use the id for sco_volume_quota and for data, code, and output sources.',
    parameters: {},
    output: { schema: { type: 'json' }, render: (_args, value) => json(value) },
    async execute(_args, exec) {
      return ctx.sco.listVolumes(exec.signal)
    },
    presentCall: args => ({ card: 'generic', title: 'sco_volumes_list', kind: 'search', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'sco_volume_quota',
    description: 'List the directory quota rules of one AFS volume.',
    parameters: { volume: { type: 'string', required: true, description: 'Volume id from sco_volumes_list.' } },
    output: { schema: { type: 'json' }, render: (_args, value) => json(value) },
    async execute(args, exec) {
      return ctx.sco.listDirectoryQuotas(args.volume, exec.signal)
    },
    presentCall: args => ({ card: 'generic', title: `sco_volume_quota ${args.volume}`, kind: 'read', rawInput: args }),
  }))

  ctx.inject(['scoSubmit'], (scope) => {
    registerSubmissionTools(scope)
  })

  if (config.confirmMutations !== false) {
    // Later listeners decide first; an allow from them still needs the user's approval.
    ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
      const downstream = await next()
      if (downstream.kind !== 'allow') return downstream
      const args = exec.arguments as { dryRun?: unknown; name?: unknown; names?: unknown }
      if ((exec.name === 'sco_job_create' || exec.name === 'sco_job_submit') && args.dryRun !== true) {
        return { kind: 'ask', reason: `submit SSP training job ${String(args.name)}` }
      }
      if (exec.name === 'sco_job_stop') {
        return { kind: 'ask', reason: `stop SSP training jobs ${[args.names].flat().join(', ')}` }
      }
      return downstream
    })
  }
}

/** Register source, resource-option, and template-submission tools while `scoSubmit` is available. */
function registerSubmissionTools(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'sco_sources_list',
    description: 'List registered data, code, and output sources, configured job templates, and the fixed container path where every job mounts its output directory. Call before sco_job_submit to pick names.',
    parameters: {},
    output: { schema: { type: 'json' }, render: (_args, value) => json(value) },
    async execute() {
      return { sources: await ctx.scoSubmit.sources(), templates: ctx.scoSubmit.listTemplates(), outputMountPath: ctx.scoSubmit.outputPath }
    },
    presentCall: args => ({ card: 'generic', title: 'sco_sources_list', kind: 'search', rawInput: args }),
  }))

  for (const [name, verb, description] of [
    ['sco_source_add', 'add', 'Register a new data, code, or output source location on cluster storage. Ask the user for the volume and directory, offering volumes from sco_volumes_list; never guess them.'],
    ['sco_source_update', 'update', 'Replace every field of a registered source.'],
  ] as const) {
    ctx.tools.register(defineTool({
      name,
      description,
      parameters: SOURCE,
      output: { schema: { type: 'object', additionalProperties: false, properties: { name: { type: 'string', required: true }, source: { type: 'json', required: true } } }, render: (_args, value) => json(value) },
      async execute(args) {
        const source = sourceOf(args)
        await (verb === 'add' ? ctx.scoSubmit.addSource(args.name, source) : ctx.scoSubmit.updateSource(args.name, source))
        return { name: args.name, source }
      },
      presentCall: args => ({ card: 'generic', title: `${name} ${args.name}`, rawInput: args }),
    }))
  }

  ctx.tools.register(defineTool({
    name: 'sco_source_remove',
    description: 'Remove a registered source.',
    parameters: { name: { type: 'string', required: true } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { removed: { type: 'string', required: true } } }, render: (_args, value) => json(value) },
    async execute(args) {
      await ctx.scoSubmit.removeSource(args.name)
      return { removed: args.name }
    },
    presentCall: args => ({ card: 'generic', title: `sco_source_remove ${args.name}`, rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'sco_resource_options',
    description: 'Read the queues a workspace can submit to and each queue\'s CLI object, which lists the machine types (spec_code) its workloads accept. Results are cached locally; set refresh only after a submission failed on machine type, queue, or quota, or when the user asks. Offer machine types and queues to the user as choices instead of asking them to type one.',
    parameters: { workspace: WORKSPACE, refresh: { type: 'boolean', description: 'Query the cluster even when options are cached.' } },
    output: { schema: { type: 'json' }, render: (_args, value) => json(value) },
    async execute(args, exec) {
      return ctx.scoSubmit.resourceOptions(args, exec.signal)
    },
    presentCall: args => ({ card: 'generic', title: `sco_resource_options${args.refresh === true ? ' (refresh)' : ''}`, kind: 'search', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'sco_job_submit',
    description: 'Submit an SSP job composed from a template and registered sources: data sources mount at their paths, the code source mounts the chosen ref directory under its root and the command runs there after its setup, and the output source mounts a directory named after the job under its root at the fixed output path. Request fields override the template. Run with dryRun first and show the user the resolved flags; a real submission asks the user. Pick machineType and queueId from sco_resource_options.',
    parameters: {
      name: { type: 'string', required: true, description: 'New job name: job- prefix, lowercase letters, digits, and hyphens, at most 32 characters.' },
      template: { type: 'string', description: 'Template name from sco_sources_list.' },
      image: { type: 'string', description: 'Container image reference; overrides the template.' },
      imageType: IMAGE_TYPE,
      code: { type: 'string', description: 'Code source name.' },
      ref: { type: 'string', description: 'Code ref directory. Omit for the source default.' },
      data: { type: 'array', items: { type: 'string' }, description: 'Data source names.' },
      output: { type: 'string', description: 'Output source name.' },
      command: { type: 'string', description: 'Job command; overrides the template.' },
      extraArgs: { type: 'string', description: 'Arguments appended to the command.' },
      env: ENV,
      ...RESOURCES,
      displayName: { type: 'string', description: 'Console display name.' },
      queueId: QUEUE_ID,
      workspace: WORKSPACE,
      dryRun: DRY_RUN,
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: { kind: { type: 'string', const: 'dry-run', required: true }, resolved: { type: 'json', required: true }, job: { type: 'json', required: true } },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', const: 'created', required: true },
              resolved: { type: 'json', required: true },
              name: { type: 'string', required: true },
              output: { type: 'string', required: true },
            },
          },
        ],
      },
      render: (_args, value) => json(value),
    },
    async execute(args, exec) {
      const { env, ...rest } = args
      const strings = stringEnv(env)
      return ctx.scoSubmit.submit({ ...rest, ...strings === undefined ? {} : { env: strings } }, exec.signal)
    },
    presentCall: args => ({ card: 'generic', title: `sco_job_submit ${args.name}${args.dryRun === true ? ' (dry run)' : ''}`, rawInput: args }),
  }))
}
