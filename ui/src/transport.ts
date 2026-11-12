// Transport abstraction: the same UI runs inside the native window (Tauri IPC,
// no HTTP server) or as a static HTML export (data embedded in the page).

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

/** Progress of a local check, from the native side: a status change, a chunk of output or both. */
export interface CheckEvent {
  name: string
  status?: CheckStatus
  chunk?: string
  exitCode?: number | null
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
 * A browser tab of `gh-prv-local --browser`: the window's commands over HTTP. Each request carries
 * this run's token, which came in the address the CLI opened (kept for reloads, dropped from the
 * address bar).
 */
function createHttp(): Transport {
  const params = new URLSearchParams(location.search)
  const fromUrl = params.get('token')
  if (fromUrl) {
    sessionStorage.setItem('prv:token', fromUrl)
    params.delete('token')
    const rest = params.toString()
    history.replaceState(null, '', `${location.pathname}${rest ? `?${rest}` : ''}${location.hash}`)
  }
  const token = fromUrl ?? sessionStorage.getItem('prv:token') ?? ''
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
            if (line) for (const l of listeners) l(JSON.parse(line) as CheckEvent)
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
    runCheck: (name) => call<void>('run_check', { name }),
    cancelCheck: (name) => call<void>('cancel_check', { name }),
    findPr: async () => (await call<ExistingPr | null>('find_pr')) ?? null,
    onCheckEvent: (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    publish: (req) => call<PublishResult>('publish', { req }),
    submit: async (result, markdown) => {
      done = true
      await call<void>('submit_review', { result, markdown })
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
  if (window.__PRV_SERVER__) return createHttp()
  if (window.__PRV_DATA__) return createStatic(window.__PRV_DATA__)
  // Development: `vite` serves `public/dev-data.json` produced by `gh-prv-local export --data`.
  const url = new URLSearchParams(location.search).get('data') ?? '/dev-data.json'
  const res = await fetch(url)
  if (!res.ok) throw new Error(`No data source. Run \`gh-prv-local\` or \`gh-prv-local export\`. (${url}: ${res.status})`)
  return createStatic((await res.json()) as StaticData)
}
