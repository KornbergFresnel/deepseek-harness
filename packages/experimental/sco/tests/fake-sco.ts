import { chmod, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Node script standing in for the sco CLI: records argv and answers by command group, subcommand, job name, and volume. */
const SCRIPT = String.raw`#!/usr/bin/env node
const { appendFileSync } = require('node:fs')
const { join } = require('node:path')
const argv = process.argv.slice(2)
appendFileSync(join(__dirname, 'calls.jsonl'), JSON.stringify(argv) + '\n')
if (argv.includes('afs')) {
  const [resource, verb] = argv.slice(argv.indexOf('afs') + 1)
  const volume = argv[argv.indexOf('-i') + 1]
  if (volume === 'vol-fail') { process.stderr.write('volume not found\n'); process.exit(7) }
  if (verb === 'list' && resource === 'volumes') {
    process.stdout.write([
      '+------+--------------------------------------+---------+---------+------------+--------+',
      '| NAME |                  ID                  |  TOTAL  |  USED   | CREATETIME | STATE  |',
      '|      |                                      | CAPACITY| CAPACITY|            |        |',
      '+------+--------------------------------------+---------+---------+------------+--------+',
      '|      | 019fc675-8a27-7a12-abad-47a872e18d81 | 51200GB | 43TB    | 2026-08-03 | ACTIVE |',
      '|      |                                      |         |         | +0000 UTC  |        |',
      '| team | 019fad51-5ed2-7e37-84d1-d6f19f904219 | 500GB   | 16GB    | 2026-07-29 | ACTIVE |',
      '| new  | 019f8d42-d97f-7cce-82cf-b6413fd0d314 |         | 1GB     | 2026-07-23 | ACTIVE |',
      '| zero | 019f8dc9-4464-757d-ab49-2744c08e2ff4 | 0GB     | 0GB     | 2026-07-23 | ACTIVE |',
      '+------+--------------------------------------+---------+---------+------------+--------+',
      '',
    ].join('\n'))
    return
  }
  process.stdout.write(resource + ' ' + verb + ' ' + argv.slice(argv.indexOf('-i')).join(' ') + '\n')
  return
}
const group = argv[argv.indexOf('ssp') + 1]
const rest = argv.slice(argv.indexOf('ssp') + 2)
const [command, target] = rest
const QUEUES = '/subscriptions/s/resourceGroups/r/regions/cn/clusters/'
if (group === 'workspaces') {
  if (target === 'ws-fail') { process.stderr.write('workspace not found\n'); process.exit(5) }
  process.stdout.write(JSON.stringify({ queues: [{ id: QUEUES + 'c1/queues/gpu-a' }, { id: QUEUES + 'c1/queues/gpu-a', alias: true }, { id: QUEUES + 'c2/queues/cpu-b' }, { note: 'not a queue id' }] }))
  return
}
if (group === 'queues') {
  process.stdout.write(JSON.stringify({ name: rest[2], workloads: [{ spec_code: target === 'c1' ? 'h1ls.rp.k60a' : 'c6.large' }] }))
  return
}
if (rest.includes('job-fail')) { process.stderr.write('job not found\n'); process.exit(3) }
if (rest.includes('job-silent-fail')) { process.stdout.write('quota exceeded\n'); process.exit(4) }
if (rest.includes('job-garbage')) { process.stdout.write('not json'); process.exit(0) }
if (rest.includes('job-flood')) { process.stdout.write('x'.repeat(4096)); process.exit(0) }
if (rest.includes('job-hang')) { setTimeout(() => {}, 60000); return }
if (rest.includes('--machine-type=retired.spec')) { process.stderr.write('machine type retired.spec is not offered by the queue\n'); process.exit(6) }
switch (command) {
  case 'list': process.stdout.write(JSON.stringify({ jobs: [{ name: 'job-a', state: 'RUNNING' }] })); break
  case 'describe': process.stdout.write(JSON.stringify({ name: target, state: 'RUNNING' })); break
  case 'get-workers': process.stdout.write(JSON.stringify([{ name: target + '-worker-0' }])); break
  case 'stream-logs': process.stdout.write('step 1 loss=0.5\n'); break
  case 'create': process.stdout.write(rest.includes('--dry-run') ? JSON.stringify({ name: target, spec: {} }) : 'created ' + target + '\n'); break
  case 'stop': process.stdout.write('stopped\n'); break
  default: process.stderr.write('unknown command\n'); process.exit(2)
}
`

/** A fake sco executable and the argv lists it received. */
export interface FakeSco {
  /** Absolute executable path. */
  command: string
  /** Directory to remove after the test. */
  root: string
  /** Argument lists received so far, excluding the program. */
  calls(): Promise<string[][]>
}

/**
 * Write a fake sco executable into a fresh temporary directory.
 * @returns its path and call log reader.
 */
export async function fakeSco(): Promise<FakeSco> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-sco-')))
  const command = join(root, 'sco')
  await writeFile(command, SCRIPT)
  await chmod(command, 0o755)
  await writeFile(join(root, 'package.json'), '{"type":"commonjs"}\n')
  await writeFile(join(root, 'calls.jsonl'), '')
  return {
    command,
    root,
    async calls() {
      const text = await readFile(join(root, 'calls.jsonl'), 'utf8')
      return text.split('\n').filter(line => line.length > 0).map(line => JSON.parse(line) as string[])
    },
  }
}
