/** Form fields of workload settings, their conversion to and from `ScoWorkloadSpec`, and the facts a summary lists. */
import type { ScoWorkloadKind, ScoWorkloadSpec } from '@deepseek-ai/dsh-experimental-sco-submit/types'
import type { ClusterWorkloadKey } from './workload-locales.ts'

/** Integer fields; the form edits them as text. */
export const COUNT_FIELDS = ['podCount', 'gpuCount', 'cpuCount', 'memoryGib', 'shmSizeGib', 'maxAttempts'] as const

/** Text fields copied verbatim. */
const TEXT_FIELDS = [
  'image', 'imageType', 'code', 'ref', 'output', 'workspace', 'queueId', 'machineType', 'priority', 'framework', 'command',
] as const

/** An integer field of the form. */
export type CountField = typeof COUNT_FIELDS[number]
type TextField = typeof TEXT_FIELDS[number]

/** Editable form fields; text and numbers stay strings so inputs stay controlled. */
export type WorkloadDraft = Record<CountField | TextField, string> & {
  /** Selected data source names. */
  data: string[]
  /** `KEY=VALUE` lines. */
  env: string
  enableQueuing: boolean
}

/** Fields a development machine form leaves out because only SSP jobs accept them. */
export const JOB_ONLY: ReadonlySet<keyof WorkloadDraft> = new Set(['framework', 'maxAttempts', 'enableQueuing'])

/**
 * Fill form fields from settings.
 * @param spec - saved or proposed settings.
 * @returns the form fields.
 */
export function draftOf(spec: ScoWorkloadSpec): WorkloadDraft {
  const text = Object.fromEntries(TEXT_FIELDS.map(key => [key, spec[key] ?? ''])) as Record<TextField, string>
  const counts = Object.fromEntries(COUNT_FIELDS.map(key => [key, spec[key] === undefined ? '' : String(spec[key])])) as Record<CountField, string>
  return {
    ...text,
    ...counts,
    data: [...spec.data ?? []],
    env: Object.entries(spec.env ?? {}).map(([key, value]) => `${key}=${value}`).join('\n'),
    enableQueuing: spec.enableQueuing ?? false,
  }
}

/** A form-field failure: an integer field that is not a non-negative integer, or a malformed environment line (1-based). */
export type DraftProblem = { readonly kind: 'number'; readonly field: CountField } | { readonly kind: 'env'; readonly line: number }

/**
 * Build settings from form fields. Blank fields are omitted; numbers and environment lines are checked here, the rest on the Host.
 * @param draft - form fields.
 * @param kind - workload kind; a development machine drops job-only fields.
 * @returns the settings, or the first problem.
 */
export function specOf(
  draft: WorkloadDraft, kind: ScoWorkloadKind,
): { ok: true; spec: ScoWorkloadSpec } | { ok: false; problem: DraftProblem } {
  const spec: Record<string, unknown> = {}
  const keep = (key: keyof WorkloadDraft): boolean => kind === 'job' || !JOB_ONLY.has(key)
  for (const key of TEXT_FIELDS) {
    const value = draft[key].trim()
    if (value !== '' && keep(key)) spec[key] = value
  }
  for (const key of COUNT_FIELDS) {
    const value = draft[key].trim()
    if (value === '' || !keep(key)) continue
    if (!/^\d+$/.test(value)) return { ok: false, problem: { kind: 'number', field: key } }
    spec[key] = Number(value)
  }
  if (draft.data.length > 0) spec.data = [...draft.data]
  const env: Record<string, string> = {}
  const lines = draft.env.split('\n')
  for (const [index, line] of lines.entries()) {
    if (line.trim() === '') continue
    const separator = line.indexOf('=')
    if (separator <= 0) return { ok: false, problem: { kind: 'env', line: index + 1 } }
    env[line.slice(0, separator).trim()] = line.slice(separator + 1).trim()
  }
  if (Object.keys(env).length > 0) spec.env = env
  if (draft.enableQueuing && keep('enableQueuing')) spec.enableQueuing = true
  return { ok: true, spec }
}

/** Summary label key of each settings field, in display order. */
const FACT_LABELS: readonly (readonly [keyof ScoWorkloadSpec, ClusterWorkloadKey])[] = [
  ['image', 'field.image'],
  ['imageType', 'field.imageType'],
  ['code', 'field.code'],
  ['ref', 'field.ref'],
  ['data', 'field.data'],
  ['output', 'field.output'],
  ['workspace', 'field.workspace'],
  ['queueId', 'field.queue'],
  ['machineType', 'field.machineType'],
  ['podCount', 'field.podCount'],
  ['gpuCount', 'field.gpuCount'],
  ['cpuCount', 'field.cpuCount'],
  ['memoryGib', 'field.memoryGib'],
  ['shmSizeGib', 'field.shmSizeGib'],
  ['priority', 'field.priority'],
  ['framework', 'field.framework'],
  ['maxAttempts', 'field.maxAttempts'],
  ['enableQueuing', 'field.enableQueuing'],
  ['command', 'field.command'],
  ['env', 'field.env'],
]

/**
 * List the set fields of settings as label keys and display values.
 * @param spec - settings.
 * @returns one pair per set field, in display order.
 */
export function specFacts(spec: ScoWorkloadSpec): [ClusterWorkloadKey, string][] {
  return FACT_LABELS.flatMap(([field, label]): [ClusterWorkloadKey, string][] => {
    const value = spec[field]
    if (value === undefined) return []
    if (typeof value === 'object') {
      const text = Array.isArray(value) ? value.join(', ') : Object.entries(value).map(([key, item]) => `${key}=${item}`).join(' ')
      return [[label, text]]
    }
    return [[label, String(value)]]
  })
}

/**
 * Suggest a configuration name from free text: lowercase letters, digits, and hyphens.
 * @param text - title or previous name.
 * @returns a name in the configuration grammar, or an empty string when nothing is left.
 */
export function suggestName(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63)
}
