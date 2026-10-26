/** Source validation and submission expansion into `createJob` flags. */

import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {
  ScoJobTemplate, ScoQueueOption, ScoRepoPlan, ScoResolvedSubmission, ScoSource, ScoStoragePlan, ScoStorageSource, ScoVolume,
  SubmitScoJobRequest,
} from './types.ts'

/** Source and template names. */
const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/
/** Absolute container paths; segments exclude shell metacharacters so paths need no quoting in the startup command. */
const MOUNT_PATH = /^(\/[A-Za-z0-9._-]+)+$/
/** Directories inside a volume after leading and trailing `/` are removed; empty is the volume root. */
const SUBPATH = /^([A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*)?$/
/** Code refs: one directory name. */
const REF = /^[A-Za-z0-9._-]+$/
const VOLUME_ID = /^[A-Za-z0-9-]+$/
const BUCKET = /^[a-z0-9][a-z0-9.-]*$/
/** Endpoint hosts; a port would add a `:` that ends the field in the mount string. */
const ENDPOINT = /^[A-Za-z0-9.-]+$/
/** Git clone URLs over HTTP(S), SSH, or scp-like `user@host:path`, without shell metacharacters or quotes. */
const REPO_URL = /^(?:(?:https?|ssh|git):\/\/[A-Za-z0-9._~:@%+/-]+|[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[A-Za-z0-9._~%+/-]+)$/
/** Git branch, tag, or commit names. */
const GIT_REF = /^[A-Za-z0-9._][A-Za-z0-9._/+-]*$/
/** pip requirement specifiers without environment markers, spaces, or quotes. */
const REQUIREMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*(\[[A-Za-z0-9._,-]+\])?([<>=!~]=?[A-Za-z0-9.*+_-]+(,[<>=!~]=?[A-Za-z0-9.*+_-]+)*)?$/
/** `-r <file>` requirement file entries. */
const REQUIREMENT_FILE = /^-r\s+(\S+)$/

/** Full queue resource ids; capture groups are the cluster and queue names. */
export const QUEUE_ID = /^\/subscriptions\/.+\/clusters\/([^/]+)\/queues\/([^/]+)$/

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

/** Strip leading and trailing `/` from a volume directory and reject anything else outside the grammar; `""` is the volume root. */
function subpath(key: string, value: string): string {
  const trimmed = value.trim().replace(/^\/+|\/+$/g, '')
  check(SUBPATH, key, trimmed, 'must be a directory of letters, digits, ".", "_", "-", and "/" without "..", "//", or spaces')
  return trimmed
}

/** The `--volume-mount` subdirectory for directories inside a volume: `/`-prefixed, or undefined for the volume root. */
function volumeDir(...parts: string[]): string | undefined {
  const joined = parts.filter(part => part !== '').join('/')
  return joined === '' ? undefined : `/${joined}`
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
 * Reject a source whose locations could not form a valid `--volume-mount` or startup command, and normalize its volume directories.
 * @param source - candidate source.
 * @returns the source with volume directories stored without leading or trailing `/`; a data `path` naming the volume root is dropped.
 */
export function validSource(source: ScoSource): ScoSource {
  volume(source.volume)
  switch (source.kind) {
    case 'data': {
      const { path, ...rest } = source
      mountPath('mountPath', source.mountPath)
      const dir = path === undefined ? '' : subpath('path', path)
      return dir === '' ? rest : { ...rest, path: dir }
    }
    case 'code':
      mountPath('mountPath', source.mountPath)
      check(REF, 'defaultRef', source.defaultRef, 'must be one directory name of letters, digits, ".", "_", and "-"')
      if (source.setup !== undefined) nonEmpty('setup', source.setup)
      return { ...source, root: subpath('root', source.root) }
    case 'output':
      return { ...source, root: subpath('root', source.root) }
    case 'storage': {
      const { path, ...rest } = source
      mountPath('mountPath', source.mountPath)
      const dir = path === undefined ? '' : subpath('path', path)
      const layout = { reposDir: storageDir('reposDir', source.reposDir), packagesDir: storageDir('packagesDir', source.packagesDir) }
      return dir === '' ? { ...rest, ...layout } : { ...rest, ...layout, path: dir }
    }
  }
}

/** A non-empty directory under a storage mount. */
function storageDir(key: string, value: string): string {
  const dir = subpath(key, value)
  if (dir === '') throw new Error(`sco-submit: ${key} must name a directory under the storage mount`)
  return dir
}

/**
 * Split a repository entry into its clone URL and ref, and name its directory in the storage.
 * @param entry - `<url>` or `<url>#<ref>`.
 * @returns the URL, the optional ref, and the directory name `<repo>` or `<repo>@<ref>` with `/` in the ref written as `_`.
 * @throws Error when the URL or ref is outside the accepted grammar.
 */
export function repoEntry(entry: string): { url: string; ref?: string; dir: string } {
  const [url = '', ref, ...extra] = entry.trim().split('#')
  if (extra.length > 0) throw new Error(`sco-submit: repository "${entry.trim()}" has more than one "#"`)
  check(REPO_URL, 'repository', url, 'must be an http(s), ssh, git, or user@host:path clone URL without spaces or quotes')
  if (ref !== undefined) check(GIT_REF, 'repository ref', ref, 'must be a branch, tag, or commit name')
  const name = url.slice(Math.max(url.lastIndexOf('/'), url.lastIndexOf(':')) + 1).replace(/\.git$/, '')
  check(/^[A-Za-z0-9._-]+$/, 'repository name', name, 'must end the URL as a directory name')
  return { url, ...ref === undefined ? {} : { ref }, dir: ref === undefined ? name : `${name}@${ref.replaceAll('/', '_')}` }
}

/**
 * Reject a package entry that is neither a pip requirement specifier nor `-r <absolute path>`.
 * @param entry - package entry.
 * @returns the pip arguments of the entry.
 */
export function packageArgs(entry: string): string[] {
  const trimmed = entry.trim()
  const file = REQUIREMENT_FILE.exec(trimmed)
  if (file !== null) return ['-r', mountPath('requirements file', file[1] as string)]
  return [check(REQUIREMENT, 'package', trimmed, 'must be a pip requirement such as torch==2.3.0 or numpy>=1.26,<2, or -r <absolute path>')]
}

/** Build one `--volume-mount` value; `subdir` comes from {@link volumeDir}. */
function mount(target: ScoVolume, path: string, subdir: string | undefined): string {
  switch (target.type) {
    case 'afs': return `PV_AFS:${target.id}:${path}${subdir === undefined ? '' : `:${subdir}`}`
    case 'aoss': return `PV_AOSS:${target.bucket}:${path}:${target.endpoint}${subdir === undefined ? '' : `:${subdir}`}`
  }
}

/** Sources, templates, the output mount path, and the commands the startup command prepares storage with. */
export interface ResolveContext {
  sources: ReadonlyMap<string, ScoSource>
  templates: Readonly<Record<string, ScoJobTemplate>>
  outputMountPath: string
  /** Command that runs git in the container. */
  gitCommand: string
  /** Command that runs pip in the container. */
  pipCommand: string
}

/** Quote a value that the grammars above already restrict to characters without `'`. */
function quote(value: string): string {
  return `'${value}'`
}

/** Startup steps that reuse repositories and packages in the storage and download only what it lacks. */
function storageSteps(
  source: ScoStorageSource, repos: readonly ScoRepoPlan[], packages: readonly string[], context: ResolveContext,
): string[] {
  const steps: string[] = []
  if (repos.length > 0) steps.push(`mkdir -p ${quote(`${source.mountPath}/${source.reposDir}`)}`)
  for (const repo of repos) {
    const target = quote(repo.path)
    const partial = `${target}.partial-$$`
    const clone = repo.ref === undefined
      ? `${context.gitCommand} clone --depth 1 ${quote(repo.url)} ${partial}`
      : `${context.gitCommand} clone ${quote(repo.url)} ${partial} && ${context.gitCommand} -C ${partial} checkout -q ${quote(repo.ref)}`
    // A concurrent job may finish the same clone first; its copy is kept and this one discarded.
    steps.push(`if [ ! -d ${target} ]; then rm -rf ${partial} && ${clone} && { [ -d ${target} ] && rm -rf ${partial} || mv ${partial} ${target}; }; fi`)
  }
  if (packages.length > 0) {
    const dir = quote(`${source.mountPath}/${source.packagesDir}`)
    const args = packages.flatMap(packageArgs).map(arg => arg === '-r' ? arg : quote(arg)).join(' ')
    const offline = `${context.pipCommand} install --no-index --find-links ${dir} ${args}`
    steps.push(`{ ${offline} || { mkdir -p ${dir} && ${context.pipCommand} download -d ${dir} ${args} && ${offline}; }; }`)
  }
  return steps
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
  const {
    code: codeName, ref, data = [], output: outputName, storage: storageName, repos = [], packages = [],
    command, env: _env, image, ...resources
  } = { ...defaults, ...overrides }
  if (image === undefined) throw new Error('sco-submit: image is required from the request or the template')
  if (command === undefined) throw new Error('sco-submit: command is required from the request or the template')
  const mounts = new Map<string, string>()
  const add = (path: string, value: string) => {
    if (mounts.has(path)) throw new Error(`sco-submit: two sources mount at ${path}`)
    mounts.set(path, value)
  }
  for (const source of data.map(item => lookup(context, 'data', item))) {
    add(source.mountPath, mount(source.volume, source.mountPath, volumeDir(subpath('path', source.path ?? ''))))
  }
  const steps: string[] = []
  let storage: ScoStoragePlan | undefined
  if (storageName !== undefined) {
    const source = lookup(context, 'storage', storageName)
    add(source.mountPath, mount(source.volume, source.mountPath, volumeDir(subpath('path', source.path ?? ''))))
    const plans = repos.map((entry): ScoRepoPlan => {
      const { dir, ...repo } = repoEntry(entry)
      return { ...repo, path: `${source.mountPath}/${source.reposDir}/${dir}` }
    })
    const paths = new Set(plans.map(plan => plan.path))
    if (paths.size < plans.length) throw new Error('sco-submit: two repositories clone into the same storage directory')
    steps.push(...storageSteps(source, plans, packages, context))
    storage = { name: storageName, repos: plans, packages: packages.map(entry => entry.trim()) }
  } else if (repos.length > 0 || packages.length > 0) {
    throw new Error('sco-submit: repos and packages need a storage source to look them up in and download them into; register the personal storage as a storage source first')
  }
  let code: ScoResolvedSubmission['code']
  if (codeName !== undefined) {
    const source = lookup(context, 'code', codeName)
    const selected = check(REF, 'ref', ref ?? source.defaultRef, 'must be one directory name of letters, digits, ".", "_", and "-"')
    add(source.mountPath, mount(source.volume, source.mountPath, volumeDir(subpath('root', source.root), selected)))
    steps.push(`cd ${source.mountPath}`)
    if (source.setup !== undefined) steps.push(source.setup)
    code = { name: codeName, ref: selected }
  } else if (ref !== undefined) {
    throw new Error('sco-submit: ref needs a code source')
  }
  if (outputName !== undefined) {
    const source = lookup(context, 'output', outputName)
    add(context.outputMountPath, mount(source.volume, context.outputMountPath, volumeDir(subpath('root', source.root), name)))
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
    ...storage === undefined ? {} : { storage },
  }
}

/**
 * Collect queue resource ids from an untyped CLI listing.
 * @param listing - `workspaces list-queues` JSON.
 * @returns distinct ids with the cluster and queue names they contain; `detail` is the object holding the id as its `id`
 *   field, or `{ id }` when the id appears only elsewhere.
 */
export function queueIds(listing: JsonValue): ScoQueueOption[] {
  const found = new Map<string, ScoQueueOption>()
  const owned = new Set<string>()
  const visit = (value: JsonValue, owner?: JsonValue): void => {
    if (typeof value === 'string') {
      const match = QUEUE_ID.exec(value)
      if (match === null || owned.has(value) || (found.has(value) && owner === undefined)) return
      const [cluster, queue] = match.slice(1) as [string, string]
      found.set(value, { id: value, cluster, queue, detail: owner ?? { id: value } })
      if (owner !== undefined) owned.add(value)
    } else if (Array.isArray(value)) {
      value.forEach((item) => { visit(item) })
    } else if (value !== null && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) visit(child, key === 'id' ? value : undefined)
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

/**
 * Collect the machine type codes a queue object names under `spec_code` or `machine_type` keys.
 * @param value - the CLI's queue object.
 * @returns distinct codes in first-seen order.
 */
export function machineTypes(value: JsonValue): string[] {
  const codes = new Set<string>()
  const visit = (node: JsonValue): void => {
    if (Array.isArray(node)) node.forEach(visit)
    else if (node !== null && typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) {
        if ((key === 'spec_code' || key === 'machine_type') && typeof child === 'string') codes.add(child)
        else visit(child)
      }
    }
  }
  visit(value)
  return [...codes]
}
