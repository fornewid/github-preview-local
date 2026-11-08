import type { DiffLine, Hunk } from './parse'
import { wordDiff, type Range } from './word'

/** Number of lines revealed by a single click on an expander (GitHub: 20). */
export const EXPAND_STEP = 20

export type Expander = 'up' | 'down' | 'all'

export interface GapState {
  /** Lines revealed at the top of the gap ("Expand Down" from the previous hunk). */
  top: number
  /** Lines revealed at the bottom of the gap ("Expand Up" from the next hunk). */
  bottom: number
}

export interface Gap {
  index: number
  oldStart: number
  newStart: number
  /** Number of hidden lines; -1 when unknown (file contents not loaded). */
  size: number
}

export interface HunkRow {
  kind: 'hunk'
  key: string
  gap: number
  text: string
  expanders: Expander[]
  /** Size-0 leading gap: GitHub renders a static "..." */
  dots: boolean
}

export interface LineRow {
  kind: 'line'
  key: string
  line: DiffLine
  words?: Range[] | null
}

export interface SplitRow {
  kind: 'split'
  key: string
  left: DiffLine | null
  right: DiffLine | null
  leftWords?: Range[] | null
  rightWords?: Range[] | null
}

export type UnifiedRow = HunkRow | LineRow
export type SplitViewRow = HunkRow | SplitRow

export function computeGaps(hunks: Hunk[], newTotal: number | null): Gap[] {
  const gaps: Gap[] = []
  if (!hunks.length) return gaps
  const first = hunks[0]
  gaps.push({ index: 0, oldStart: 1, newStart: 1, size: Math.max(0, Math.min(first.oldStart, first.newStart) - 1) })
  for (let i = 1; i < hunks.length; i++) {
    const p = hunks[i - 1]
    const newStart = p.newStart + p.newLines
    gaps.push({ index: i, oldStart: p.oldStart + p.oldLines, newStart, size: Math.max(0, hunks[i].newStart - newStart) })
  }
  const last = hunks[hunks.length - 1]
  const tailNew = last.newStart + last.newLines
  const tailOld = last.oldStart + last.oldLines
  gaps.push({
    index: hunks.length,
    oldStart: tailOld,
    newStart: tailNew,
    size: newTotal == null || last.newLines === 0 ? -1 : Math.max(0, newTotal - tailNew + 1),
  })
  return gaps
}

function remaining(g: Gap, s: GapState | undefined) {
  if (g.size < 0) return 0
  return Math.max(0, g.size - (s?.top ?? 0) - (s?.bottom ?? 0))
}

export function expandersFor(g: Gap, gapsLen: number, s: GapState | undefined): Expander[] {
  const r = remaining(g, s)
  if (r <= 0) return []
  if (g.index === 0) return ['up']
  if (g.index === gapsLen - 1) return ['down']
  return r <= EXPAND_STEP ? ['all'] : ['down', 'up']
}

export function applyExpander(g: Gap, s: GapState | undefined, e: Expander): GapState {
  const cur = { top: s?.top ?? 0, bottom: s?.bottom ?? 0 }
  const r = remaining(g, cur)
  if (e === 'all') return { top: cur.top + r, bottom: cur.bottom }
  if (e === 'down') return { top: cur.top + Math.min(EXPAND_STEP, r), bottom: cur.bottom }
  return { top: cur.top, bottom: cur.bottom + Math.min(EXPAND_STEP, r) }
}

export function expandAll(gaps: Gap[]): Record<number, GapState> {
  const out: Record<number, GapState> = {}
  for (const g of gaps) if (g.size > 0) out[g.index] = { top: g.size, bottom: 0 }
  return out
}

function contextLines(g: Gap, from: number, count: number, newLines: string[] | null, oldLines: string[] | null): DiffLine[] {
  const out: DiffLine[] = []
  for (let k = from; k < from + count; k++) {
    const oldNo = g.oldStart + k
    const newNo = g.newStart + k
    const text = newLines?.[newNo - 1] ?? oldLines?.[oldNo - 1] ?? ''
    out.push({ type: 'ctx', oldNo, newNo, text, expanded: true })
  }
  return out
}

function hunkText(h: Hunk, bottom: number) {
  const os = h.oldStart - bottom
  const ns = h.newStart - bottom
  const ol = h.oldLines + bottom
  const nl = h.newLines + bottom
  return `@@ -${os},${ol} +${ns},${nl} @@${h.section ? ' ' + h.section : ''}`
}

interface Segment {
  type: 'hunk' | 'lines'
  gap?: Gap
  hunk?: Hunk
  bottom?: number
  lines?: DiffLine[]
}

/** Interleaves hunks, revealed context and expander rows. */
function segments(
  hunks: Hunk[],
  gaps: Gap[],
  state: Record<number, GapState>,
  newLines: string[] | null,
  oldLines: string[] | null,
): Segment[] {
  const segs: Segment[] = []
  for (let i = 0; i < gaps.length; i++) {
    const g = gaps[i]
    const s = state[i]
    const top = Math.min(s?.top ?? 0, Math.max(g.size, 0))
    const bottom = Math.min(s?.bottom ?? 0, Math.max(g.size - top, 0))
    if (top > 0) segs.push({ type: 'lines', lines: contextLines(g, 0, top, newLines, oldLines) })
    const r = remaining(g, { top, bottom })
    const isTail = i === gaps.length - 1
    const showRow = r > 0 || (g.index === 0 && g.size === 0)
    if (showRow) segs.push({ type: 'hunk', gap: g, hunk: isTail ? undefined : hunks[i], bottom })
    if (bottom > 0) segs.push({ type: 'lines', lines: contextLines(g, g.size - bottom, bottom, newLines, oldLines) })
    if (!isTail) segs.push({ type: 'lines', lines: hunks[i].lines })
  }
  return segs
}

function hunkRow(seg: Segment, gaps: Gap[], state: Record<number, GapState>): HunkRow {
  const g = seg.gap!
  return {
    kind: 'hunk',
    key: `h${g.index}`,
    gap: g.index,
    text: seg.hunk ? hunkText(seg.hunk, seg.bottom ?? 0) : '',
    expanders: expandersFor(g, gaps.length, state[g.index]),
    dots: g.index === 0 && g.size === 0,
  }
}

/** Splits a run of lines into context lines and change blocks (dels + adds). */
function blocks(lines: DiffLine[]) {
  const out: Array<{ ctx: DiffLine } | { dels: DiffLine[]; adds: DiffLine[] }> = []
  let i = 0
  while (i < lines.length) {
    if (lines[i].type === 'ctx') {
      out.push({ ctx: lines[i] })
      i++
      continue
    }
    const dels: DiffLine[] = []
    const adds: DiffLine[] = []
    while (i < lines.length && lines[i].type !== 'ctx') {
      if (lines[i].type === 'del') dels.push(lines[i])
      else adds.push(lines[i])
      i++
    }
    out.push({ dels, adds })
  }
  return out
}

export function buildUnified(
  hunks: Hunk[],
  gaps: Gap[],
  state: Record<number, GapState>,
  newLines: string[] | null,
  oldLines: string[] | null,
): UnifiedRow[] {
  const rows: UnifiedRow[] = []
  for (const seg of segments(hunks, gaps, state, newLines, oldLines)) {
    if (seg.type === 'hunk') {
      rows.push(hunkRow(seg, gaps, state))
      continue
    }
    for (const b of blocks(seg.lines!)) {
      if ('ctx' in b) {
        rows.push({ kind: 'line', key: `c${b.ctx.oldNo}:${b.ctx.newNo}`, line: b.ctx })
        continue
      }
      const words = b.dels.map((d, i) => (b.adds[i] ? wordDiff(d.text, b.adds[i].text) : null))
      b.dels.forEach((d, i) => rows.push({ kind: 'line', key: `d${d.oldNo}`, line: d, words: words[i]?.old }))
      b.adds.forEach((a, i) => rows.push({ kind: 'line', key: `a${a.newNo}`, line: a, words: words[i]?.new }))
    }
  }
  return rows
}

export function buildSplit(
  hunks: Hunk[],
  gaps: Gap[],
  state: Record<number, GapState>,
  newLines: string[] | null,
  oldLines: string[] | null,
): SplitViewRow[] {
  const rows: SplitViewRow[] = []
  for (const seg of segments(hunks, gaps, state, newLines, oldLines)) {
    if (seg.type === 'hunk') {
      rows.push(hunkRow(seg, gaps, state))
      continue
    }
    for (const b of blocks(seg.lines!)) {
      if ('ctx' in b) {
        rows.push({ kind: 'split', key: `c${b.ctx.oldNo}:${b.ctx.newNo}`, left: b.ctx, right: b.ctx })
        continue
      }
      const n = Math.max(b.dels.length, b.adds.length)
      for (let i = 0; i < n; i++) {
        const l = b.dels[i] ?? null
        const r = b.adds[i] ?? null
        const w = l && r ? wordDiff(l.text, r.text) : null
        rows.push({
          kind: 'split',
          key: `s${l?.oldNo ?? 'x'}:${r?.newNo ?? 'x'}`,
          left: l,
          right: r,
          leftWords: w?.old,
          rightWords: w?.new,
        })
      }
    }
  }
  return rows
}
