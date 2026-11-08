import { create } from 'zustand'
import type { GapState } from './diff/model'
import { highlightFile, type HlLines } from './diff/highlight'
import type { SnapshotQuery, Transport } from './transport'
import type {
  CheckState,
  FileDiff,
  PersistedState,
  ReviewComment,
  ReviewEvent,
  ReviewResult,
  Side,
  Snapshot,
} from './types'
import { formatReview } from './output'
import { viewedKey } from './diff/util'

export type DiffView = 'split' | 'unified'
export type Tab = 'conversation' | 'commits' | 'checks' | 'files'

export interface Settings {
  diffView: DiffView
  hideWhitespace: boolean
  treeVisible: boolean
}

export interface CommentTarget {
  path: string
  side: Side
  line: number
  startLine?: number | null
}

export interface Selection {
  path: string
  side: Side
  start: number
  end: number
}

interface FileUI {
  collapsed?: boolean
  gaps?: Record<number, GapState>
}

const SETTINGS_KEY = 'prv:settings'

function loadSettings(): Settings {
  const fromUrl = new URLSearchParams(location.search)
  let s: Settings = { diffView: 'unified', hideWhitespace: false, treeVisible: true }
  try {
    s = { ...s, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') }
  } catch {
    /* ignore */
  }
  const diff = fromUrl.get('diff')
  if (diff === 'split' || diff === 'unified') s.diffView = diff
  const w = fromUrl.get('w')
  if (w === '1' || w === '0') s.hideWhitespace = w === '1'
  return s
}

export interface Store {
  transport: Transport | null
  snapshot: Snapshot | null
  loading: boolean
  error: string | null
  settings: Settings
  tab: Tab
  range: SnapshotQuery
  filter: { exts: string[] | null; showViewed: boolean; showDeleted: boolean; text: string }
  fileUI: Record<string, FileUI>
  viewed: Record<string, string>
  drafts: ReviewComment[]
  composing: CommentTarget | null
  selection: Selection | null
  prTitle: string
  prBody: string
  contents: Record<string, string | null>
  hl: Record<string, HlLines | null>
  checks: CheckState[]
  submitted: { result: ReviewResult; markdown: string } | null
  busy: string | null

  init(t: Transport): Promise<void>
  reload(q?: SnapshotQuery): Promise<void>
  setTab(t: Tab): void
  applySettings(s: Partial<Settings>): void
  setFilter(f: Partial<Store['filter']>): void
  toggleCollapsed(path: string, value?: boolean): void
  setGaps(path: string, gaps: Record<number, GapState> | undefined): void
  toggleViewed(f: FileDiff): void
  ensureContents(f: FileDiff): void
  select(sel: Selection | null): void
  compose(t: CommentTarget | null): void
  addComment(c: Omit<ReviewComment, 'id' | 'createdAt' | 'commit'>): void
  updateComment(id: string, body: string): void
  deleteComment(id: string): void
  setPr(title: string | null, body: string | null): void
  runCheck(name: string): Promise<void>
  runAllChecks(): Promise<void>
  submit(event: ReviewEvent, body: string, publish?: { draft: boolean }): Promise<void>
}

let saveTimer: ReturnType<typeof setTimeout> | undefined

function persist(get: () => Store) {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    const { transport, snapshot, viewed, drafts, prTitle, prBody } = get()
    if (!transport || !snapshot) return
    const state: PersistedState = { viewed, drafts, prTitle, prBody }
    void transport.saveState(snapshot, state)
  }, 250)
}

export const useStore = create<Store>((set, get) => ({
  transport: null,
  snapshot: null,
  loading: true,
  error: null,
  settings: loadSettings(),
  tab: 'files',
  range: {},
  filter: { exts: null, showViewed: true, showDeleted: true, text: '' },
  fileUI: {},
  viewed: {},
  drafts: [],
  composing: null,
  selection: null,
  prTitle: '',
  prBody: '',
  contents: {},
  hl: {},
  checks: [],
  submitted: null,
  busy: null,

  async init(t) {
    set({ transport: t, loading: true })
    try {
      const snapshot = await t.getSnapshot()
      const st = await t.loadState(snapshot)
      set({
        snapshot,
        loading: false,
        viewed: st.viewed ?? {},
        drafts: st.drafts ?? [],
        prTitle: st.prTitle || snapshot.title,
        prBody: st.prBody ?? snapshot.body,
      })
      if (t.capabilities.checks) {
        const defs = await t.listChecks()
        set({ checks: defs.map((d) => ({ ...d, status: 'idle', output: '' })) })
        t.onCheckEvent((e) =>
          set((s) => ({
            checks: s.checks.map((c) =>
              c.name !== e.name
                ? c
                : {
                    ...c,
                    status: e.status ?? c.status,
                    exitCode: e.exitCode ?? c.exitCode,
                    output: e.chunk ? c.output + e.chunk : e.status === 'running' ? '' : c.output,
                    startedAt: e.status === 'running' ? new Date().toISOString() : c.startedAt,
                    finishedAt:
                      e.status === 'success' || e.status === 'failure' ? new Date().toISOString() : c.finishedAt,
                  },
            ),
          })),
        )
      }
    } catch (e) {
      set({ error: String(e), loading: false })
    }
  },

  async reload(q) {
    const t = get().transport
    if (!t) return
    const range = q ?? get().range
    set({ loading: true, range })
    try {
      const snapshot = await t.getSnapshot(range)
      set({ snapshot, loading: false, contents: {}, hl: {}, fileUI: {} })
    } catch (e) {
      set({ error: String(e), loading: false })
    }
  },

  setTab: (tab) => {
    set({ tab })
    window.scrollTo({ top: 0 })
  },

  applySettings(s) {
    const settings = { ...get().settings, ...s }
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
    set({ settings })
  },

  setFilter: (f) => set((s) => ({ filter: { ...s.filter, ...f } })),

  toggleCollapsed: (path, value) =>
    set((s) => ({
      fileUI: { ...s.fileUI, [path]: { ...s.fileUI[path], collapsed: value ?? !s.fileUI[path]?.collapsed } },
    })),

  setGaps: (path, gaps) => set((s) => ({ fileUI: { ...s.fileUI, [path]: { ...s.fileUI[path], gaps } } })),

  toggleViewed(f) {
    const viewed = { ...get().viewed }
    const on = viewed[f.path] !== viewedKey(f)
    if (on) viewed[f.path] = viewedKey(f)
    else delete viewed[f.path]
    set({ viewed })
    get().toggleCollapsed(f.path, on)
    persist(get)
  },

  ensureContents(f) {
    const { transport, snapshot, contents } = get()
    if (!transport || !snapshot || f.binary || f.submodule) return
    const sides: Array<['old' | 'new', string]> = []
    if (f.status !== 'added') sides.push(['old', f.oldPath ?? f.path])
    if (f.status !== 'deleted') sides.push(['new', f.path])
    for (const [side, path] of sides) {
      const key = `${side}:${path}`
      if (key in contents) continue
      set((s) => ({ contents: { ...s.contents, [key]: null } }))
      void transport.getContents(path, side, snapshot).then((text) => {
        set((s) => ({ contents: { ...s.contents, [key]: text } }))
        if (text != null)
          void highlightFile(text, path).then((lines) => set((s) => ({ hl: { ...s.hl, [key]: lines } })))
      })
    }
  },

  select: (selection) => set({ selection }),
  compose: (composing) => set({ composing }),

  addComment(c) {
    const snapshot = get().snapshot!
    const comment: ReviewComment = {
      ...c,
      id: Math.random().toString(36).slice(2, 10),
      createdAt: new Date().toISOString(),
      commit: snapshot.head.sha,
    }
    set((s) => ({ drafts: [...s.drafts, comment], composing: null, selection: null }))
    persist(get)
  },

  updateComment(id, body) {
    set((s) => ({ drafts: s.drafts.map((d) => (d.id === id ? { ...d, body } : d)) }))
    persist(get)
  },

  deleteComment(id) {
    set((s) => ({ drafts: s.drafts.filter((d) => d.id !== id) }))
    persist(get)
  },

  setPr(title, body) {
    set((s) => ({ prTitle: title ?? s.prTitle, prBody: body ?? s.prBody }))
    persist(get)
  },

  async runCheck(name) {
    const t = get().transport
    if (!t) return
    set((s) => ({ checks: s.checks.map((c) => (c.name === name ? { ...c, status: 'queued', output: '' } : c)) }))
    await t.runCheck(name)
  },

  async runAllChecks() {
    for (const c of get().checks) await get().runCheck(c.name)
  },

  async submit(event, body, publish) {
    const { transport, snapshot, drafts, prTitle, prBody } = get()
    if (!transport || !snapshot) return
    let pub: ReviewResult['publish'] = null
    if (event === 'CONFIRM' && publish) {
      set({ busy: 'Pushing branch and opening pull request…' })
      try {
        const r = await transport.publish({ title: prTitle, body: prBody, draft: publish.draft })
        pub = { url: r.url, created: r.created, draft: r.draft }
      } catch (e) {
        set({ busy: null })
        throw e
      }
    }
    const result: ReviewResult = {
      event,
      body,
      comments: drafts,
      base: snapshot.base,
      head: snapshot.head,
      mergeBase: snapshot.mergeBase,
      publish: pub,
    }
    const markdown = formatReview(result, snapshot)
    set({ busy: null, submitted: { result, markdown }, drafts: [] })
    persist(get)
    await transport.submit(result, markdown)
  },
}))

// Exposed for automated UI tests (tools/reference) and debugging.
;(window as unknown as { __prv: typeof useStore }).__prv = useStore
