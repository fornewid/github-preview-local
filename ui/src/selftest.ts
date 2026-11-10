// Native self-tests (the window itself, through Tauri IPC):
//
//   PRV_SELFTEST=1 prv       render, highlight and zoom, then exit with a report
//   PRV_SELFTEST=flows prv   also click through a commit range, the local checks and Confirm
//                            (push + pull request). Only in a scratch repository prepared by
//                            scripts/native-selftest.sh (prv refuses otherwise).
import { canConfirm, useStore } from './store'

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
const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel)
const withText = (sel: string, text: string | RegExp, root: ParentNode = document) =>
  [...root.querySelectorAll<HTMLElement>(sel)].find((e) => (typeof text === 'string' ? e.textContent?.trim() === text : text.test(e.textContent ?? '')))
function click(el: Element | null | undefined, what: string) {
  if (!el) throw new Error(`not found: ${what}`)
  ;(el as HTMLElement).click()
}

async function invoke(cmd: string, args: Record<string, unknown>) {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke(cmd, args)
}

/** A progress line on stdout (flows only), so a stuck step shows where it stopped. */
let verbose = false
function progress(step: string) {
  if (verbose) return invoke('selftest_log', { report: { progress: step, at: Math.round(performance.now()), visibility: document.visibilityState } })
}

/** Render, syntax highlighting and zoom (PRV_SELFTEST=1). */
async function basic(): Promise<Report & { ok: boolean }> {
  const s = useStore.getState()
  // Zoom like Cmd+= does (not saved): the page must lay out for the smaller CSS width. A zoom the
  // user saved is already applied, so compute from the unzoomed width and restore it after.
  const saved = s.settings.zoom || 1
  const base = window.innerWidth * saved
  s.applySettings({ zoom: 1.5 }, false)
  await sleep(1200)
  // 1440px / 1.5 = 960px: the file tree must have left the side (it opens as a dialog there).
  const zoom = { base, zoomed: window.innerWidth, treePane: !!$('.FileTreePane') }
  s.applySettings({ zoom: saved }, false)
  await sleep(600)
  const highlighted = document.querySelectorAll('.pl-k, .pl-c, .pl-s, .pl-en').length
  return {
    ok:
      !s.error &&
      !!s.snapshot &&
      highlighted > 0 &&
      Math.abs(zoom.zoomed - base / 1.5) < 2 &&
      (base / 1.5 >= 1076 || !zoom.treePane) &&
      Math.abs(window.innerWidth - base / saved) < 2,
    zoom,
    error: s.error,
    files: s.snapshot?.files.length ?? 0,
    rows: document.querySelectorAll('.DiffTable tr').length,
    highlighted,
    checks: s.checks.map((c) => c.name),
    title: document.title,
  }
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
  // Success ends the app (the result goes to stdout); a failure is kept in the review draft. The
  // wait covers prv's own push (300s) and gh (120s) timeouts.
  await until('publish result', () => st().reviewDraft.error, 450000)
  throw new Error(`Confirm failed: ${st().reviewDraft.error}`)
}

export async function runSelftest(mode: true | 'flows') {
  try {
    await sleep(4000)
    const report = await basic()
    if (mode !== 'flows' || !report.ok) return await invoke('selftest_done', { report })
    verbose = true
    const range = await commitRange()
    const checks = await localChecks()
    await invoke('selftest_log', { report: { stage: 'flows', range, checks } })
    await confirm()
  } catch (e) {
    // Every failure ends the run with a report, never a silent hang.
    await invoke('selftest_done', { report: { ok: false, stage: mode === 'flows' ? 'flows' : 'basic', error: String(e) } }).catch(() => {})
  }
}
