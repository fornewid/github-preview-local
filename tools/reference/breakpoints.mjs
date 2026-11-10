// Finds the window widths at which the "Files changed" page changes layout (file tree beside the
// diffs or in a dialog, header actions above the title, shortened labels, overflow menu, compact
// file headers, …) on github.com and on a prv export, and prints them side by side.
//
//   node breakpoints.mjs <pull request URL> <preview.html> [--from 1600] [--to 320] [--panel]
//
// --panel sweeps with the Overview side panel open (it docks from 1012px and changes, for
// example, the width at which the file tree leaves the side).
//
// Features are detected by accessible names and visible text, which prv keeps identical to
// github.com, so one detector serves both pages. Widths are CSS pixels; browser zoom (and the
// native window's zoom) moves along the same thresholds.
//
// github.com is read with the signed-in profile from login.mjs and only read: the file tree is
// expanded for the run (needed to see when it moves into a dialog) and collapsed again if it was.
import { chromium } from 'playwright-core'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const opt = (name, def) => {
  const i = args.indexOf(name)
  return i >= 0 ? Number(args.splice(i, 2)[1]) : def
}
const from = opt('--from', 1600)
const to = opt('--to', 320)
const panelFlag = args.indexOf('--panel')
const withPanel = panelFlag >= 0
if (withPanel) args.splice(panelFlag, 1)
const [prUrl, exportFile] = args
if (!prUrl || !exportFile) {
  console.error('usage: node breakpoints.mjs <https://github.com/o/r/pull/N> <preview.html> [--from 1600] [--to 320] [--panel]')
  process.exit(1)
}

/** Runs in the page: the state of every responsive feature at the current width. */
function features() {
  const name = (b) =>
    (b.getAttribute('aria-label') ||
      (b.getAttribute('aria-labelledby') || '')
        .split(' ')
        .map((id) => document.getElementById(id)?.textContent || '')
        .join(' ')
        .trim() ||
      b.innerText ||
      '')
      .replace(/\s+/g, ' ')
      .trim()
  const vis = (e) => {
    if (!e) return false
    const r = e.getBoundingClientRect()
    return r.width > 2 && r.height > 2 && getComputedStyle(e).visibility !== 'hidden'
  }
  const buttons = [...document.querySelectorAll('button')].filter(vis)
  const btn = (re, root) => buttons.find((b) => re.test(name(b)) && (!root || root.contains(b)))
  const text = (re, root = document.body) =>
    [...root.querySelectorAll('*')].find((e) => vis(e) && [...e.childNodes].some((n) => n.nodeType === 3 && re.test(n.textContent.trim())))
  const toggle = btn(/^(Expand|Collapse) file tree$/)
  const toolbar = toggle?.closest('section')
  const fileHeader = (() => {
    const c = btn(/^Collapse file$/) || btn(/^Expand file$/)
    let e = c?.parentElement
    while (e && !btn(/^(Not )?Viewed$/, e)) e = e.parentElement
    return e
  })()
  const tree = document.querySelector('[role="tree"]')
  const h1 = document.querySelector('h1')
  const merge = btn(/^(Merge status|Status)$/)
  const review = btn(/^(Submit review|Review)$/)
  const viewed = btn(/^(Not )?Viewed$/, fileHeader)
  const progress = toolbar && [...toolbar.querySelectorAll('*')].find((e) => vis(e) && /^\d+ \/ \d+( viewed)?$/.test(e.textContent.trim()))
  const tab = [...document.querySelectorAll('nav a')].find((a) => /^Conversation/.test(a.textContent.trim()) && vis(a))
  // The state label next to "… wants to merge …" (github.com also has a "Preview" feature button).
  const summary = text(/wants to merge/)
  let meta = summary?.parentElement
  for (let i = 0; i < 5 && meta && !text(/^(Open|Preview|Draft|Closed|Merged)$/, meta); i++) meta = meta.parentElement
  const state = meta && text(/^(Open|Preview|Draft|Closed|Merged)$/, meta)
  const toolbarTop = toolbar?.getBoundingClientRect().top ?? 0
  return {
    'tree beside diffs': vis(tree) && !tree.closest('[role="dialog"]'),
    'actions above title': !!merge && !!h1 && merge.getBoundingClientRect().top < h1.getBoundingClientRect().top,
    'merge status label': merge ? name(merge) : null,
    'tab diffstat': !!text(/^\+[\d,]+$/) && text(/^\+[\d,]+$/).getBoundingClientRect().top < toolbarTop,
    'tab icons': !!tab && vis(tab.querySelector('svg')),
    'state above summary': !!state && !!summary && summary.getBoundingClientRect().top >= state.getBoundingClientRect().bottom - 4,
    'review label': review ? name(review) : null,
    'viewed word': !!toolbar && !!text(/^viewed$/, toolbar),
    'viewed progress': !!progress,
    'all commits button': !!btn(/^All commits$/, toolbar),
    'settings button': !!btn(/^Open diff view settings$/, toolbar),
    'comments button': !!btn(/^(Open|Close) comments panel$/, toolbar),
    'overflow menu': !!btn(/^More options$/, toolbar),
    'file: comment button': !!btn(/^Comment on this file$/, fileHeader),
    'file: copy button': !!btn(/^Copy file name/, fileHeader),
    'file: stats': !!fileHeader && !!text(/^\+[\d,]+$/, fileHeader),
    'file: viewed label': !!viewed && /Viewed/.test(viewed.innerText),
    'page padding': h1 ? Math.round(h1.getBoundingClientRect().left) : null,
    'horizontal overflow': document.documentElement.scrollWidth > window.innerWidth + 1,
  }
}

async function openPanel(page) {
  if (!withPanel) return
  await page.getByRole('button', { name: 'Open overview panel' }).first().click()
  await page.waitForTimeout(1200)
}

let interrupted = false

async function sweep(page) {
  const at = async (w) => {
    if (interrupted) throw new Error('interrupted')
    await page.setViewportSize({ width: w, height: 900 })
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.waitForTimeout(300)
    return page.evaluate(features)
  }
  const grid = []
  for (let w = from; w >= to; w -= 16) grid.push([w, await at(w)])
  if (grid.at(-1)[0] !== to) grid.push([to, await at(to)])
  const changes = []
  for (const k of Object.keys(grid[0][1])) {
    for (let i = 1; i < grid.length; i++) {
      const a = JSON.stringify(grid[i - 1][1][k])
      if (a === JSON.stringify(grid[i][1][k])) continue
      let hi = grid[i - 1][0]
      let lo = grid[i][0]
      while (hi - lo > 1) {
        const m = (hi + lo) >> 1
        if (JSON.stringify((await at(m))[k]) === a) hi = m
        else lo = m
      }
      changes.push({ feature: k, width: hi, from: grid[i - 1][1][k], to: (await at(lo))[k] })
    }
  }
  return { first: grid[0][1], changes }
}

const treeOn = (page) =>
  page.evaluate(() => {
    const t = document.querySelector('[role="tree"]')
    return !!t && t.getBoundingClientRect().width > 0 && !t.closest('[role="dialog"]')
  })

async function github() {
  const ctx = await chromium.launchPersistentContext(path.join(os.homedir(), '.cache', 'prv-reference', 'chrome-profile'), {
    channel: 'chrome',
    headless: true,
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    ignoreDefaultArgs: ['--use-mock-keychain'],
    // Ctrl-C must not close the browser before the file tree is restored (below).
    handleSIGINT: false,
    handleSIGTERM: false,
  })
  const page = ctx.pages()[0] || (await ctx.newPage())
  const url = prUrl.replace(/\/(files|changes).*$/, '').replace(/\/$/, '') + '/changes?diff=split'
  // github.com keeps the file tree's visibility per user: put it back however the run ends (the
  // side panel is not kept, a reload closes it). Runs once, after the sweep has stopped.
  let initial = true
  let restoring
  const restore = () =>
    (restoring ??= (async () => {
      try {
        await page.setViewportSize({ width: 1440, height: 900 })
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 })
        await page.waitForSelector('table', { timeout: 60000 })
        await page.waitForTimeout(2000)
        if (!initial && (await treeOn(page))) {
          await page.getByRole('button', { name: 'Collapse file tree' }).first().click()
          await page.waitForTimeout(1500)
        }
      } finally {
        await ctx.close()
      }
    })())
  const onSignal = () => {
    if (interrupted) process.exit(130) // second Ctrl-C: give up
    interrupted = true
    console.error('\ninterrupted: restoring the file tree on github.com… (Ctrl-C again to quit now)')
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 })
    await page.waitForSelector('table', { timeout: 60000 })
    await page.waitForTimeout(3000)
    initial = await treeOn(page)
    if (!initial) {
      await page.getByRole('button', { name: 'Expand file tree' }).first().click()
      await page.waitForTimeout(1200)
    }
    await openPanel(page)
    return await sweep(page)
  } finally {
    await restore()
    process.removeListener('SIGINT', onSignal)
    process.removeListener('SIGTERM', onSignal)
    if (interrupted) process.exit(130)
  }
}

async function prv() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-US' })).newPage()
  const url = 'file://' + path.resolve(exportFile) + '?diff=split'
  await page.goto(url, { waitUntil: 'load' })
  await page.evaluate(() => {
    localStorage.clear()
    localStorage.setItem('prv:settings', JSON.stringify({ diffView: 'split', compact: true, treeVisible: true }))
  })
  await page.goto(url, { waitUntil: 'load' })
  await page.waitForTimeout(2000)
  try {
    await openPanel(page)
    return await sweep(page)
  } finally {
    await browser.close()
  }
}

const [gh, local] = [await github(), await prv()]
const key = (c) => `${c.feature}: ${JSON.stringify(c.from)} → ${JSON.stringify(c.to)}`
const rows = new Map()
for (const c of gh.changes) rows.set(key(c), { change: key(c), github: c.width })
for (const c of local.changes) rows.set(key(c), { ...(rows.get(key(c)) ?? { change: key(c) }), prv: c.width })
const sorted = [...rows.values()].sort((a, b) => (b.github ?? b.prv) - (a.github ?? a.prv))
let mismatches = 0
// github.com's own header (Status, Code, Preview buttons) overflows very narrow windows; prv not overflowing is fine.
const tolerated = (r) => r.change.startsWith('horizontal overflow') && r.prv === undefined
console.log(`Changes between ${from}px and ${to}px${withPanel ? ', side panel open' : ''} (the width is the narrowest window that still has the "from" state)\n`)
for (const r of sorted) {
  const ok = r.github === r.prv || tolerated(r)
  if (!ok) mismatches++
  console.log(`${r.github === r.prv ? '  ' : ok ? '~ ' : '✗ '}${String(r.github ?? '-').padStart(5)} ${String(r.prv ?? '-').padStart(5)}  ${r.change}`)
}
const firstDiff = Object.keys(gh.first).filter((k) => k !== 'page padding' && JSON.stringify(gh.first[k]) !== JSON.stringify(local.first[k]))
if (firstDiff.length) console.log(`\nDifferent at ${from}px: ${firstDiff.join(', ')}`)
console.log(`\n${mismatches ? `${mismatches} differences` : 'identical'} (columns: github.com, prv)`)
process.exit(mismatches || firstDiff.length ? 1 : 0)
