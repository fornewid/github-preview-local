import { diffWordsWithSpace } from 'diff'

export type Range = [start: number, end: number]

export interface WordDiff {
  old: Range[]
  new: Range[]
}

/**
 * Intra-line ("word") highlighting for a paired deletion/addition, like
 * GitHub's `.x` spans. Returns null when the lines are too different for a
 * useful highlight.
 */
export function wordDiff(a: string, b: string): WordDiff | null {
  if (a === b) return null
  if (a.length > 1000 || b.length > 1000) return null
  const parts = diffWordsWithSpace(a, b)
  const old: Range[] = []
  const neu: Range[] = []
  let oi = 0
  let ni = 0
  let same = 0
  for (const p of parts) {
    const len = p.value.length
    if (p.added) {
      neu.push([ni, ni + len])
      ni += len
    } else if (p.removed) {
      old.push([oi, oi + len])
      oi += len
    } else {
      same += p.value.trim().length
      oi += len
      ni += len
    }
  }
  const longest = Math.max(a.trim().length, b.trim().length)
  if (longest === 0) return null
  // Lines that share too little are shown without word highlights.
  if (same / longest < 0.4) return null
  return { old: merge(old), new: merge(neu) }
}

function merge(ranges: Range[]): Range[] {
  const out: Range[] = []
  for (const r of ranges) {
    const last = out[out.length - 1]
    if (last && last[1] === r[0]) last[1] = r[1]
    else out.push([r[0], r[1]])
  }
  return out
}
