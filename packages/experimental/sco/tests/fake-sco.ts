import { chmod, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Node script standing in for the sco CLI: records argv and answers by command group, subcommand, and job name. */
const SCRIPT = String.raw`#!/usr/bin/env node
const { appendFileSync } = require('node:fs')
const { join } = require('node:path')
const argv = process.argv.slice(2)
appendFileSync(join(__dirname, 'calls.jsonl'), JSON.stringify(argv) + '\n')
if (argv.includes('afs')) {
  const volume = (id, total, used) => ({ Name: '', ID: id, Type: 'OCEANSTOR', TotalCapacity: total, UsedCapacity: used, State: 'ACTIVE' })
  if (argv.includes('list-dir-quota')) process.stdout.write(JSON.stringify([{ volume: argv.find(arg => arg.startsWith('--instance=')).slice(11), dir: '/data', limit: '10TB' }]))
  else if (require('node:fs').existsSync(join(__dirname, 'volumes.json'))) process.stdout.write(require('node:fs').readFileSync(join(__dirname, 'volumes.json'), 'utf8'))
  else process.stdout.write(JSON.stringify([volume('vol-a', '51200GB', '43TB'), volume('vol-b', '500GB', '16GB'), volume('vol-c', '0GB', '0GB'), { ID: 'vol-d' }]))
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
