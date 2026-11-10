import { create } from 'zustand'
import type { GapState } from './diff/model'
import { highlightFile, type HlLines } from './diff/highlight'
import type { SnapshotQuery, Transport } from './transport'
import type {
  CheckState,
  CheckStatus,
  ExistingPr,
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
export type Panel = 'overview' | 'comments' | 'merge'

export interface Settings {
  diffView: DiffView
  /** Effective "hide whitespace" (persisted only for "Always hide"). */
  hideWhitespace: boolean
  /** "Hide for this diff only": not saved, applies to this preview. */
  hideWhitespaceDiffOnly?: boolean
  /** "Compact line height" (20px rows instead of 24px). */
  compact: boolean
  minimizeComments: boolean
  treeVisible: boolean
  treeWidth: number
  /** Native window zoom (browsers keep their own). */
  zoom: number
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
  /** Expanded context, per whitespace mode (hunks differ between the two). */
  gaps?: Record<number, GapState>
  gapsW?: Record<number, GapState>
}

const SETTINGS_KEY = 'prv:settings'
const MAX_CHECK_OUTPUT = 200_000

function loadSettings(): Settings {
  const fromUrl = new URLSearchParams(location.search)
  let s: Settings = {
    diffView: 'split',
    hideWhitespace: false,
    compact: true,
    minimizeComments: false,
    treeVisible: true,
    treeWidth: 296,
    zoom: 1,
  }
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

/** Confirm (push + pull request) needs the native window and the full branch, not a commit range. */
export function canConfirm(s: Pick<Store, 'transport' | 'range'>) {
  return !!s.transport?.capabilities.publish && !s.range.from
}

/** `from..to` for a commit range, '' for all changes. */
export function viewKey(range: SnapshotQuery) {
  return range.from ? `${range.from.slice(0, 7)}..${(range.to ?? range.from).slice(0, 7)}` : ''
}

export interface Store {
  transport: Transport | null
  snapshot: Snapshot | null
  loading: boolean
  error: string | null
  settings: Settings
  tab: Tab
  panel: Panel | null
  /**
   * The panel was opened in a window too narrow to dock it (under 1012px), so it is a dialog until
   * closed, whatever the width later. A docked panel instead hides while the window is narrow.
   */
  panelDialog: boolean
  /** The file tree dialog (narrow windows, where the tree is not beside the diffs). */
  treeDialog: boolean
  /** "Finish your review" overlay is open. */
  reviewOpen: boolean
  /** Review being written; kept while the overlay is closed. */
  reviewDraft: { body: string; event: ReviewEvent; draft: boolean; error: string | null }
  lastReview: PersistedState['lastReview']
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
  /** Incremented on reload so late content responses are ignored. */
  generation: number
  checks: CheckState[]
  checksError: string | null
  existingPr: { loading: boolean; pr: ExistingPr | null; error: string | null } | null
  submitted: { result: ReviewResult; markdown: string } | null
  busy: string | null

  init(t: Transport): Promise<void>
  reload(q?: SnapshotQuery): Promise<void>
  setTab(t: Tab): void
  applySettings(s: Partial<Settings>, persist?: boolean): void
  setPanel(p: Panel | null): void
  setTreeDialog(open: boolean): void
  /** Opens the review overlay (optionally preselecting an event) or closes it with `null`. */
  openReview(e: ReviewEvent | null | undefined): void
  setReviewDraft(d: Partial<Store['reviewDraft']>): void
  setFilter(f: Partial<Store['filter']>): void
  toggleCollapsed(path: string, value?: boolean): void
  setGaps(path: string, gaps: Record<number, GapState> | undefined, whitespace: boolean): void
  toggleViewed(f: FileDiff): void
  ensureContents(f: FileDiff): void
  select(sel: Selection | null): void
  compose(t: CommentTarget | null): void
  addComment(c: Omit<ReviewComment, 'id' | 'createdAt' | 'commit' | 'view'>): void
  updateComment(id: string, body: string): void
  deleteComment(id: string): void
  setPr(title: string | null, body: string | null): void
  runCheck(name: string): Promise<CheckStatus>
  runAllChecks(): Promise<void>
  cancelCheck(name: string): Promise<void>
  findPr(): Promise<void>
  submit(event: ReviewEvent, body: string, publish?: { draft: boolean }): Promise<void>
}

let saveTimer: ReturnType<typeof setTimeout> | undefined
const checkWaiters = new Map<string, (s: CheckStatus) => void>()

function stateOf(s: Store): PersistedState {
  return { viewed: s.viewed, drafts: s.drafts, prTitle: s.prTitle, prBody: s.prBody, lastReview: s.lastReview }
}

/** Saves immediately (comments, viewed) or debounced (typing in title/description). */
function persist(get: () => Store, delay = 0) {
  clearTimeout(saveTimer)
  const save = () => {
    const s = get()
    if (s.transport && s.snapshot) void s.transport.saveState(s.snapshot, stateOf(s))
  }
  if (delay) saveTimer = setTimeout(save, delay)
  else save()
}

export const useStore = create<Store>((set, get) => ({
  transport: null,
  snapshot: null,
  loading: true,
  error: null,
  settings: loadSettings(),
  tab: 'files',
  panel: null,
  panelDialog: false,
  treeDialog: false,
  reviewOpen: false,
  reviewDraft: { body: '', event: 'COMMENT', draft: false, error: null },
  lastReview: null,
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
  generation: 0,
  checks: [],
  checksError: null,
  existingPr: null,
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
        lastReview: st.lastReview ?? null,
      })
    } catch (e) {
      set({ error: String(e), loading: false })
      return
    }
    if (!t.capabilities.checks) return
    // A broken .prv.toml only affects the Checks tab.
    try {
      const defs = await t.listChecks()
      set({ checks: defs.map((d) => ({ ...d, status: 'idle', output: '' })) })
    } catch (e) {
      set({ checksError: String(e) })
    }
    t.onCheckEvent((e) => {
      set((s) => ({
        checks: s.checks.map((c) => {
          if (c.name !== e.name) return c
          let output = e.status === 'running' ? '' : c.output
          if (e.chunk) {
            output += e.chunk
            if (output.length > MAX_CHECK_OUTPUT) output = '…\n' + output.slice(-MAX_CHECK_OUTPUT)
          }
          const done = e.status === 'success' || e.status === 'failure' || e.status === 'cancelled'
          return {
            ...c,
            status: e.status ?? c.status,
            exitCode: e.exitCode ?? c.exitCode,
            output,
            startedAt: e.status === 'running' ? new Date().toISOString() : c.startedAt,
            finishedAt: done ? new Date().toISOString() : c.finishedAt,
          }
        }),
      }))
      if (e.status === 'success' || e.status === 'failure' || e.status === 'cancelled') {
        checkWaiters.get(e.name)?.(e.status)
        checkWaiters.delete(e.name)
      }
    })
  },

  async reload(q) {
    const t = get().transport
    if (!t) return
    const range = q ?? get().range
    set({ loading: true, composing: null, selection: null })
    try {
      const snapshot = await t.getSnapshot(range)
      // Invalidate contents only once the new snapshot is current on both sides.
      set((s) => ({ snapshot, range, loading: false, generation: s.generation + 1, contents: {}, hl: {}, fileUI: {} }))
    } catch (e) {
      set({ error: String(e), loading: false })
    }
  },

  setTab: (tab) => {
    // A dialog panel belongs to the Files page it was opened on.
    set((s) => (tab !== 'files' && s.panelDialog ? { tab, panel: null, panelDialog: false } : { tab }))
    window.scrollTo({ top: 0 })
  },

  applySettings(s, persist = true) {
    const settings = { ...get().settings, ...s }
    if (persist) {
      // "Hide for this diff only" is never saved.
      const saved = { ...settings, hideWhitespace: settings.hideWhitespaceDiffOnly ? false : settings.hideWhitespace }
      delete saved.hideWhitespaceDiffOnly
      try {
        const prev = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}')
        if (settings.hideWhitespaceDiffOnly) saved.hideWhitespace = !!prev.hideWhitespace
      } catch {
        /* ignore */
      }
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(saved))
    }
    set({ settings })
  },

  setPanel: (panel) =>
    set((s) => {
      const wide = window.matchMedia('(min-width: 1012px)').matches
      // A docked panel hidden by a narrow window counts as closed (github.com shows "Open …").
      const visible = !!s.panel && (s.panelDialog || wide)
      // Decided when a panel opens; switching between visible panels keeps it.
      return { panel, panelDialog: !panel ? false : visible ? s.panelDialog : !wide }
    }),
  setTreeDialog: (treeDialog) => set({ treeDialog }),
  openReview: (e) => {
    if (e === null) {
      // Never close while pushing: the result (or error) must stay visible.
      if (!get().busy) set({ reviewOpen: false })
      return
    }
    if (get().tab !== 'files') get().setTab('files')
    // A kept draft may still say CONFIRM after switching to a commit range.
    const wanted = e ?? get().reviewDraft.event
    const event = wanted === 'CONFIRM' && !canConfirm(get()) ? 'COMMENT' : wanted
    set((s) => ({ reviewOpen: true, reviewDraft: { ...s.reviewDraft, event } }))
    if (event === 'CONFIRM') void get().findPr()
  },
  setReviewDraft: (d) => set((s) => ({ reviewDraft: { ...s.reviewDraft, ...d } })),

  setFilter: (f) => set((s) => ({ filter: { ...s.filter, ...f } })),

  toggleCollapsed: (path, value) =>
    set((s) => ({
      fileUI: { ...s.fileUI, [path]: { ...s.fileUI[path], collapsed: value ?? !s.fileUI[path]?.collapsed } },
    })),

  setGaps: (path, gaps, whitespace) =>
    set((s) => ({ fileUI: { ...s.fileUI, [path]: { ...s.fileUI[path], [whitespace ? 'gapsW' : 'gaps']: gaps } } })),

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
    const { transport, snapshot, contents, generation, loading } = get()
    if (!transport || !snapshot || loading || f.binary || f.submodule) return
    const sides: Array<['old' | 'new', string]> = []
    if (f.status !== 'added') sides.push(['old', f.oldPath ?? f.path])
    if (f.status !== 'deleted') sides.push(['new', f.path])
    for (const [side, path] of sides) {
      const key = `${side}:${path}`
      if (key in contents) continue
      set((s) => ({ contents: { ...s.contents, [key]: null } }))
      transport
        .getContents(path, side, snapshot)
        .then((text) => {
          if (get().generation !== generation) return
          set((s) => ({ contents: { ...s.contents, [key]: text } }))
          if (text != null)
            void highlightFile(text, path).then((lines) => {
              if (get().generation === generation) set((s) => ({ hl: { ...s.hl, [key]: lines } }))
            })
        })
        .catch(() => {
          /* contents stay null: no expansion / highlighting for this file */
        })
    }
  },

  select: (selection) => set({ selection }),
  compose: (composing) => set({ composing }),

  addComment(c) {
    const { snapshot, range } = get()
    const comment: ReviewComment = {
      ...c,
      id: Math.random().toString(36).slice(2, 10),
      createdAt: new Date().toISOString(),
      commit: range.to ?? snapshot!.head.sha,
      view: viewKey(range),
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
    persist(get, 300)
  },

  async runCheck(name) {
    const t = get().transport
    if (!t) return 'idle'
    set((s) => ({ checks: s.checks.map((c) => (c.name === name ? { ...c, status: 'queued', output: '' } : c)) }))
    const done = new Promise<CheckStatus>((resolve) => checkWaiters.set(name, resolve))
    try {
      await t.runCheck(name)
    } catch (e) {
      checkWaiters.delete(name)
      set((s) => ({
        checks: s.checks.map((c) => (c.name === name ? { ...c, status: 'failure', output: String(e) } : c)),
      }))
      return 'failure'
    }
    return done
  },

  async runAllChecks() {
    // One at a time: tools often share caches/locks (target/, .gradle) or modify files.
    for (const c of get().checks) {
      if ((await get().runCheck(c.name)) === 'cancelled') break
    }
  },

  async cancelCheck(name) {
    await get().transport?.cancelCheck(name)
  },

  async findPr() {
    const t = get().transport
    const cur = get().existingPr
    if (!t?.capabilities.publish || cur?.loading || (cur && !cur.error)) return
    set({ existingPr: { loading: true, pr: null, error: null } })
    try {
      set({ existingPr: { loading: false, pr: await t.findPr(), error: null } })
    } catch (e) {
      set({ existingPr: { loading: false, pr: null, error: String(e) } })
    }
  },

  async submit(event, body, publish) {
    const { transport, snapshot, drafts, prTitle, prBody } = get()
    if (!transport || !snapshot) return
    if (event === 'CONFIRM' && !canConfirm(get())) throw new Error('Confirm needs the native window and all commits selected.')
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
    clearTimeout(saveTimer)
    set({
      busy: null,
      submitted: { result, markdown },
      drafts: [],
      lastReview: { head: snapshot.head.sha, at: new Date().toISOString() },
      reviewDraft: { body: '', event: 'COMMENT', draft: false, error: null },
    })
    // Persist the cleared drafts *before* the native window exits (the native side clears them too).
    try {
      await transport.saveState(snapshot, stateOf(get()))
    } catch {
      /* never lose the review because of a failed save */
    }
    await transport.submit(result, markdown)
  },
}))

// Exposed for automated UI tests (tools/reference) and debugging.
;(window as unknown as { __prv: typeof useStore }).__prv = useStore
