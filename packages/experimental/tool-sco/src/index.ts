/** Model tools for SenseCore SSP training jobs, with approval before creation and stop. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-experimental-sco'
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
      imageType: { type: 'string', enum: ['OFFICIAL', 'PRIVATE', 'THIRD_PARTY'] },
      args: { type: 'string', required: true, description: 'Startup command, run with bash -c.' },
      framework: { type: 'string', enum: ['PYTORCH_DDP', 'MPI', 'RAY_JOB', 'TENSORFLOW_PS', 'FRAMEWORK_CUSTOM'], description: 'Defaults to PYTORCH_DDP.' },
      podCount: { type: 'integer', description: 'Pods. Defaults to 1.' },
      gpuCount: { type: 'integer', description: 'GPUs per pod. Defaults to 0.' },
      cpuCount: { type: 'integer', description: 'CPU cores per pod.' },
      memoryGib: { type: 'integer', description: 'Memory per pod in GiB.' },
      machineType: { type: 'string', description: 'Queue machine type code; comma-separate several.' },
      rdmaName: { type: 'string' },
      shmSizeGib: { type: 'integer', description: '/dev/shm per pod in GiB, below memoryGib.' },
      queueId: { type: 'string', description: 'Full queue resource id. Omit to use the configured default.' },
      priority: { type: 'string', enum: ['NORMAL', 'HIGH', 'HIGHEST'] },
      env: { type: 'object', additionalProperties: true, description: 'Environment variables as string values.' },
      volumeMounts: { type: 'array', items: { type: 'string' }, description: 'PV_AFS:<volume-uuid>:<mount-path>[:<subdir>] or PV_AOSS:<bucket>:<mount-path>:<endpoint>[:<prefix>].' },
      maxAttempts: { type: 'integer', description: 'Retries after failure.' },
      enableQueuing: { type: 'boolean', description: 'Wait in queue when quota is insufficient.' },
      tensorboardLogPath: { type: 'string', description: 'TensorBoard log path under a mounted AFS volume.' },
      workspace: WORKSPACE,
      dryRun: { type: 'boolean', description: 'Validate and return the merged TrainingJob without submitting.' },
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
      const env: Record<string, string> = {}
      for (const [key, value] of Object.entries(args.env ?? {})) {
        if (typeof value !== 'string') throw new Error(`env.${key} must be a string`)
        env[key] = value
      }
      return ctx.sco.createJob({ ...args, env }, exec.signal)
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

  if (config.confirmMutations !== false) {
    // Later listeners decide first; an allow from them still needs the user's approval.
    ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
      const downstream = await next()
      if (downstream.kind !== 'allow') return downstream
      const args = exec.arguments as { dryRun?: unknown; name?: unknown; names?: unknown }
      if (exec.name === 'sco_job_create' && args.dryRun !== true) {
        return { kind: 'ask', reason: `submit SSP training job ${String(args.name)}` }
      }
      if (exec.name === 'sco_job_stop') {
        return { kind: 'ask', reason: `stop SSP training jobs ${[args.names].flat().join(', ')}` }
      }
      return downstream
    })
  }
}
