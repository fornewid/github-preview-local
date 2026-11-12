// Transport abstraction: the same UI runs in a browser tab served by gh-prv-local (HTTP on
// 127.0.0.1), inside the native window (Tauri IPC, no HTTP server) or as a static HTML export
// (data embedded in the page).

import type {
  CheckDef,
  CheckStatus,
  ExistingPr,
  FileDiff,
  PersistedState,
  PublishRequest,
  PublishResult,
  ReviewResult,
  Snapshot,
} from './types'
import { contentKey, sidePath, type ContentSide } from './diff/util'

export interface StaticData {
  snapshot: Snapshot
  contents: Record<string, string>
  /** Image files as data URLs, keyed like `contents`. */
  images?: Record<string, string>
}

export interface SnapshotQuery {
  from?: string | null
  to?: string | null
}

export interface CheckRun {
  status: CheckStatus
  exitCode: number | null
  output: string
}

/** Progress of a local check, from the native side: a status change, a chunk of output or both. */
export interface CheckEvent {
  name: string
  status?: CheckStatus
  chunk?: string
  exitCode?: number | null
  /** The whole output so far, replacing what the page has (catching up after a lost stream). */
  output?: string
}

export interface Transport {
  /**
   * Connected to the CLI: the native window (Tauri IPC) or a browser tab (`--browser`, HTTP on
   * 127.0.0.1). Checks, commit ranges and Confirm (push + pull request) need it; an export is static.
   */
  kind: 'native' | 'browser' | 'static'
  getSnapshot(q?: SnapshotQuery): Promise<Snapshot>
  getContents(file: FileDiff, side: ContentSide): Promise<string | null>
  /** An image file's side as a `data:` URL (see isImage), or null. */
  getImage(file: FileDiff, side: ContentSide): Promise<string | null>
  loadState(snapshot: Snapshot): Promise<PersistedState>
  saveState(snapshot: Snapshot, state: PersistedState): Promise<void>
  listChecks(): Promise<CheckDef[]>
  /** Each check's last run (status, exit code, output), for a page that was not there to see it. */
  checkRuns(): Promise<Array<[string, CheckRun]>>
  runCheck(name: string): Promise<void>
  cancelCheck(name: string): Promise<void>
  findPr(): Promise<ExistingPr | null>
  onCheckEvent(cb: (e: CheckEvent) => void): () => void
  publish(req: PublishRequest): Promise<PublishResult>
  submit(result: ReviewResult, markdown: string): Promise<void>
  openInEditor(path: string): Promise<void>
  /** Zooms the native window like a browser (no-op in a browser, which zooms by itself). */
  setZoom(scale: number): Promise<void>
  /** A browser tab: the CLI stopped (Ctrl-C, or it ended) without the review being submitted here. */
  onGone?(cb: () => void): void
}

/** Talks to the CLI (the native window or a browser tab), as opposed to a static export. */
export const connected = (t: Transport | null | undefined) => !!t && t.kind !== 'static'

declare global {
  interface Window {
    __PRV_DATA__?: StaticData
    __TAURI_INTERNALS__?: unknown
    /** Served by `gh-prv-local --browser`. */
    __PRV_SERVER__?: boolean
  }
}

const emptyState = (): PersistedState => ({ viewed: {}, drafts: [] })

function stateKey(s: Snapshot) {
  return `prv:state:${s.repo.root}:${s.head.name}`
}

// Lazy import keeps the static build free from Tauri globals at runtime.
let core: Promise<typeof import('@tauri-apps/api/core')> | undefined

/** A command of the native window (Tauri IPC). */
export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return (await (core ??= import('@tauri-apps/api/core'))).invoke<T>(cmd, args)
}

function createNative(): Transport {
  const ev = import('@tauri-apps/api/event')
  return {
    kind: 'native',
    getSnapshot: (q) => invoke<Snapshot>('get_snapshot', { from: q?.from ?? null, to: q?.to ?? null }),
    getContents: (f, side) => invoke<string | null>('get_contents', { path: sidePath(f, side), side }),
    getImage: (f, side) => invoke<string | null>('get_image', { path: sidePath(f, side), side }),
    loadState: async () => (await invoke<PersistedState | null>('load_state')) ?? emptyState(),
    saveState: (_s, state) => invoke<void>('save_state', { state }),
    listChecks: () => invoke<CheckDef[]>('list_checks'),
    checkRuns: () => invoke<Array<[string, CheckRun]>>('check_runs'),
    runCheck: (name) => invoke<void>('run_check', { name }),
    cancelCheck: (name) => invoke<void>('cancel_check', { name }),
    findPr: async () => (await invoke<ExistingPr | null>('find_pr')) ?? null,
    onCheckEvent: (cb) => {
      let un: (() => void) | undefined
      let cancelled = false
      ev.then((m) => m.listen<CheckEvent>('check-event', (e) => cb(e.payload))).then((u) => {
        if (cancelled) u()
        else un = u
      })
      return () => {
        cancelled = true
        un?.()
      }
    },
    publish: (req) => invoke<PublishResult>('publish', { req }),
    submit: (result, markdown) => invoke<void>('submit_review', { result, markdown }),
    openInEditor: (path) => invoke<void>('open_in_editor', { path }),
    setZoom: (scale) => invoke<void>('set_zoom', { scale }),
  }
}

/**
 * A browser tab served by gh-prv-local: the window's commands over HTTP. Each request carries this
 * run's token, which the page gets once for the one-time code in the address the CLI opened (then
 * keeps for reloads; the code leaves the address bar).
 */
async function createHttp(): Promise<Transport> {
  const params = new URLSearchParams(location.search)
  if (params.has('code')) {
    // Kept until it is traded, so a lost answer can be asked again (and a reload still has it).
    sessionStorage.setItem('prv:code', params.get('code')!)
    params.delete('code')
    const rest = params.toString()
    history.replaceState(null, '', `${location.pathname}${rest ? `?${rest}` : ''}${location.hash}`)
  }
  const code = sessionStorage.getItem('prv:code')
  if (code) {
    let body: { ok?: string; error?: string } = {}
    for (let attempt = 0; attempt < 3 && !body.ok && !body.error; attempt++) {
      try {
        const r = await fetch('/api/session', { method: 'POST', headers: { 'X-Prv-Code': code } })
        // An answer cut short (a reload, a dropped connection) is tried again like no answer.
        body = (await r.json()) as typeof body
      } catch {
        await new Promise((r) => setTimeout(r, 500))
      }
    }
    if (body.ok) sessionStorage.setItem('prv:token', body.ok)
    if (body.ok || body.error) sessionStorage.removeItem('prv:code')
    // A reload of the first address still has its token; anything else cannot go on.
    if (!sessionStorage.getItem('prv:token'))
      throw new Error(body.error ?? 'gh-prv-local does not answer. Is it still running? Run it again to get a new address.')
  }
  const token = sessionStorage.getItem('prv:token')
  if (!token) throw new Error('This page has no access to gh-prv-local. Open the address gh-prv-local printed when it started (each address works once).')
  const call = async <T,>(cmd: string, args: Record<string, unknown> = {}): Promise<T> => {
    const r = await fetch(`/api/${cmd}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Prv-Token': token },
      body: JSON.stringify(args),
    })
    const body = await r.json().catch(() => ({ error: `${r.status} ${r.statusText}` }))
    if ('error' in body) throw new Error(body.error)
    return body.ok as T
  }
  // Check progress, one JSON object per line, on a response that stays open while this tab does
  // (the CLI takes a closed tab as a closed window). Reopened after a hiccup.
  const listeners = new Set<(e: CheckEvent) => void>()
  // Events from before the page listens (its stream opens first): handed to the first listener, in
  // order, starting with the stream's catch-up line.
  let early: CheckEvent[] | null = []
  const deliver = (e: CheckEvent) => {
    if (early) early.push(e)
    else for (const l of listeners) l(e)
  }
  let goneHandler: (() => void) | undefined
  let done = false
  void (async () => {
    let failures = 0
    while (!done) {
      try {
        const r = await fetch('/api/events', { headers: { 'X-Prv-Token': token } })
        if (!r.ok || !r.body) throw new Error(`${r.status}`)
        failures = 0
        const reader = r.body.pipeThrough(new TextDecoderStream()).getReader()
        let buf = ''
        for (;;) {
          const { value, done: end } = await reader.read()
          if (end) break
          buf += value
          for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
            const line = buf.slice(0, i)
            buf = buf.slice(i + 1)
            if (!line) continue
            const msg = JSON.parse(line) as CheckEvent | { runs: Array<[string, CheckRun]> }
            // The first line: each check's run so far (catching up after a reload or a lost stream).
            const events: CheckEvent[] =
              'runs' in msg ? msg.runs.map(([name, run]) => ({ name, status: run.status, exitCode: run.exitCode, output: run.output })) : [msg]
            for (const e of events) deliver(e)
          }
        }
      } catch {
        failures++
      }
      if (done) return
      if (failures >= 3) return goneHandler?.()
      await new Promise((r) => setTimeout(r, 1000))
    }
  })()
  return {
    kind: 'browser',
    getSnapshot: (q) => call<Snapshot>('get_snapshot', { from: q?.from ?? null, to: q?.to ?? null }),
    getContents: (f, side) => call<string | null>('get_contents', { path: sidePath(f, side), side }),
    getImage: (f, side) => call<string | null>('get_image', { path: sidePath(f, side), side }),
    loadState: async () => (await call<PersistedState | null>('load_state')) ?? emptyState(),
    saveState: (_s, state) => call<void>('save_state', { state }),
    listChecks: () => call<CheckDef[]>('list_checks'),
    checkRuns: () => call<Array<[string, CheckRun]>>('check_runs'),
    runCheck: (name) => call<void>('run_check', { name }),
    cancelCheck: (name) => call<void>('cancel_check', { name }),
    findPr: async () => (await call<ExistingPr | null>('find_pr')) ?? null,
    onCheckEvent: (cb) => {
      listeners.add(cb)
      if (early) {
        const missed = early
        early = null
        for (const e of missed) cb(e)
      }
      return () => listeners.delete(cb)
    },
    publish: (req) => call<PublishResult>('publish', { req }),
    submit: async (result, markdown) => {
      await call<void>('submit_review', { result, markdown })
      // gh-prv-local ends now: its stream closing is expected.
      done = true
    },
    openInEditor: (path) => call<void>('open_in_editor', { path }),
    setZoom: async () => {},
    onGone: (cb) => {
      goneHandler = cb
    },
  }
}

function createStatic(data: StaticData): Transport {
  return {
    kind: 'static',
    getSnapshot: async () => data.snapshot,
    getContents: async (f, side) => data.contents[contentKey(f, side)] ?? null,
    getImage: async (f, side) => data.images?.[contentKey(f, side)] ?? null,
    loadState: async (s) => {
      try {
        const raw = localStorage.getItem(stateKey(s))
        return raw ? { ...emptyState(), ...JSON.parse(raw) } : emptyState()
      } catch {
        return emptyState()
      }
    },
    saveState: async (s, state) => {
      try {
        localStorage.setItem(stateKey(s), JSON.stringify(state))
      } catch {
        /* storage may be unavailable for file:// pages */
      }
    },
    listChecks: async () => [],
    checkRuns: async () => [],
    runCheck: async () => {},
    cancelCheck: async () => {},
    findPr: async () => null,
    onCheckEvent: () => () => {},
    publish: async () => {
      throw new Error('Publishing is not available in a static export. Run `gh-prv-local` to open the native window.')
    },
    submit: async () => {},
    openInEditor: async () => {},
    setZoom: async () => {},
  }
}

export async function createTransport(): Promise<Transport> {
  if (window.__TAURI_INTERNALS__) return createNative()
  if (window.__PRV_SERVER__) return await createHttp()
  if (window.__PRV_DATA__) return createStatic(window.__PRV_DATA__)
  // Development: `vite` serves `public/dev-data.json` produced by `gh-prv-local export --data`.
  const url = new URLSearchParams(location.search).get('data') ?? '/dev-data.json'
  const res = await fetch(url)
  if (!res.ok) throw new Error(`No data source. Run \`gh-prv-local\` or \`gh-prv-local export\`. (${url}: ${res.status})`)
  return createStatic((await res.json()) as StaticData)
}
