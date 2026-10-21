/** Validation of the AFS volume listing that `sco afs volumes list --format=json` prints. */

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
