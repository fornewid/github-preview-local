// Native self-tests (the window itself, through Tauri IPC):
//
//   GH_PRV_LOCAL_SELFTEST=1 gh-prv-local
//       render, highlight and zoom, then exit with a report
//   GH_PRV_LOCAL_SELFTEST=flows gh-prv-local
//       also click through a commit range, the local checks and Confirm (push + pull request).
//       Only in a scratch repository prepared by scripts/native-selftest.sh (gh-prv-local
//       refuses otherwise).
import { canConfirm, useStore } from './store'
import { treeBesideNow } from './layout'
import { invoke } from './transport'

type Report = Record<string, unknown>

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(what: string, ok: () => unknown, ms = 20000) {
  void progress(`waiting: ${what}`)
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (ok()) return
    await sleep(100)
  }
  throw new Error(`timed out waiting for: ${what}`)
}
/** Like `until`, but carries on after the timeout: the report then shows what is wrong. */
const settle = (what: string, ok: () => unknown, ms?: number) => until(what, ok, ms).catch(() => {})
const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel)
const withText = (sel: string, text: string | RegExp, root: ParentNode = document) =>
  [...root.querySelectorAll<HTMLElement>(sel)].find((e) => (typeof text === 'string' ? e.textContent?.trim() === text : text.test(e.textContent ?? '')))
function click(el: Element | null | undefined, what: string) {
  if (!el) throw new Error(`not found: ${what}`)
  ;(el as HTMLElement).click()
}

/** A progress line on stdout (flows only), so a stuck step shows where it stopped. */
let verbose = false
function progress(step: string) {
  if (verbose) return invoke('selftest_log', { report: { progress: step, at: Math.round(performance.now()), visibility: document.visibilityState } })
}

/** Render, syntax highlighting and zoom (GH_PRV_LOCAL_SELFTEST=1). */
async function basic(): Promise<Report & { ok: boolean }> {
  const s = useStore.getState()
  // Zoom like Cmd+= does (not saved): the page must lay out for the smaller CSS width. A zoom the
  // user saved is already applied, so compute from the unzoomed width and restore it after.
  const saved = s.settings.zoom || 1
  const base = window.innerWidth * saved
  const zoomTo = (zoom: number) => useStore.setState((st) => ({ settings: { ...st.settings, zoom } }))
  // Zoomed and laid out again: the file tree is beside the diffs exactly when it fits.
  const zoomed = (zoom: number) => () =>
    Math.abs(window.innerWidth - base / zoom) < 2 && !!$('.FileTreePane') === (useStore.getState().settings.treeVisible && treeBesideNow())
  zoomTo(1.5)
  await settle('zoomed in', zoomed(1.5), 5000)
  // 1440px / 1.5 = 960px: the file tree must have left the side (it opens as a dialog there).
  const zoom = { base, zoomed: window.innerWidth, treePane: !!$('.FileTreePane') }
  zoomTo(saved)
  await settle('zoom restored', zoomed(saved), 5000)
  const highlighted = document.querySelectorAll('.pl-k, .pl-c, .pl-s, .pl-en').length
  const fonts = fontCheck()
  const menu = await menuCheck()
  const find = await findCheck()
  return {
    ok:
      !s.error &&
      !!s.snapshot &&
      highlighted > 0 &&
      Math.abs(zoom.zoomed - base / 1.5) < 2 &&
      (base / 1.5 >= 1076 || !zoom.treePane) &&
      Math.abs(window.innerWidth - base / saved) < 2 &&
      fonts.ok &&
      menu.ok &&
      find.ok,
    zoom,
    fonts,
    menu,
    find,
    error: s.error,
    files: s.snapshot?.files.length ?? 0,
    rows: document.querySelectorAll('.DiffTable tr').length,
    highlighted,
    checks: s.checks.map((c) => c.name),
    title: document.title,
  }
}

/**
 * The window draws text like github.com in Chrome: code in the font Chrome picks (it skips WebKit's
 * ui-monospace, which is SF Mono), default font smoothing and no kerning (text-rendering).
 */
function fontCheck() {
  const width = (family: string) => {
    const e = document.createElement('span')
    e.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;font-size:12px'
    e.style.fontFamily = family
    e.textContent = 'Wwiil0123 abcdefghij mmmm'
    document.body.append(e)
    const w = e.getBoundingClientRect().width
    e.remove()
    return Math.round(w * 100) / 100
  }
  const code = $('.diff-text-inner')
  const body = getComputedStyle(document.body)
  const r = {
    native: document.documentElement.classList.contains('prv-native'),
    code: code ? width(getComputedStyle(code).fontFamily) : 0,
    chrome: width("'Monaspace Neon', SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace"),
    sfMono: width('ui-monospace'),
    smoothing: body.getPropertyValue('-webkit-font-smoothing'),
    rendering: body.textRendering,
  }
  return { ...r, ok: r.native && r.code > 0 && r.code === r.chrome && r.smoothing === 'auto' && r.rendering.toLowerCase() === 'optimizespeed' }
}

/**
 * The settings menu fits its content (WebKit showed a horizontal scrollbar in it when Primer's
 * border-box base rule was missing).
 */
async function menuCheck() {
  click($('.ChangesToolbar-settings'), 'settings')
  await settle('settings menu', () => $('[role="menu"]'), 5000)
  const overlay = $('[role="menu"]')?.closest<HTMLElement>('[class*="Overlay"]')
  const r = { scrollWidth: overlay?.scrollWidth ?? 0, clientWidth: overlay?.clientWidth ?? 0 }
  click($('.ChangesToolbar-settings'), 'settings')
  await settle('settings menu closed', () => !$('[role="menu"]'), 3000)
  return { ...r, ok: r.clientWidth > 0 && r.scrollWidth <= r.clientWidth }
}

/** Cmd+F finds a word of the first diff line, paints the matches and marks the current one. */
async function findCheck() {
  const word = ($('.DiffEntry td[data-find] .diff-text-inner')?.textContent ?? '').match(/[A-Za-z_]{3,}/)?.[0]
  if (!word) return { ok: false, error: 'no code to search' }
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', code: 'KeyF', metaKey: true, ctrlKey: true, bubbles: true }))
  await settle('find bar', () => document.activeElement?.getAttribute('aria-label') === 'Find in changes', 3000)
  const input = document.activeElement as HTMLInputElement
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, word)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  const highlights = (CSS as unknown as { highlights?: Map<string, Set<Range>> }).highlights
  await settle('matches painted', () => (highlights?.get('prv-find')?.size ?? 0) > 0 && highlights?.get('prv-find-current')?.size === 1, 5000)
  const r = { word, count: $('.FindBar-count')?.textContent ?? '', painted: highlights?.get('prv-find')?.size ?? 0, current: highlights?.get('prv-find-current')?.size ?? 0 }
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await settle('find bar closed', () => !$('.FindBar'), 3000)
  return { ...r, ok: /^1\//.test(r.count) && r.painted > 0 && r.current === 1 && !$('.FindBar') }
}

/** All commits → one commit → All commits, through the commit picker dialog. */
async function commitRange(): Promise<Report> {
  const st = useStore.getState
  const commits = st().snapshot!.commits
  const one = commits[0]
  click($('.CommitPicker-button'), 'All commits button')
  await until('commit picker', () => withText('[role="dialog"] h1, [role="dialog"] h2', 'Select commits to view'))
  click(document.getElementById(`commit-${one.sha}`), 'commit checkbox')
  await sleep(200)
  click(withText('[role="dialog"] button', 'Save'), 'Save')
  await until('range loaded', () => st().range.from === one.sha && !st().loading)
  await sleep(500)
  const range = {
    subject: one.subject,
    files: st().snapshot!.files.map((f) => f.path),
    label: $('.CommitPicker-button')?.textContent?.trim(),
    confirmBlocked: !canConfirm(st()),
  }
  click($('.CommitPicker-button'), 'commit picker again')
  await until('commit picker', () => withText('[role="dialog"] h1, [role="dialog"] h2', 'Select commits to view'))
  const all = withText('[role="dialog"] li', /^All commits/)
  click(all?.querySelector('button') ?? all, 'All commits option')
  await sleep(200)
  click(withText('[role="dialog"] button', 'Save'), 'Save')
  await until('all commits again', () => !st().range.from && !st().loading)
  await sleep(500)
  return { ...range, allFilesAfter: st().snapshot!.files.map((f) => f.path), labelAfter: $('.CommitPicker-button')?.textContent?.trim() }
}

/** Run all → a passing and a failing check run, the slow one is cancelled from its Cancel button. */
async function localChecks(): Promise<Report> {
  const st = useStore.getState
  click($('a.TabNav-link[href="#checks"]'), 'Checks tab')
  await until('Run all', () => withText('button', 'Run all'))
  click(withText('button', 'Run all'), 'Run all')
  const status = (name: string) => st().checks.find((c) => c.name === name)?.status
  // Run all goes one check at a time; the slow one is last.
  await until('lint and unit finished', () => ['success', 'failure'].includes(status('lint') ?? '') && ['success', 'failure'].includes(status('unit') ?? ''), 60000)
  await until('slow check running', () => status('slow') === 'running', 30000)
  click(withText('.Checks-item', /slow/), 'slow check')
  await until('Cancel', () => withText('.CheckRun-header button', 'Cancel'))
  const cancelAt = Date.now()
  click(withText('.CheckRun-header button', 'Cancel'), 'Cancel')
  await until('slow check cancelled', () => status('slow') === 'cancelled', 15000)
  const cancelMs = Date.now() - cancelAt
  click(withText('.Checks-item', /unit/), 'unit check')
  await sleep(300)
  return {
    statuses: Object.fromEntries(st().checks.map((c) => [c.name, c.status])),
    exitCodes: Object.fromEntries(st().checks.map((c) => [c.name, c.exitCode ?? null])),
    unitLog: $('.CheckRun-log')?.textContent ?? '',
    cancelMs,
    header: $('.Checks-header')?.textContent?.trim(),
  }
}

/** Submit review → Confirm → "Confirm and create pull request": push and `gh pr create`. */
async function confirm(): Promise<void> {
  const st = useStore.getState
  click($('a.TabNav-link[href="#files"]'), 'Files changed tab')
  await sleep(500)
  click($('.ReviewButton'), 'Submit review')
  await until('review form', () => $('.ReviewForm'))
  click($('input[value="CONFIRM"]'), 'Confirm option')
  await until('open pull request lookup', () => st().existingPr && !st().existingPr!.loading)
  if (st().existingPr?.error) throw new Error(`pull request lookup failed: ${st().existingPr!.error}`)
  click($('.ReviewForm-submit'), 'Confirm and create pull request')
  await until('publishing started', () => st().busy || st().reviewDraft.error, 5000)
  // Success ends the app (the result goes to stdout); a failure is kept in the review draft. The
  // wait covers gh-prv-local's own timeouts: three gh calls (120s each) and the push (300s).
  await until('publish result', () => st().reviewDraft.error, 700000)
  throw new Error(`Confirm failed: ${st().reviewDraft.error}`)
}

export async function runSelftest(mode: true | 'flows') {
  try {
    // Loaded, rendered and highlighted (the report says what is missing if that never happens).
    await settle('first render', () => useStore.getState().error || $('.pl-k, .pl-c, .pl-s, .pl-en'))
    const report = await basic()
    if (mode !== 'flows' || !report.ok) return await invoke('selftest_done', { report })
    verbose = true
    const range = await commitRange()
    const checks = await localChecks()
    await invoke('selftest_log', { report: { stage: 'flows', range, checks } })
    await confirm()
  } catch (e) {
    // Every failure ends the run with a report, never a silent hang.
    await invoke('selftest_done', { report: { ok: false, stage: verbose ? 'flows' : 'basic', error: String(e) } }).catch(() => {})
  }
}
