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

const MAX_ALTERNATIVES = 64

/** Expands `{a,b}` and makes `/**\/` also match a single `/`. False when too many alternatives. */
function expand(glob: string, out: string[]): boolean {
  if (out.length > MAX_ALTERNATIVES) return false
  for (let i = 0; i < glob.length; i++) {
    if (glob[i] === '\\') {
      i++
      continue
    }
    if (glob[i] === '{') {
      const end = closingBrace(glob, i)
      if (end < 0) continue
      const pre = glob.slice(0, i)
      const post = glob.slice(end + 1)
      const alts = splitTopLevel(glob.slice(i + 1, end))
      if (alts.length < 2) return expand(pre + '\\{' + glob.slice(i + 1, end) + '\\}' + post, out)
      for (const a of alts) if (!expand(pre + a + post, out)) return false
      return true
    }
  }
  const gs = glob.indexOf('/**/')
  if (gs >= 0) return expand(glob.slice(0, gs) + '/' + glob.slice(gs + 4), out) && expand(glob.slice(0, gs) + '/\u0000' + glob.slice(gs + 4), out)
  out.push(glob.replace('\u0000', '**/'))
  return out.length <= MAX_ALTERNATIVES
}

type Tok =
  | { t: 'lit'; c: string }
  | { t: 'any' }
  | { t: 'star' }
  | { t: 'globstar' }
  | { t: 'class'; body: string; neg: boolean }

function tokenize(glob: string): Tok[] {
  const toks: Tok[] = []
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '\\') toks.push({ t: 'lit', c: glob[++i] ?? '\\' })
    else if (c === '*') {
      if (glob[i + 1] === '*') {
        while (glob[i + 1] === '*') i++
        toks.push({ t: 'globstar' })
      } else toks.push({ t: 'star' })
    } else if (c === '?') toks.push({ t: 'any' })
    else if (c === '[') {
      const end = glob.indexOf(']', i + 2)
      if (end < 0) toks.push({ t: 'lit', c })
      else {
        let body = glob.slice(i + 1, end)
        const neg = body[0] === '!' || body[0] === '^'
        if (neg) body = body.slice(1)
        toks.push({ t: 'class', body, neg })
        i = end
      }
    } else toks.push({ t: 'lit', c })
  }
  return toks
}

function inClass(ch: string, body: string) {
  for (let k = 0; k < body.length; k++) {
    if (body[k + 1] === '-' && k + 2 < body.length) {
      if (ch >= body[k] && ch <= body[k + 2]) return true
      k += 2
    } else if (body[k] === ch) return true
  }
  return false
}

/** Linear-time (tokens × text) wildcard match: no regex backtracking. */
function matchTokens(toks: Tok[], text: string) {
  const n = text.length
  let next = new Array<boolean>(n + 1).fill(false)
  next[n] = true
  for (let i = toks.length - 1; i >= 0; i--) {
    const tok = toks[i]
    const cur = new Array<boolean>(n + 1).fill(false)
    for (let j = n; j >= 0; j--) {
      const ch = j < n ? text[j] : ''
      switch (tok.t) {
        case 'lit':
          cur[j] = j < n && ch === tok.c && next[j + 1]
          break
        case 'any':
          cur[j] = j < n && ch !== '/' && next[j + 1]
          break
        case 'class':
          cur[j] = j < n && ch !== '/' && inClass(ch, tok.body) !== tok.neg && next[j + 1]
          break
        case 'star':
          cur[j] = next[j] || (j < n && ch !== '/' && cur[j + 1])
          break
        case 'globstar':
          cur[j] = next[j] || (j < n && cur[j + 1])
          break
      }
    }
    next = cur
  }
  return next[0]
}

function globMatch(glob: string, path: string) {
  if (glob.length > 500) return false
  // EditorConfig: a glob containing `/` is relative to the .editorconfig directory (the repository root).
  const anchored = glob.includes('/')
  const target = anchored ? '/' + path : (path.split('/').pop() ?? path)
  const pattern = anchored && !glob.startsWith('/') ? '/' + glob : glob
  const alts: string[] = []
  if (!expand(pattern, alts)) return false
  return alts.some((a) => matchTokens(tokenize(a), target))
}
