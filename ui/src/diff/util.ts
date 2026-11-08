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

const tabCache = new Map<string, number>()

/** Minimal `.editorconfig` lookup for `tab_width` / `indent_size` (never throws). */
export function tabSizeFor(editorconfig: string | null | undefined, path: string): number {
  if (!editorconfig) return 8
  const key = `${editorconfig.length}:${hashOf(editorconfig)}:${path}`
  const cached = tabCache.get(key)
  if (cached !== undefined) return cached
  let size = 8
  try {
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
      if ((k === 'tab_width' || k === 'indent_size') && v > 0 && v <= 32) size = v
    }
  } catch {
    size = 8
  }
  tabCache.set(key, size)
  return size
}

function hashOf(s: string) {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  return h
}

/** Index of the `}` closing the `{` at `open`, honoring nesting; -1 if none. */
function closingBrace(glob: string, open: number) {
  let depth = 0
  for (let i = open; i < glob.length; i++) {
    if (glob[i] === '\\') i++
    else if (glob[i] === '{') depth++
    else if (glob[i] === '}' && --depth === 0) return i
  }
  return -1
}

function splitTopLevel(s: string) {
  const parts: string[] = []
  let depth = 0
  let cur = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '\\') {
      cur += c + (s[i + 1] ?? '')
      i++
      continue
    }
    if (c === '{') depth++
    if (c === '}') depth--
    if (c === ',' && depth === 0) {
      parts.push(cur)
      cur = ''
    } else cur += c
  }
  parts.push(cur)
  return parts
}

function globToRe(glob: string): string {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '\\') {
      re += escapeRe(glob[i + 1] ?? '\\')
      i++
    } else if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*'
        i++
      } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else if (c === '{') {
      const end = closingBrace(glob, i)
      if (end < 0) {
        re += '\\{'
        continue
      }
      re += '(?:' + splitTopLevel(glob.slice(i + 1, end)).map(globToRe).join('|') + ')'
      i = end
    } else if (c === '[') {
      const end = glob.indexOf(']', i + 1)
      if (end < 0) {
        re += '\\['
        continue
      }
      let body = glob.slice(i + 1, end)
      const negate = body.startsWith('!')
      if (negate) body = body.slice(1)
      re += '[' + (negate ? '^' : '') + body.replace(/[\\\]^[]/g, '\\$&') + ']'
      i = end
    } else re += escapeRe(c)
  }
  return re
}

function globMatch(glob: string, path: string) {
  // Pathological patterns (catastrophic backtracking) are ignored.
  if (glob.length > 200 || (glob.match(/\*/g)?.length ?? 0) > 16) return false
  glob = glob.replace(/\*{3,}/g, '**')
  const base = path.split('/').pop() ?? path
  // EditorConfig: a glob containing `/` is relative to the .editorconfig directory (the repository root).
  const anchored = glob.includes('/')
  const target = anchored ? '/' + path : base
  const pattern = anchored && !glob.startsWith('/') ? '/' + glob : glob
  try {
    return new RegExp(`^${globToRe(pattern)}$`).test(target)
  } catch {
    return false
  }
}

function escapeRe(s: string) {
  return s.replace(/[.+^${}()|[\]\\*?]/g, '\\$&')
}
