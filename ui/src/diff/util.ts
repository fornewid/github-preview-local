import type { FileDiff } from '../types'

export type StatBlock = 'added' | 'deleted' | 'neutral'

/** GitHub's five-block diffstat. */
export function diffstatBlocks(add: number, del: number): StatBlock[] {
  const total = add + del
  let a = 0
  let d = 0
  if (total > 0) {
    if (total <= 5) {
      a = add
      d = del
    } else {
      a = Math.floor((add / total) * 5)
      d = Math.floor((del / total) * 5)
    }
  }
  const out: StatBlock[] = []
  for (let i = 0; i < a; i++) out.push('added')
  for (let i = 0; i < d; i++) out.push('deleted')
  while (out.length < 5) out.push('neutral')
  return out
}

/** File header paths longer than 92 chars are shown as `...` + the last 89 chars. */
export function truncatePath(path: string, max = 92) {
  return path.length > max ? '...' + path.slice(path.length - (max - 3)) : path
}

export function extOf(path: string) {
  const base = path.split('/').pop() ?? path
  const i = base.lastIndexOf('.')
  return i > 0 ? base.slice(i) : ''
}

/** Key used for "Viewed": the file is un-viewed when its content changes. */
export function viewedKey(f: FileDiff) {
  return `${f.oldSha ?? ''}:${f.newSha ?? ''}:${f.additions}:${f.deletions}`
}

export function anchorFor(path: string) {
  let h = 0
  for (let i = 0; i < path.length; i++) h = (Math.imul(31, h) + path.charCodeAt(i)) | 0
  return 'diff-' + (h >>> 0).toString(16)
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function shortDate(iso: string) {
  const d = new Date(iso)
  const now = new Date()
  const s = `${MONTHS[d.getMonth()]} ${d.getDate()}`
  return d.getFullYear() === now.getFullYear() ? s : `${s}, ${d.getFullYear()}`
}

export function longDate(iso: string) {
  const d = new Date(iso)
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`
}

export function relativeTime(iso: string) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000
  if (diff < 45) return 'now'
  if (diff < 90) return '1 minute ago'
  if (diff < 3600) return `${Math.round(diff / 60)} minutes ago`
  if (diff < 5400) return '1 hour ago'
  if (diff < 86400) return `${Math.round(diff / 3600)} hours ago`
  if (diff < 172800) return 'yesterday'
  if (diff < 30 * 86400) return `${Math.round(diff / 86400)} days ago`
  return `on ${shortDate(iso)}`
}

export function plural(n: number, one: string, many = one + 's') {
  return `${n} ${n === 1 ? one : many}`
}

/** Minimal `.editorconfig` lookup for `tab_width` / `indent_size`. */
export function tabSizeFor(editorconfig: string | null | undefined, path: string): number {
  let size = 8
  if (!editorconfig) return size
  let matches = false
  for (const raw of editorconfig.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const sec = /^\[(.*)\]$/.exec(line)
    if (sec) {
      matches = globMatch(sec[1], path)
      continue
    }
    if (!matches) continue
    const kv = /^([a-z_]+)\s*=\s*(\S+)/i.exec(line)
    if (!kv) continue
    const k = kv[1].toLowerCase()
    const v = parseInt(kv[2], 10)
    if ((k === 'tab_width' || k === 'indent_size') && v > 0) size = v
  }
  return size
}

function globMatch(glob: string, path: string) {
  const base = path.split('/').pop() ?? path
  const target = glob.includes('/') ? path : base
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*'
        i++
      } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else if (c === '{') {
      const end = glob.indexOf('}', i)
      re += '(' + glob.slice(i + 1, end).split(',').map(escapeRe).join('|') + ')'
      i = end
    } else re += escapeRe(c)
  }
  return new RegExp(`^${re}$`).test(target)
}

function escapeRe(s: string) {
  return s.replace(/[.+^${}()|[\]\\]/g, '\\$&')
}
