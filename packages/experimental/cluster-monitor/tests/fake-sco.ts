import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Node script standing in for `sco ssp jobs`: answers describe and stream-logs from files the test writes. */
const SCRIPT = String.raw`#!/usr/bin/env node
const { appendFileSync, existsSync, readFileSync } = require('node:fs')
const { join } = require('node:path')
const argv = process.argv.slice(2)
appendFileSync(join(__dirname, 'calls.jsonl'), JSON.stringify(argv) + '\n')
const rest = argv.slice(argv.indexOf('jobs') + 1)
const [command, target] = rest
const file = join(__dirname, command === 'describe' ? 'jobs' : 'logs', target + (command === 'describe' ? '.json' : '.txt'))
if (!existsSync(file)) { process.stderr.write(command + ' ' + target + ' unavailable\n'); process.exit(3) }
process.stdout.write(readFileSync(file, 'utf8'))
`

/** A fake sco executable whose job objects and logs the test controls. */
export interface FakeSco {
  /** Absolute executable path. */
  readonly command: string
  /** Set the JSON `describe` returns for a job; undefined makes describe fail. */
  job(name: string, value: object | undefined): Promise<void>
  /** Set the text `stream-logs` returns for a job; undefined makes it fail. */
  logs(name: string, text: string | undefined): Promise<void>
  /** Argument lists received so far, excluding the program. */
  calls(): Promise<string[][]>
  /** Remove the directory. */
  remove(): Promise<void>
}

/**
 * Write a fake sco executable into a fresh temporary directory.
 * @returns its controls.
 */
export async function fakeSco(): Promise<FakeSco> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-cluster-sco-')))
  const command = join(root, 'sco')
  await writeFile(command, SCRIPT)
  await chmod(command, 0o755)
  await writeFile(join(root, 'package.json'), '{"type":"commonjs"}\n')
  await writeFile(join(root, 'calls.jsonl'), '')
  await mkdir(join(root, 'jobs'))
  await mkdir(join(root, 'logs'))
  const put = async (path: string, text: string | undefined) => {
    if (text === undefined) await rm(path, { force: true })
    else await writeFile(path, text)
  }
  return {
    command,
    job: (name, value) => put(join(root, 'jobs', `${name}.json`), value === undefined ? undefined : JSON.stringify(value)),
    logs: (name, text) => put(join(root, 'logs', `${name}.txt`), text),
    async calls() {
      const text = await readFile(join(root, 'calls.jsonl'), 'utf8')
      return text.split('\n').filter(line => line.length > 0).map(line => JSON.parse(line) as string[])
    },
    remove: () => rm(root, { recursive: true, force: true }),
  }
}
