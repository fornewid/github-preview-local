export type LineType = 'ctx' | 'add' | 'del'

export interface DiffLine {
  type: LineType
  oldNo: number | null
  newNo: number | null
  text: string
  noNewline?: boolean
  /** True for context lines revealed by an expander. */
  expanded?: boolean
}

export interface Hunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  section: string
  lines: DiffLine[]
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/

/** Parses the hunk section of a unified diff (everything from the first `@@`). */
export function parseHunks(patch: string): Hunk[] {
  const hunks: Hunk[] = []
  if (!patch) return hunks
  const raw = patch.split('\n')
  if (raw.length && raw[raw.length - 1] === '') raw.pop()
  let cur: Hunk | null = null
  let o = 0
  let n = 0
  for (const l of raw) {
    if (l.startsWith('@@')) {
      const m = HUNK_RE.exec(l)
      if (!m) continue
      cur = {
        oldStart: +m[1],
        oldLines: m[2] === undefined ? 1 : +m[2],
        newStart: +m[3],
        newLines: m[4] === undefined ? 1 : +m[4],
        section: m[5] ?? '',
        lines: [],
      }
      hunks.push(cur)
      o = cur.oldStart
      n = cur.newStart
      continue
    }
    if (!cur) continue
    const c = l[0]
    const text = stripCr(l.slice(1))
    if (c === '+') cur.lines.push({ type: 'add', oldNo: null, newNo: n++, text })
    else if (c === '-') cur.lines.push({ type: 'del', oldNo: o++, newNo: null, text })
    else if (c === '\\') {
      const last = cur.lines[cur.lines.length - 1]
      if (last) last.noNewline = true
    } else cur.lines.push({ type: 'ctx', oldNo: o++, newNo: n++, text })
  }
  return hunks
}

export function stripCr(s: string) {
  return s.endsWith('\r') ? s.slice(0, -1) : s
}

export function splitLines(content: string): string[] {
  if (content === '') return []
  const lines = content.split('\n')
  if (content.endsWith('\n')) lines.pop()
  return lines.map(stripCr)
}
