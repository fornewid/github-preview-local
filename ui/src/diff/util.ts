import type { Commit, FileDiff } from '../types'

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

export function extOf(path: string) {
  const base = path.split('/').pop() ?? path
  const i = base.lastIndexOf('.')
  return i > 0 ? base.slice(i) : ''
}

/** A file's entry in the file tree's extension filter. */
export function extLabel(path: string) {
  return extOf(path) || 'No extension'
}

/** Key used for "Viewed": the file is un-viewed when its content changes. */
export function viewedKey(f: FileDiff) {
  return `${f.oldSha ?? ''}:${f.newSha ?? ''}:${f.additions}:${f.deletions}`
}

export function isViewed(viewed: Record<string, string>, f: FileDiff) {
  return viewed[f.path] === viewedKey(f)
}

export type ContentSide = 'old' | 'new'

/** The path a side of the diff is read from (a renamed file's old side has its old path). */
export function sidePath(f: Pick<FileDiff, 'path' | 'oldPath'>, side: ContentSide) {
  return side === 'old' ? (f.oldPath ?? f.path) : f.path
}

/** Image files the diff shows as images, like github.com (same list as `image_mime` in git.rs). */
export function isImage(f: Pick<FileDiff, 'path' | 'binary'>) {
  return f.binary && /\.(png|jpe?g|gif|webp|bmp|ico|avif)$/i.test(f.path)
}

/** A size change as github.com writes it: 3 significant digits, 1024 steps ("-78 Bytes", "87.8 KB"). */
export function sizeDelta(bytes: number) {
  const units = ['Bytes', 'KB', 'MB', 'GB']
  let n = Math.abs(bytes)
  let u = 0
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024
    u++
  }
  const text = u === 0 ? `${n} ${n === 1 ? 'Byte' : 'Bytes'}` : `${Number(n.toPrecision(3))} ${units[u]}`
  return `${bytes < 0 ? '-' : ''}${text}`
}

/** Key of a side's contents (`old:path`, `new:path`), in the store and in an export's data. */
export function contentKey(f: Pick<FileDiff, 'path' | 'oldPath'>, side: ContentSide) {
  return `${side}:${sidePath(f, side)}`
}

export function anchorFor(path: string) {
  return 'diff-' + (hashOf(path) >>> 0).toString(16)
}

/** The commit's author, then its co-authors. */
export function commitAuthors(c: Commit) {
  return [c.author, ...c.coAuthors.filter((n) => n !== c.author)]
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
  out.push(glob.replaceAll('\u0000', '**/'))
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

/* ---------- CODEOWNERS ---------- */

export interface Ownership {
  owners: string[]
  /** 1-based line of the CODEOWNERS rule that applies (the last match wins). */
  line: number
}

interface OwnerRule {
  owners: string[]
  line: number
  /** Only directories match (`docs/`): files below them are owned. */
  dirOnly: boolean
  /** `dir/*`: direct children only, not deeper paths. */
  directOnly: boolean
  /** Cheap pre-checks before running the glob matcher. */
  literal?: string
  anchoredPrefix?: string
  suffix?: string
  /** Literal pieces every matching path contains. */
  needles?: string[]
  alts: Tok[][]
}

const MAX_RULE_ALTERNATIVES = 8

// Pattern alternatives per gitignore rules: "a/**/b" also matches "a/b", a leading "**/" also matches at the root.
function ownerAlternatives(pat: string, anchored: boolean): string[] {
  let alts = [pat]
  while (alts.some((a) => a.includes('/**/')) && alts.length < MAX_RULE_ALTERNATIVES) {
    alts = alts.flatMap((a) => {
      const i = a.indexOf('/**/')
      return i < 0 ? [a] : [a.slice(0, i) + '/\u0000' + a.slice(i + 4), a.slice(0, i) + '/' + a.slice(i + 4)]
    })
  }
  alts = alts.map((a) => a.replaceAll('\u0000', '**/'))
  const out: string[] = []
  for (const a of alts) {
    out.push(a)
    if (a.startsWith('**/')) out.push(a.slice(3))
    else if (!anchored) out.push('**/' + a)
  }
  return [...new Set(out)]
}

const rulesCache = new Map<number, OwnerRule[]>()
const resultCache = new Map<number, Map<string, Ownership | null>>()
// The same CODEOWNERS string is passed for every file: hash it once.
let lastText: string | null = null
let lastKey = 0
function keyOf(text: string) {
  if (text !== lastText) {
    lastText = text
    lastKey = hashOf(text)
  }
  return lastKey
}

function parseCodeowners(text: string): OwnerRule[] {
  const key = keyOf(text)
  const hit = rulesCache.get(key)
  if (hit) return hit
  const rules: OwnerRule[] = []
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim()
    if (!line || line.startsWith('#')) return
    const tokens = line.split(/\s+/)
    let pat = tokens[0].replace(/^\\#/, '#')
    if (pat.length > 300) return
    // Everything from the first `#` token on is a comment.
    const rest = tokens.slice(1)
    const hash = rest.findIndex((t) => t.startsWith('#'))
    const owners = hash < 0 ? rest : rest.slice(0, hash)
    const dirOnly = pat.endsWith('/') && pat !== '/'
    pat = pat.replace(/\/+$/, '')
    let anchored = pat.startsWith('/') || pat.includes('/')
    const directOnly = pat.endsWith('/*')
    pat = pat.replace(/^\/+/, '') || '**'
    // `**/name` is the same as an unanchored `name`.
    if (pat.startsWith('**/') && !pat.slice(3).includes('/')) {
      pat = pat.slice(3)
      anchored = false
    }
    const wild = /[*?[\\]/.test(pat)
    const rule: OwnerRule = { owners, line: i + 1, dirOnly, directOnly, alts: [] }
    if (!wild && !anchored) rule.literal = pat
    else if (!wild) rule.anchoredPrefix = pat
    else if (!anchored && /^\*[^*?[\\/]+$/.test(pat)) rule.suffix = pat.slice(1)
    else {
      if (anchored) {
        const lit = pat.slice(0, pat.search(/[*?[\\]/))
        if (lit && !lit.startsWith('*')) rule.anchoredPrefix = lit
      }
      rule.alts = ownerAlternatives(pat, anchored).map(tokenize)
      // Escaped patterns (`foo\*bar`) skip the pre-filter rather than unescape it.
      if (!pat.includes('\\'))
        rule.needles = pat
          .replace(/\[[^\]]*\]/g, '/')
          .split(/[*?/]/)
          .filter((n) => n.length >= 2)
    }
    rules.push(rule)
  })
  if (rulesCache.size > 8) rulesCache.clear()
  rulesCache.set(key, rules)
  return rules
}

function ruleMatches(r: OwnerRule, path: string, parts: string[]): boolean {
  // Candidates: the file itself and every parent directory (a matching directory owns its files).
  const segs = r.dirOnly ? parts.slice(0, -1) : parts
  if (r.literal !== undefined) return segs.includes(r.literal)
  if (r.suffix !== undefined) return segs.some((s) => s.endsWith(r.suffix!))
  if (r.anchoredPrefix !== undefined && !r.alts.length) {
    // Literal anchored path: the path itself or one of its directories.
    const p = r.anchoredPrefix
    return (path === p && !r.dirOnly) || path.startsWith(p + '/')
  }
  if (r.anchoredPrefix && !path.startsWith(r.anchoredPrefix)) return false
  if (r.needles && !r.needles.every((n) => path.includes(n))) return false
  const targets: string[] = []
  if (!r.dirOnly) targets.push(path)
  // `dir/*` owns direct children only; `dir/*/` owns everything below the matching directories.
  if (r.dirOnly || !r.directOnly) for (let i = 1; i < parts.length; i++) targets.push(parts.slice(0, i).join('/'))
  return targets.some((t) => r.alts.some((toks) => matchTokens(toks, t)))
}

/** Code owners of `path` per GitHub's CODEOWNERS rules (gitignore-style patterns, last match wins). */
export function codeownersFor(text: string | null | undefined, path: string): Ownership | null {
  if (!text) return null
  const key = keyOf(text)
  let cache = resultCache.get(key)
  if (!cache) {
    if (resultCache.size > 8) resultCache.clear()
    cache = new Map()
    resultCache.set(key, cache)
  }
  if (cache.has(path)) return cache.get(path)!
  let found: Ownership | null = null
  try {
    const rules = parseCodeowners(text)
    const parts = path.split('/')
    for (let i = rules.length - 1; i >= 0; i--) {
      if (ruleMatches(rules[i], path, parts)) {
        found = rules[i].owners.length ? { owners: rules[i].owners, line: rules[i].line } : null
        break
      }
    }
  } catch {
    found = null
  }
  cache.set(path, found)
  return found
}

export function ownersLabel(o: Ownership) {
  const names = o.owners
  const list = names.length <= 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
  return `Owned by ${list} (from CODEOWNERS line ${o.line})`
}
