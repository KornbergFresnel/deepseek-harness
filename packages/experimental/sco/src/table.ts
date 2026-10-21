/** Parser for the bordered text tables that `sco afs` commands print instead of JSON. */

/** Row and header separator lines such as `+----+-----+`. */
const BORDER = /^\+[-=+]*\+$/
/** SGR color sequences, in case the CLI colors output despite `SCO_COLOR=no`. */
const SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')

function cells(line: string): string[] {
  return line.slice(1, -1).split('|').map(cell => cell.trim())
}

function append(current: string | undefined, part: string): string {
  return current === undefined || current.length === 0 ? part : `${current} ${part}`
}

/**
 * Parse a bordered table into one record per row.
 * Lines between the first and second border form the header; later `|` lines are rows, and a line whose
 * `key` cell is empty continues the previous row because the CLI wraps long cells at spaces.
 * @param text - CLI stdout.
 * @param key - normalized header of the column that is non-empty on the first line of every row.
 * @returns rows keyed by header lowercased with non-alphanumerics removed, without empty cells;
 * empty output yields no rows, and any other output without a header row or `key` column throws.
 */
export function parseTable(text: string, key: string): Record<string, string>[] {
  const lines = text.replace(SGR, '').split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0)
  const header: string[] = []
  const rows: Record<string, string>[] = []
  let borders = 0
  for (const line of lines) {
    if (BORDER.test(line)) {
      borders += 1
      continue
    }
    if (!line.startsWith('|') || !line.endsWith('|') || borders === 0) continue
    const values = cells(line)
    if (borders === 1) {
      values.forEach((value, index) => { header[index] = append(header[index], value) })
      continue
    }
    if (values.length !== header.length) throw new Error(`sco: table row has ${values.length} cells but the header has ${header.length}: ${line}`)
    const keys = header.map(name => name.toLowerCase().replace(/[^a-z0-9]/g, ''))
    const keyIndex = keys.indexOf(key)
    if (keyIndex < 0) throw new Error(`sco: table has no ${key} column: ${header.join(', ')}`)
    const continued = values[keyIndex] === ''
    const row = continued ? rows.at(-1) : {}
    if (row === undefined) throw new Error(`sco: table row starts with an empty ${key} cell: ${line}`)
    values.forEach((value, index) => {
      if (value !== '') row[keys[index] as string] = append(row[keys[index] as string], value)
    })
    if (!continued) rows.push(row)
  }
  if (header.length === 0 && lines.length > 0) throw new Error(`sco: expected a table but got: ${text.slice(0, 200)}`)
  return rows
}
