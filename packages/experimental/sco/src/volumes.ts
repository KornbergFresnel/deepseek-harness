/** Validation of the AFS volume listing that `sco afs volumes list --format=json` prints, and of `sco srm resources list` pages. */

import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ScoAfsVolume } from './types.ts'

/** CLI field names copied into each volume record. */
const FIELDS = {
  name: 'Name', type: 'Type', totalCapacity: 'TotalCapacity', usedCapacity: 'UsedCapacity', region: 'Region', zone: 'Zone', endTime: 'EndTime', state: 'State',
} as const

/** Binary exponents of the capacity units the CLI prints. */
const UNITS: Readonly<Record<string, number>> = { B: 0, KB: 1, MB: 2, GB: 3, TB: 4, PB: 5 }

function capacityBytes(value: string | undefined): number | undefined {
  const match = /^(\d+(?:\.\d+)?)([KMGTP]?B)$/i.exec(value ?? '')
  if (match === null) return undefined
  return Number(match[1]) * 1024 ** (UNITS[(match[2] as string).toUpperCase()] as number)
}

/** SRM resource type of AFS volumes. */
export const AFS_VOLUME_RESOURCE = 'storage.afs.v2.volume'

/**
 * Collect resource names from one `sco srm resources list --format=json` page.
 * @param page - parsed CLI output.
 * @param type - SRM resource `type` to keep.
 * @returns the page's resource ids, and for resources of `type` each `id` (the AFS volume id) mapped to `display_name`, else
 *   `name`, when one is non-empty.
 */
export function parseResourcePage(page: JsonValue, type: string): { ids: string[]; names: Map<string, string> } {
  if (!Array.isArray(page)) throw new Error('sco srm resources list returned JSON that is not an array')
  const ids: string[] = []
  const names = new Map<string, string>()
  const text = (value: JsonValue | undefined): string => (typeof value === 'string' ? value : '')
  for (const entry of page) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new Error(`sco srm resources list returned a non-object entry: ${JSON.stringify(entry)}`)
    ids.push(text(entry.id))
    if (entry.type !== type) continue
    const label = text(entry.display_name) || text(entry.name)
    if (label !== '') names.set(text(entry.id), label)
  }
  return { ids, names }
}

/**
 * Validate the CLI's volume array and add each volume's used percentage.
 * @param listing - parsed CLI output.
 * @returns one record per volume, in CLI order.
 */
export function parseVolumes(listing: JsonValue): ScoAfsVolume[] {
  if (!Array.isArray(listing)) throw new Error('sco afs volumes list returned JSON that is not an array')
  return listing.map((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry) || typeof entry.ID !== 'string' || entry.ID === '') {
      throw new Error(`sco afs volumes list returned an entry without a string ID: ${JSON.stringify(entry)}`)
    }
    const volume: ScoAfsVolume = { id: entry.ID }
    for (const [key, field] of Object.entries(FIELDS) as [keyof typeof FIELDS, string][]) {
      const value = entry[field]
      if (typeof value === 'string' && value !== '') volume[key] = value
    }
    const total = capacityBytes(volume.totalCapacity)
    const used = capacityBytes(volume.usedCapacity)
    if (total !== undefined && used !== undefined && total > 0) volume.usedPercent = Math.round(used / total * 1000) / 10
    return volume
  })
}
