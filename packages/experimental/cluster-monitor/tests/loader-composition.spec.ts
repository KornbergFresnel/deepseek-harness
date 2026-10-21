import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import ScoGateway from '@deepseek-ai/dsh-experimental-sco'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import ClusterMonitor from '../src/index.ts'
import { fakeSco, type FakeSco } from './fake-sco.ts'

let context: Context | undefined
let root: string | undefined
let fake: FakeSco | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  await fake?.remove()
  fake = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function boot(): Promise<Context> {
  root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-cluster-loader-')))
  fake = await fakeSco()
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-subprocess-local', LocalSubprocessRuntime],
    ['@deepseek-ai/dsh-storage', Storage],
    ['@deepseek-ai/dsh-storage-json', StorageJson],
    ['@deepseek-ai/dsh-storage-domain', StorageDomain],
    ['@deepseek-ai/dsh-experimental-sco', ScoGateway],
    ['@deepseek-ai/dsh-experimental-cluster-monitor', ClusterMonitor],
  ])
  const settings: Record<string, string[]> = {
    '@deepseek-ai/dsh-storage-json': [`root: '${join(root, 'store')}'`],
    '@deepseek-ai/dsh-storage-domain': ['backend: json'],
    '@deepseek-ai/dsh-experimental-sco': [`command: '${fake.command}'`, 'workspace: team-a'],
    '@deepseek-ai/dsh-experimental-cluster-monitor': ['runningPollMs: 600000', 'pendingPollMs: 600000'],
  }
  const config = [...modules.keys()].flatMap(name => [
    `- name: 'cordis:${name}'`,
    ...settings[name] === undefined ? [] : ['  config:', ...settings[name].map(line => `    ${line}`)],
  ]).join('\n') + '\n'
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, config)
  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  for (const [specifier, plugin] of modules) ctx.loader.builtins[specifier] = plugin
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

async function until<T>(read: () => T, accept: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const value = read()
    if (accept(value)) return value
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('condition not reached')
}

describe('cluster monitor through real Loader composition', () => {
  it('watches a job the sco gateway creates, polls it through the CLI, and stops serving on disposal', async () => {
    const ctx = await boot()
    await fake!.job('job-wbt', { name: 'job-wbt', state: 'Running' })
    await fake!.logs('job-wbt', '[step=5]  train/loss=0.75\n')

    ctx.emit('sco/job-created', { name: 'job-wbt', workspace: 'team-a' })
    const [row] = await until(() => ctx.clusterMonitor.list(), rows => rows.length === 1)
    expect(row).toMatchObject({ name: 'job-wbt', workspace: 'team-a', origin: 'created' })
    const detail = await until(() => ctx.clusterMonitor.detail(row!.id), job => job.checkedAt !== undefined)
    expect(detail).toMatchObject({
      phase: 'running', step: 5, latest: { 'train/loss': 0.75 },
      series: [{ name: 'train/loss', points: [{ step: 5, value: 0.75 }] }],
      logTail: '[step=5]  train/loss=0.75\n',
    })
    expect((await fake!.calls()).map(argv => argv.slice(argv.indexOf('jobs') + 1, argv.indexOf('jobs') + 2))).toEqual([['describe'], ['stream-logs']])

    const entry = [...ctx.loader.entries()].find(candidate => candidate.options.name === 'cordis:@deepseek-ai/dsh-experimental-cluster-monitor')
    await entry!.fiber!.dispose()
    expect(ctx.get('clusterMonitor')).toBeUndefined()
  })
})
