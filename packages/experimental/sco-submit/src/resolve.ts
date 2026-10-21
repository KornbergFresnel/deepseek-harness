/** Source validation and submission expansion into `createJob` flags. */

import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ScoJobTemplate, ScoResolvedSubmission, ScoSource, ScoVolume, SubmitScoJobRequest } from './types.ts'

/** Source and template names. */
const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/
/** Absolute container paths; segments exclude shell metacharacters so paths need no quoting in the startup command. */
const MOUNT_PATH = /^(\/[A-Za-z0-9._-]+)+$/
/** Relative directories inside a volume. */
const SUBPATH = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/
/** Code refs: one directory name. */
const REF = /^[A-Za-z0-9._-]+$/
const VOLUME_ID = /^[A-Za-z0-9-]+$/
const BUCKET = /^[a-z0-9][a-z0-9.-]*$/
/** Endpoint hosts; a port would add a `:` that ends the field in the mount string. */
const ENDPOINT = /^[A-Za-z0-9.-]+$/

/** Resource-option fields a CLI failure may blame. */
export const RESOURCE_FAILURE = /machine|spec|queue|quota|gpu|机型|规格|队列|配额/i

function check(pattern: RegExp, key: string, value: string, rule: string): string {
  if (!pattern.test(value) || value.split('/').includes('..')) throw new Error(`sco-submit: ${key} "${value}" ${rule}`)
  return value
}

/**
 * Reject a source or template name outside the registry grammar.
 * @param key - name kind for the error message.
 * @param value - candidate name.
 * @returns the unchanged name.
 */
export function sourceName(key: string, value: string): string {
  return check(NAME, key, value, 'must use lowercase letters, digits, and hyphens, start with a letter or digit, and have at most 63 characters')
}

/**
 * Reject a container mount path that is relative, contains `..`, or needs quoting.
 * @param key - field name for the error message.
 * @param value - candidate path.
 * @returns the unchanged path.
 */
export function mountPath(key: string, value: string): string {
  return check(MOUNT_PATH, key, value, 'must be an absolute path of letters, digits, ".", "_", "-", and "/"')
}

function subpath(key: string, value: string): string {
  return check(SUBPATH, key, value, 'must be a relative path of letters, digits, ".", "_", "-", and "/" without ".."')
}

function nonEmpty(key: string, value: string): string {
  if (value.trim().length === 0) throw new Error(`sco-submit: ${key} must not be empty`)
  return value
}

function volume(value: ScoVolume): void {
  switch (value.type) {
    case 'afs':
      check(VOLUME_ID, 'volume id', value.id, 'must use letters, digits, and hyphens')
      return
    case 'aoss':
      check(BUCKET, 'bucket', value.bucket, 'must use lowercase letters, digits, ".", and "-"')
      check(ENDPOINT, 'endpoint', value.endpoint, 'must be a host name without a port')
  }
}

/**
 * Reject a source whose locations could not form a valid `--volume-mount` or startup command.
 * @param source - candidate source.
 * @returns the unchanged source.
 */
export function validSource(source: ScoSource): ScoSource {
  volume(source.volume)
  switch (source.kind) {
    case 'data':
      if (source.path !== undefined) subpath('path', source.path)
      mountPath('mountPath', source.mountPath)
      return source
    case 'code':
      subpath('root', source.root)
      mountPath('mountPath', source.mountPath)
      check(REF, 'defaultRef', source.defaultRef, 'must be one directory name of letters, digits, ".", "_", and "-"')
      if (source.setup !== undefined) nonEmpty('setup', source.setup)
      return source
    case 'output':
      subpath('root', source.root)
      return source
  }
}

/** Build one `--volume-mount` value. */
function mount(target: ScoVolume, path: string, subdir: string | undefined): string {
  switch (target.type) {
    case 'afs': return `PV_AFS:${target.id}:${path}${subdir === undefined ? '' : `:${subdir}`}`
    case 'aoss': return `PV_AOSS:${target.bucket}:${path}:${target.endpoint}${subdir === undefined ? '' : `:${subdir}`}`
  }
}

/** Sources, templates, and the output mount path a submission resolves against. */
export interface ResolveContext {
  sources: ReadonlyMap<string, ScoSource>
  templates: Readonly<Record<string, ScoJobTemplate>>
  outputMountPath: string
}

function lookup<K extends ScoSource['kind']>(context: ResolveContext, kind: K, name: string): Extract<ScoSource, { kind: K }> {
  const source = context.sources.get(sourceName(`${kind} source name`, name))
  if (source === undefined) throw new Error(`sco-submit: no ${kind} source named "${name}" is registered`)
  if (source.kind !== kind) throw new Error(`sco-submit: source "${name}" is a ${source.kind} source, not a ${kind} source`)
  return source as Extract<ScoSource, { kind: K }>
}

/**
 * Expand a submission: merge its template, turn sources into mounts, and build the startup command.
 * Request fields override template fields; `env` merges key by key.
 * @param request - submission.
 * @param context - registered sources, configured templates, and the output mount path.
 * @returns creation flags and the names they were composed from.
 */
export function resolveSubmission(request: SubmitScoJobRequest, context: ResolveContext): ScoResolvedSubmission {
  let template: ScoJobTemplate = {}
  if (request.template !== undefined) {
    const found = context.templates[sourceName('template name', request.template)]
    if (found === undefined) throw new Error(`sco-submit: no template named "${request.template}" is configured`)
    template = found
  }
  const { description: _description, ...defaults } = template
  const { template: _template, extraArgs, name, displayName, queueId, workspace, dryRun, ...overrides } = request
  const { code: codeName, ref, data = [], output: outputName, command, env: _env, image, ...resources } = { ...defaults, ...overrides }
  if (image === undefined) throw new Error('sco-submit: image is required from the request or the template')
  if (command === undefined) throw new Error('sco-submit: command is required from the request or the template')
  const mounts = new Map<string, string>()
  const add = (path: string, value: string) => {
    if (mounts.has(path)) throw new Error(`sco-submit: two sources mount at ${path}`)
    mounts.set(path, value)
  }
  for (const source of data.map(item => lookup(context, 'data', item))) {
    add(source.mountPath, mount(source.volume, source.mountPath, source.path))
  }
  const steps: string[] = []
  let code: ScoResolvedSubmission['code']
  if (codeName !== undefined) {
    const source = lookup(context, 'code', codeName)
    const selected = check(REF, 'ref', ref ?? source.defaultRef, 'must be one directory name of letters, digits, ".", "_", and "-"')
    add(source.mountPath, mount(source.volume, source.mountPath, `${source.root}/${selected}`))
    steps.push(`cd ${source.mountPath}`)
    if (source.setup !== undefined) steps.push(source.setup)
    code = { name: codeName, ref: selected }
  } else if (ref !== undefined) {
    throw new Error('sco-submit: ref needs a code source')
  }
  if (outputName !== undefined) {
    const source = lookup(context, 'output', outputName)
    add(context.outputMountPath, mount(source.volume, context.outputMountPath, `${source.root}/${name}`))
  }
  nonEmpty('command', command)
  steps.push(extraArgs === undefined ? command : `${command} ${extraArgs}`)
  const merged = { ...template.env, ...request.env }
  return {
    request: {
      ...resources,
      name,
      ...displayName === undefined ? {} : { displayName },
      image,
      args: steps.join(' && '),
      ...queueId === undefined ? {} : { queueId },
      ...workspace === undefined ? {} : { workspace },
      ...Object.keys(merged).length === 0 ? {} : { env: merged },
      ...mounts.size === 0 ? {} : { volumeMounts: [...mounts.values()] },
      ...dryRun === undefined ? {} : { dryRun },
    },
    ...request.template === undefined ? {} : { template: request.template },
    ...code === undefined ? {} : { code },
    data: [...data],
    ...outputName === undefined ? {} : { output: outputName },
  }
}

/**
 * Collect queue resource ids from an untyped CLI listing.
 * @param listing - `workspaces list-queues` JSON.
 * @returns distinct ids with the cluster and queue names they contain.
 */
export function queueIds(listing: JsonValue): { id: string; cluster: string; queue: string }[] {
  const found = new Map<string, { id: string; cluster: string; queue: string }>()
  const visit = (value: JsonValue): void => {
    if (typeof value === 'string') {
      const match = /^\/subscriptions\/.+\/clusters\/([^/]+)\/queues\/([^/]+)$/.exec(value)
      if (match !== null && !found.has(value)) {
        const [cluster, queue] = match.slice(1) as [string, string]
        found.set(value, { id: value, cluster, queue })
      }
    } else if (Array.isArray(value)) {
      value.forEach(visit)
    } else if (value !== null && typeof value === 'object') {
      Object.values(value).forEach(visit)
    }
  }
  visit(listing)
  return [...found.values()]
}

/**
 * Whether a string value equal to `code` appears anywhere in a JSON value.
 * @param value - queue detail.
 * @param code - machine type code.
 * @returns true when present.
 */
export function mentions(value: JsonValue, code: string): boolean {
  if (typeof value === 'string') return value === code
  if (Array.isArray(value)) return value.some(item => mentions(item, code))
  if (value !== null && typeof value === 'object') return Object.values(value).some(item => mentions(item, code))
  return false
}
