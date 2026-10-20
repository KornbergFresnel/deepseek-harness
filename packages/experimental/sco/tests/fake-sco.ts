import { chmod, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Node script standing in for the sco CLI: records argv and answers by subcommand and job name. */
const SCRIPT = String.raw`#!/usr/bin/env node
const { appendFileSync } = require('node:fs')
const { join } = require('node:path')
const argv = process.argv.slice(2)
appendFileSync(join(__dirname, 'calls.jsonl'), JSON.stringify(argv) + '\n')
const rest = argv.slice(argv.indexOf('jobs') + 1)
const [command, target] = rest
if (rest.includes('job-fail')) { process.stderr.write('job not found\n'); process.exit(3) }
if (rest.includes('job-silent-fail')) { process.stdout.write('quota exceeded\n'); process.exit(4) }
if (rest.includes('job-garbage')) { process.stdout.write('not json'); process.exit(0) }
if (rest.includes('job-flood')) { process.stdout.write('x'.repeat(4096)); process.exit(0) }
if (rest.includes('job-hang')) { setTimeout(() => {}, 60000); return }
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
