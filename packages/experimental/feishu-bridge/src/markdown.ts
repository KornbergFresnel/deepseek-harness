/** GitHub-flavored Markdown adapted to the Feishu card `markdown` element and split to the card size budget. */

/** A fenced code block opener or closer: three or more backticks or tildes, optionally followed by an info string. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/

/**
 * Adapt Markdown for the Feishu card `markdown` element. Outside code, `<` is
 * escaped so model text is never read as card HTML tags, and images become
 * links because the element only renders uploaded image keys. Code spans and
 * fenced blocks pass through unchanged.
 * @param markdown - assistant or user Markdown.
 * @returns Markdown the card element renders as written.
 */
export function adaptMarkdown(markdown: string): string {
  const lines = markdown.replaceAll('\r\n', '\n').split('\n')
  let fence: string | undefined
  return lines.map((line) => {
    const marker = FENCE.exec(line)?.[1]
    if (fence !== undefined) {
      if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length) fence = undefined
      return line
    }
    if (marker !== undefined) {
      fence = marker
      return line
    }
    return adaptInline(line)
  }).join('\n')
}

/** Adapt one non-code line, leaving inline code spans as written. */
function adaptInline(line: string): string {
  return line.split(/(`+[^`]*`+)/).map((part, index) => index % 2 === 1
    ? part
    : part
      .replaceAll('<', '&#60;')
      .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_match, alt: string, url: string) => (
        /^https?:\/\//.test(url) ? `[${alt === '' ? url : alt}](${url})` : alt
      ))).join('')
}

/**
 * Split Markdown into chunks of at most `limit` characters at line boundaries.
 * A fenced block that must be split is closed at the end of one chunk and
 * reopened with its info string at the start of the next; a line longer than
 * the budget is cut into pieces.
 * @param markdown - Markdown to split.
 * @param limit - positive maximum chunk length in characters, larger than any fence opener.
 * @returns chunks in order; the input itself when it fits.
 */
export function splitMarkdown(markdown: string, limit: number): string[] {
  if (markdown.length <= limit) return [markdown]
  const chunks: string[] = []
  let lines: string[] = []
  let length = 0
  /** The open fenced block: its opener line and its fence marker, which also closes it. */
  let fence: { opener: string; marker: string } | undefined
  const push = (line: string): void => {
    lines.push(line)
    length += line.length + 1
  }
  const close = (): void => {
    if (fence !== undefined) lines.push(fence.marker)
    chunks.push(lines.join('\n'))
    lines = []
    length = 0
    if (fence !== undefined) push(fence.opener)
  }
  for (const raw of markdown.split('\n')) {
    const reserve = fence === undefined ? 0 : fence.marker.length + 1
    const width = Math.max(1, limit - reserve - (fence === undefined ? 0 : fence.opener.length + 1))
    for (const line of hardWrap(raw, width)) {
      const carried = fence === undefined ? 0 : 1
      if (lines.length > carried && length + line.length + 1 + reserve > limit) close()
      push(line)
      const marker = FENCE.exec(line)?.[1]
      if (marker === undefined) continue
      if (fence === undefined) fence = { opener: line.trimEnd(), marker }
      else if (line.trim() === marker && marker[0] === fence.marker[0] && marker.length >= fence.marker.length) fence = undefined
    }
  }
  chunks.push(lines.join('\n'))
  return chunks
}

/** Break one line longer than `width` into width-sized pieces. */
function hardWrap(line: string, width: number): string[] {
  if (line.length <= width) return [line]
  const pieces: string[] = []
  for (let start = 0; start < line.length; start += width) pieces.push(line.slice(start, start + width))
  return pieces
}

/**
 * Bound one text to `limit` characters, marking the cut.
 * @param text - text of any length.
 * @param limit - positive maximum length.
 * @returns the text, or its head followed by an ellipsis.
 */
export function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`
}

/**
 * Render text as a fenced code block whose fence is longer than any backtick run inside it.
 * @param text - literal text.
 * @param language - optional info string.
 * @returns a fenced block.
 */
export function codeBlock(text: string, language = ''): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map(match => match[0].length))
  const fence = '`'.repeat(longest + 1)
  return `${fence}${language}\n${text}\n${fence}`
}
