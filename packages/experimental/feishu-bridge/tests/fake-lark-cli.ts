import { chmod, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Node script standing in for lark-cli. `event consume <key>` prints
 * `events-<key>.ndjson`, then exits with stderr when `exit-<key>` exists
 * (removing it, so the restarted consumer stays up) or waits for stdin to
 * close. `api` records its stdin body and answers from the control files; a
 * `GET` answers a chat lookup from `chat-api`, or with the name `Research`.
 */
const SCRIPT = String.raw`#!/usr/bin/env node
const fs = require('node:fs')
const { join } = require('node:path')
const argv = process.argv.slice(2)
const record = (entry) => fs.appendFileSync(join(__dirname, 'calls.jsonl'), JSON.stringify(entry) + '\n')
const exists = (name) => fs.existsSync(join(__dirname, name))
if (argv.includes('event')) {
  const key = argv[argv.indexOf('consume') + 1]
  record({ argv })
  if (exists('events-' + key + '.ndjson')) process.stdout.write(fs.readFileSync(join(__dirname, 'events-' + key + '.ndjson'), 'utf8'))
  if (exists('exit-' + key)) {
    fs.rmSync(join(__dirname, 'exit-' + key))
    process.stderr.write('{"ok":false,"error":{"type":"network"}}\n')
    process.exit(4)
  }
  process.stdin.resume()
  process.stdin.on('end', () => process.exit(0))
  return
}
let body = ''
process.stdin.on('data', chunk => { body += chunk })
process.stdin.on('end', () => {
  record(body === '' ? { argv } : { argv, body: JSON.parse(body) })
  if (argv.includes('GET')) {
    process.stdout.write(exists('chat-api') ? fs.readFileSync(join(__dirname, 'chat-api'), 'utf8') : JSON.stringify({ ok: true, data: { name: 'Research' } }))
    return
  }
  if (exists('fail-api')) { process.stderr.write('{"ok":false,"error":{"type":"api","message":"denied"}}\n'); process.exit(1) }
  if (exists('fail-api-quiet')) { process.stdout.write('quota exceeded'); process.exit(2) }
  if (exists('garbage-api')) { process.stdout.write('not json'); return }
  if (exists('envelope-api')) { process.stdout.write(fs.readFileSync(join(__dirname, 'envelope-api'), 'utf8')); return }
  const count = exists('count') ? Number(fs.readFileSync(join(__dirname, 'count'), 'utf8')) + 1 : 1
  fs.writeFileSync(join(__dirname, 'count'), String(count))
  process.stdout.write(JSON.stringify({ ok: true, identity: 'bot', data: argv.includes('POST') ? { message_id: 'om_' + count } : {} }))
})
`

/** One recorded lark-cli invocation. */
export interface FakeLarkCall {
  argv: string[]
  body?: Record<string, unknown>
}

/** A fake lark-cli executable and its control directory. */
export interface FakeLarkCli {
  /** Absolute executable path. */
  command: string
  /** Control and log directory to remove after the test. */
  root: string
  /** Invocations received so far. */
  calls(): Promise<FakeLarkCall[]>
  /** Write one control file. */
  control(name: string, content?: string): Promise<void>
}

/**
 * Write a fake lark-cli into a fresh temporary directory.
 * @returns its path, call log, and control-file writer.
 */
export async function fakeLarkCli(): Promise<FakeLarkCli> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-lark-cli-')))
  const command = join(root, 'lark-cli')
  await writeFile(command, SCRIPT)
  await chmod(command, 0o755)
  await writeFile(join(root, 'package.json'), '{"type":"commonjs"}\n')
  await writeFile(join(root, 'calls.jsonl'), '')
  return {
    command,
    root,
    async calls() {
      const text = await readFile(join(root, 'calls.jsonl'), 'utf8')
      return text.split('\n').filter(line => line.length > 0).map(line => JSON.parse(line) as FakeLarkCall)
    },
    async control(name, content = '') {
      await writeFile(join(root, name), content)
    },
  }
}
