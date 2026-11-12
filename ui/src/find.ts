// Find in the diff (Cmd/Ctrl+F). The diff list renders only the files near the viewport, so the
// matches come from the diff data, in page order; the ones on screen are painted with the CSS Custom
// Highlight API (no DOM changes), and going to a match first opens and renders its file.
import { parseHunks, type DiffLine, type Hunk } from './diff/parse'
import { anchorFor } from './diff/util'
import type { FileDiff } from './types'

/** A match: its file, its code cell (`data-find`: side and line number) and which one in the cell. */
export interface FindMatch {
  path: string
  cell: string
  nth: number
}

/** More matches than this are not counted (the count then reads "10000+"). */
export const MAX_MATCHES = 10000

const parsed = new WeakMap<FileDiff, { patch?: Hunk[]; patchW?: Hunk[] }>()
function hunksOf(f: FileDiff, whitespace: boolean): Hunk[] {
  let entry = parsed.get(f)
  if (!entry) parsed.set(f, (entry = {}))
  const key = whitespace ? 'patchW' : 'patch'
  return (entry[key] ??= parseHunks(f[key]))
}

/** The code cells a file's hunks show, in page order: [data-find key, text]. Mirrors DiffTable. */
function* cells(hunks: Hunk[], split: boolean): Generator<[string, string]> {
  for (const h of hunks) {
    const lines = h.lines
    let i = 0
    while (i < lines.length) {
      if (lines[i].type === 'ctx') {
        const l = lines[i++]
        if (split) yield [`LEFT:${l.oldNo}`, l.text]
        yield [`RIGHT:${l.newNo}`, l.text]
        continue
      }
      const dels: DiffLine[] = []
      const adds: DiffLine[] = []
      while (i < lines.length && lines[i].type !== 'ctx') (lines[i].type === 'del' ? dels : adds).push(lines[i++])
      if (split) {
        for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
          if (dels[k]) yield [`LEFT:${dels[k].oldNo}`, dels[k].text]
          if (adds[k]) yield [`RIGHT:${adds[k].newNo}`, adds[k].text]
        }
      } else {
        for (const d of dels) yield [`LEFT:${d.oldNo}`, d.text]
        for (const a of adds) yield [`RIGHT:${a.newNo}`, a.text]
      }
    }
  }
}

/** Case-insensitive, like a browser's find. */
function pattern(query: string) {
  return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu')
}

export function findMatches(files: FileDiff[], query: string, split: boolean, whitespace: boolean): FindMatch[] {
  const out: FindMatch[] = []
  if (!query) return out
  const re = pattern(query)
  for (const f of files) {
    if (f.binary || f.submodule || f.tooLarge) continue
    for (const [cell, text] of cells(hunksOf(f, whitespace), split)) {
      let nth = 0
      for (const _ of text.matchAll(re)) {
        out.push({ path: f.path, cell, nth: nth++ })
        if (out.length >= MAX_MATCHES) return out
      }
    }
  }
  return out
}

/** The rendered code cell of a match, if its file is on screen. */
export function matchCell(m: FindMatch): HTMLElement | null {
  return document.getElementById(anchorFor(m.path))?.querySelector<HTMLElement>(`td[data-find="${m.cell}"]`) ?? null
}

/** A range over [start, end) of the text inside `root`, across its text nodes. */
function rangeIn(root: Node, start: number, end: number): Range {
  const range = document.createRange()
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let pos = 0
  let started = false
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const len = n.textContent?.length ?? 0
    if (!started && start < pos + len) {
      range.setStart(n, start - pos)
      started = true
    }
    if (started && end <= pos + len) {
      range.setEnd(n, end - pos)
      break
    }
    pos += len
  }
  return range
}

type Registry = { set(name: string, h: unknown): void; delete(name: string): void }
const registry = (): Registry | undefined => (globalThis.CSS as unknown as { highlights?: Registry } | undefined)?.highlights
const HighlightCtor = (globalThis as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight

/** Paints every match on screen, and the current one apart. */
export function paintMatches(query: string, current: FindMatch | null) {
  const reg = registry()
  if (!reg || !HighlightCtor) return
  if (!query) return clearMatches()
  const re = pattern(query)
  const all: Range[] = []
  let cur: Range | null = null
  for (const cell of document.querySelectorAll<HTMLElement>('.DiffEntry td[data-find]')) {
    const inner = cell.querySelector('.diff-text-inner')
    if (!inner) continue
    let nth = 0
    for (const m of (inner.textContent ?? '').matchAll(re)) {
      const r = rangeIn(inner, m.index, m.index + m[0].length)
      all.push(r)
      if (current && current.cell === cell.dataset.find && current.nth === nth && cell.closest<HTMLElement>('.DiffEntry')?.dataset.path === current.path)
        cur = r
      nth++
    }
  }
  reg.set('prv-find', new HighlightCtor(...all))
  if (cur) reg.set('prv-find-current', new HighlightCtor(cur))
  else reg.delete('prv-find-current')
}

export function clearMatches() {
  registry()?.delete('prv-find')
  registry()?.delete('prv-find-current')
}
