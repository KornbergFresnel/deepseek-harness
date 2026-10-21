import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ScoGateway from '@deepseek-ai/dsh-experimental-sco'
import type { Config as ScoConfig } from '@deepseek-ai/dsh-experimental-sco'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import ScoSubmit from '../src/index.ts'
import type { Config, ScoCodeSource, ScoJobSubmitted, ScoJobTemplate, ScoSource } from '../src/index.ts'
import { mentions, queueIds, resolveSubmission, validSource } from '../src/resolve.ts'
import { fakeSco } from '../../sco/tests/fake-sco.ts'
import type { FakeSco } from '../../sco/tests/fake-sco.ts'

const cleanup: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true })
})

const DATA: ScoSource = { kind: 'data', volume: { type: 'afs', id: 'vol-data' }, path: 'datasets/lafan', mountPath: '/data/motion', description: 'LAFAN1' }
const CODE: ScoCodeSource = { kind: 'code', volume: { type: 'afs', id: 'vol-code' }, root: 'code/rlh', mountPath: '/workspace/code', defaultRef: 'main', setup: 'pip install -e . --no-deps' }
const OUTPUT: ScoSource = { kind: 'output', volume: { type: 'afs', id: 'vol-out' }, root: 'outputs/wbt' }

const TEMPLATES: Record<string, ScoJobTemplate> = {
  'wbt-train': {
    description: 'whole_body_tracking training',
    image: 'registry/rlh:wbt',
    code: 'rlh',
    data: ['motion'],
    output: 'outputs',
    command: 'python scripts/train.py --headless',
    env: { WANDB_MODE: 'offline', SEED: '1' },
    gpuCount: 8,
    machineType: 'h1ls.rp.k60a',
  },
}

async function boot(options: { sco?: ScoConfig; noWorkspace?: boolean; submit?: Config; root?: string; fake?: FakeSco } = {}) {
  const root = options.root ?? await realpath(await mkdtemp(join(tmpdir(), 'dsh-sco-submit-')))
  if (options.root === undefined) cleanup.push(root)
  const fake = options.fake ?? await fakeSco()
  if (options.fake === undefined) cleanup.push(fake.root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(ScoGateway, { command: fake.command, ...options.noWorkspace === true ? {} : { workspace: 'team-a' }, ...options.sco })
  await ctx.plugin(ScoSubmit, { templates: TEMPLATES, ...options.submit })
  return { ctx, fake, root }
}

describe('source registry', () => {
  it('adds, updates, lists, and removes sources that survive a restart', async () => {
    const first = await boot()
    await first.ctx.scoSubmit.addSource('motion', DATA)
    await first.ctx.scoSubmit.addSource('rlh', CODE)
    await expect(first.ctx.scoSubmit.addSource('motion', DATA)).rejects.toThrow('source "motion" is already registered')
    await first.ctx.scoSubmit.updateSource('motion', { ...DATA, path: 'datasets/lafan-v2' })
    await expect(first.ctx.scoSubmit.updateSource('absent', DATA)).rejects.toThrow('no source named "absent" is registered')
    await expect(first.ctx.scoSubmit.addSource('Bad_Name', DATA)).rejects.toThrow('source name "Bad_Name" must use lowercase letters')
    const restarted = first.ctx
    contexts.splice(contexts.indexOf(restarted), 1)
    await restarted.fiber.dispose()

    const second = await boot({ root: first.root, fake: first.fake })
    expect(await second.ctx.scoSubmit.sources()).toEqual({ motion: { ...DATA, path: 'datasets/lafan-v2' }, rlh: CODE })
    await second.ctx.scoSubmit.removeSource('rlh')
    await expect(second.ctx.scoSubmit.removeSource('rlh')).rejects.toThrow('no source named "rlh" is registered')
    expect(Object.keys(await second.ctx.scoSubmit.sources())).toEqual(['motion'])
    expect(second.ctx.scoSubmit.listTemplates()).toEqual(TEMPLATES)
    expect(second.ctx.scoSubmit.outputPath).toBe('/outputs')
  })

  it('rejects locations that could not form a mount or a startup command', () => {
    const afs = { type: 'afs', id: 'vol' } as const
    for (const [source, text] of [
      [{ ...DATA, volume: { type: 'afs', id: 'a:b' } }, 'volume id "a:b"'],
      [{ ...DATA, volume: { type: 'aoss', bucket: 'Bucket', endpoint: 'oss.local' } }, 'bucket "Bucket"'],
      [{ ...DATA, volume: { type: 'aoss', bucket: 'bucket', endpoint: 'oss.local:9000' } }, 'endpoint "oss.local:9000"'],
      [{ ...DATA, path: '../escape' }, 'path "../escape"'],
      [{ ...DATA, mountPath: 'relative' }, 'mountPath "relative"'],
      [{ ...DATA, mountPath: '/data/$(id)' }, 'mountPath "/data/$(id)"'],
      [{ ...CODE, root: '/abs' }, 'root "/abs"'],
      [{ ...CODE, defaultRef: 'a/b' }, 'defaultRef "a/b"'],
      [{ ...CODE, setup: ' ' }, 'setup must not be empty'],
      [{ kind: 'output', volume: afs, root: 'a/../b' }, 'root "a/../b"'],
    ] as [ScoSource, string][]) {
      expect(() => validSource(source)).toThrow(text)
    }
    const aoss: ScoSource = { kind: 'data', volume: { type: 'aoss', bucket: 'motion', endpoint: 'oss.local' }, mountPath: '/data' }
    expect(validSource(aoss)).toBe(aoss)
    const { setup: _setup, ...bare } = CODE
    expect(validSource(bare)).toMatchObject({ kind: 'code' })
  })

  it('fails loud on invalid configuration', async () => {
    for (const [submit, text] of [
      [{ templates: { 'Bad Name': {} } }, 'template name "Bad Name"'],
      [{ templates: { ok: { code: 'Code!' } } }, 'source name in template "ok" "Code!"'],
      [{ templates: { ok: { data: ['ok', 'x y'] } } }, 'source name in template "ok" "x y"'],
      [{ outputMountPath: 'outputs' }, 'outputMountPath "outputs"'],
    ] as [Config, string][]) {
      await expect(boot({ submit })).rejects.toThrow(text)
    }
  })
})

describe('submission expansion', () => {
  const context = {
    sources: new Map<string, ScoSource>([
      ['motion', DATA],
      ['rlh', CODE],
      ['outputs', OUTPUT],
      ['bucket', { kind: 'data', volume: { type: 'aoss', bucket: 'motion', endpoint: 'oss.local' }, path: 'npz', mountPath: '/data/bucket' }],
      ['raw', { kind: 'data', volume: { type: 'aoss', bucket: 'raw', endpoint: 'oss.local' }, mountPath: '/data/raw' }],
      ['whole', { kind: 'data', volume: { type: 'afs', id: 'vol-whole' }, mountPath: '/data/whole' }],
      ['plain', { kind: 'code', volume: { type: 'afs', id: 'vol-code' }, root: 'code/plain', mountPath: '/code', defaultRef: 'v1' }],
    ]),
    templates: TEMPLATES,
    outputMountPath: '/outputs',
  }

  it('merges the template, mounts sources, and runs the command in the code directory', () => {
    expect(resolveSubmission({ name: 'job-wbt', template: 'wbt-train', ref: 'abc123', extraArgs: '--seed 2', env: { SEED: '2' }, gpuCount: 4, displayName: 'wbt', queueId: '/q', workspace: 'team-b', dryRun: true }, context)).toEqual({
      request: {
        name: 'job-wbt',
        displayName: 'wbt',
        image: 'registry/rlh:wbt',
        gpuCount: 4,
        machineType: 'h1ls.rp.k60a',
        args: 'cd /workspace/code && pip install -e . --no-deps && python scripts/train.py --headless --seed 2',
        queueId: '/q',
        workspace: 'team-b',
        env: { WANDB_MODE: 'offline', SEED: '2' },
        volumeMounts: [
          'PV_AFS:vol-data:/data/motion:datasets/lafan',
          'PV_AFS:vol-code:/workspace/code:code/rlh/abc123',
          'PV_AFS:vol-out:/outputs:outputs/wbt/job-wbt',
        ],
        dryRun: true,
      },
      template: 'wbt-train',
      code: { name: 'rlh', ref: 'abc123' },
      data: ['motion'],
      output: 'outputs',
    })
  })

  it('composes without a template and covers every mount form', () => {
    expect(resolveSubmission({ name: 'job-x', image: 'img', command: 'run', code: 'plain', data: ['bucket', 'raw', 'whole'] }, context)).toEqual({
      request: {
        name: 'job-x',
        image: 'img',
        args: 'cd /code && run',
        volumeMounts: ['PV_AOSS:motion:/data/bucket:oss.local:npz', 'PV_AOSS:raw:/data/raw:oss.local', 'PV_AFS:vol-whole:/data/whole', 'PV_AFS:vol-code:/code:code/plain/v1'],
      },
      code: { name: 'plain', ref: 'v1' },
      data: ['bucket', 'raw', 'whole'],
    })
    expect(resolveSubmission({ name: 'job-y', image: 'img', command: 'echo hi' }, context)).toEqual({ request: { name: 'job-y', image: 'img', args: 'echo hi' }, data: [] })
  })

  it('rejects missing, mistyped, and conflicting references', () => {
    const base = { name: 'job-x', image: 'img', command: 'run' }
    expect(() => resolveSubmission({ ...base, template: 'absent' }, context)).toThrow('no template named "absent" is configured')
    expect(() => resolveSubmission({ name: 'job-x', command: 'run' }, context)).toThrow('image is required')
    expect(() => resolveSubmission({ name: 'job-x', image: 'img' }, context)).toThrow('command is required')
    expect(() => resolveSubmission({ ...base, command: ' ' }, context)).toThrow('command must not be empty')
    expect(() => resolveSubmission({ ...base, data: ['absent'] }, context)).toThrow('no data source named "absent" is registered')
    expect(() => resolveSubmission({ ...base, code: 'motion' }, context)).toThrow('source "motion" is a data source, not a code source')
    expect(() => resolveSubmission({ ...base, data: ['motion', 'motion'] }, context)).toThrow('two sources mount at /data/motion')
    expect(() => resolveSubmission({ ...base, ref: 'main' }, context)).toThrow('ref needs a code source')
    expect(() => resolveSubmission({ ...base, code: 'rlh', ref: '../x' }, context)).toThrow('ref "../x"')
  })

  it('finds queue ids and machine types in untyped CLI JSON', () => {
    const id = '/subscriptions/s/resourceGroups/r/regions/cn/clusters/c1/queues/gpu-a'
    expect(queueIds({ items: [{ id, n: 1, ok: true, none: null }, [id], 'unrelated'] })).toEqual([{ id, cluster: 'c1', queue: 'gpu-a' }])
    expect(mentions({ workloads: [{ spec_code: 'h1' }, 3] }, 'h1')).toBe(true)
    expect(mentions({ workloads: [{ spec_code: 'h1' }, null] }, 'h2')).toBe(false)
  })
})

describe('resource options and submission', () => {
  async function registered(options: Parameters<typeof boot>[0] = {}) {
    const booted = await boot(options)
    for (const [name, source] of [['motion', DATA], ['rlh', CODE], ['outputs', OUTPUT]] as const) await booted.ctx.scoSubmit.addSource(name, source)
    return booted
  }

  it('caches queue options per workspace and queries again only on refresh', async () => {
    const { ctx, fake } = await boot({ sco: { profile: 'pjlab' } })
    const options = await ctx.scoSubmit.resourceOptions()
    expect(options.workspace).toBe('team-a')
    expect(options.queues.map(queue => [queue.id.split('/clusters/')[1], queue.detail])).toEqual([
      ['c1/queues/gpu-a', { name: 'gpu-a', workloads: [{ spec_code: 'h1ls.rp.k60a' }] }],
      ['c2/queues/cpu-b', { name: 'cpu-b', workloads: [{ spec_code: 'c6.large' }] }],
    ])
    expect(await ctx.scoSubmit.resourceOptions()).toEqual(options)
    await ctx.scoSubmit.resourceOptions({ refresh: true })
    expect((await fake.calls()).map(argv => argv.slice(2, 4))).toEqual([
      ['workspaces', 'list-queues'], ['queues', 'get'], ['queues', 'get'],
      ['workspaces', 'list-queues'], ['queues', 'get'], ['queues', 'get'],
    ])
  })

  it('needs a workspace for resource options', async () => {
    const { ctx } = await boot({ noWorkspace: true })
    await expect(ctx.scoSubmit.resourceOptions()).rejects.toThrow('resource options need a workspace')
  })

  it('dry-runs and submits from a template, emitting the composition', async () => {
    const { ctx, fake } = await registered()
    const submitted: ScoJobSubmitted[] = []
    ctx.on('sco/job-submitted', (event) => { submitted.push(event) })
    const dryRun = await ctx.scoSubmit.submit({ name: 'job-wbt', template: 'wbt-train', dryRun: true })
    expect(dryRun).toMatchObject({ kind: 'dry-run', job: { name: 'job-wbt', spec: {} }, resolved: { dryRun: true } })
    const created = await ctx.scoSubmit.submit({ name: 'job-wbt', template: 'wbt-train' })
    expect(created).toMatchObject({ kind: 'created', name: 'job-wbt', output: 'created job-wbt' })
    await ctx.scoSubmit.submit({ name: 'job-bare', image: 'img', command: 'run' })
    expect(submitted).toEqual([
      { name: 'job-wbt', workspace: 'team-a', template: 'wbt-train', code: { name: 'rlh', ref: 'main' }, data: ['motion'], output: 'outputs' },
      { name: 'job-bare', workspace: 'team-a', data: [] },
    ])
    expect((await fake.calls())[1]).toContain('--volume-mount=PV_AFS:vol-out:/outputs:outputs/wbt/job-wbt')
    expect((await ctx.scoSubmit.resolve({ name: 'job-wbt', template: 'wbt-train' })).request.args).toContain('cd /workspace/code')
  })

  it('checks machine types against cached options before the CLI runs', async () => {
    const { ctx, fake } = await registered()
    await ctx.scoSubmit.resourceOptions()
    await expect(ctx.scoSubmit.submit({ name: 'job-wbt', template: 'wbt-train', machineType: 'h1ls.rp.k60a,a100.x' }))
      .rejects.toThrow('machine type a100.x is not among the resource options cached for workspace team-a')
    expect((await ctx.scoSubmit.submit({ name: 'job-wbt', template: 'wbt-train', dryRun: true })).kind).toBe('dry-run')
    expect((await fake.calls()).filter(argv => argv.includes('create'))).toHaveLength(1)
  })

  it('refreshes options when the CLI blames a resource field, and passes other failures through', async () => {
    const { ctx, fake } = await registered()
    await expect(ctx.scoSubmit.submit({ name: 'job-x', image: 'img', command: 'run', machineType: 'retired.spec', gpuCount: 1 }))
      .rejects.toThrow('machine type retired.spec is not offered by the queue; resource options for workspace team-a were refreshed')
    expect((await fake.calls()).some(argv => argv.includes('list-queues'))).toBe(true)
    await expect(ctx.scoSubmit.submit({ name: 'job-fail', image: 'img', command: 'run' })).rejects.toThrow(/job not found$/)
    await expect(ctx.scoSubmit.submit({ name: 'job-silent-fail', image: 'img', command: 'run', workspace: 'ws-fail' }))
      .rejects.toThrow('quota exceeded; refreshing resource options also failed: sco ssp workspaces list-queues failed (5): workspace not found')
  })

  it('passes resource failures through unchanged when no workspace resolves', async () => {
    const { ctx, fake } = await boot({ noWorkspace: true })
    await expect(ctx.scoSubmit.submit({ name: 'job-silent-fail', image: 'img', command: 'run', machineType: 'h1' })).rejects.toThrow(/quota exceeded$/)
    const submitted: ScoJobSubmitted[] = []
    ctx.on('sco/job-submitted', (event) => { submitted.push(event) })
    await ctx.scoSubmit.submit({ name: 'job-ok', image: 'img', command: 'run', machineType: 'h1' })
    expect(submitted).toEqual([{ name: 'job-ok', data: [] }])
    expect((await fake.calls()).map(argv => argv[2])).toEqual(['create', 'create'])
  })
})
