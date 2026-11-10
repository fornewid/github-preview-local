// Opens the menus, panels and forms of the signed-in "Files changed" page one at a time and
// records a screenshot plus the overlay's structure and styles for each state. Read-only: it
// never submits, marks files viewed or changes settings that GitHub stores server-side.
//
//   node states.mjs <pull request URL> <outDir> [light|dark] [profileDir]
import { chromium } from 'playwright-core'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const [, , prUrl, outDir = 'out', scheme = 'light', profileArg] = process.argv
if (!prUrl) {
  console.error('usage: node states.mjs <https://github.com/o/r/pull/N> <outDir> [light|dark] [profileDir]')
  process.exit(1)
}
const profile = profileArg || path.join(os.homedir(), '.cache', 'prv-reference', 'chrome-profile')
fs.mkdirSync(outDir, { recursive: true })
const ctx = await chromium.launchPersistentContext(profile, {
  channel: 'chrome',
  headless: true,
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  colorScheme: scheme,
  locale: 'en-US',
  ignoreDefaultArgs: ['--use-mock-keychain'],
})
const page = ctx.pages()[0] || (await ctx.newPage())
const base = prUrl.replace(/\/(files|changes).*$/, '').replace(/\/$/, '')
const log = {}

const PROPS = ['font-size', 'font-weight', 'line-height', 'color', 'background-color', 'border', 'border-radius', 'padding', 'box-shadow', 'width', 'height', 'gap']

// Structure of everything rendered in a portal/overlay (menus, dialogs, panels) or under `root`.
async function dump(name, root) {
  const r = await page.evaluate(
    ([root, props]) => {
      const roots = root
        ? [...document.querySelectorAll(root)]
        : [...document.querySelectorAll('[role="dialog"], [role="menu"], [role="listbox"], [class*="prc-Overlay"], [data-portal-root] > *, #__primerPortalRoot__ > *')]
      const out = []
      const seen = new Set()
      const walk = (e, d) => {
        if (seen.has(e) || out.length > 3000) return
        seen.add(e)
        const cs = getComputedStyle(e)
        const b = e.getBoundingClientRect()
        if (b.width === 0 && b.height === 0 && cs.display !== 'contents') return
        out.push({
          d,
          tag: e.tagName.toLowerCase(),
          cls: (e.getAttribute('class') || '').slice(0, 160),
          role: e.getAttribute('role') || undefined,
          aria: e.getAttribute('aria-label') || undefined,
          text: [...e.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(' ').slice(0, 80) || undefined,
          box: [b.x, b.y, b.width, b.height].map((v) => Math.round(v * 10) / 10),
          s: Object.fromEntries(props.map((p) => [p, cs.getPropertyValue(p)])),
        })
        for (const c of e.children) walk(c, d + 1)
      }
      roots.forEach((x) => walk(x, 0))
      return out
    },
    [root, PROPS],
  )
  fs.writeFileSync(`${outDir}/${name}.json`, JSON.stringify(r))
  return r.length
}

const shot = (name, opts = {}) => page.screenshot({ path: `${outDir}/${name}.png`, ...opts })
const settle = (ms = 700) => page.waitForTimeout(ms)
async function go(q = '/changes?diff=split') {
  await page.goto(base + q, { waitUntil: 'domcontentloaded', timeout: 90000 })
  await page.waitForSelector('table', { timeout: 60000 })
  await settle(3000)
}
async function close() {
  await page.keyboard.press('Escape')
  await settle(300)
}
async function state(name, fn, root) {
  try {
    await fn()
    await settle()
    await shot(name)
    log[name] = { overlay: await dump(name, root) }
  } catch (e) {
    log[name] = { error: e.message.split('\n')[0] }
  }
  await close()
}
const toolbarButton = (icon) => page.locator(`button:has(svg.octicon-${icon})`).first()

await go()
await shot('00-split')
await state('01-commits-menu', () => page.locator('button', { hasText: 'All commits' }).first().click())
await state('02-settings-menu', () => toolbarButton('gear').click())
await state('03-submit-review', () => page.locator('button', { hasText: 'Submit review' }).first().click())
await state('04-file-menu', () => page.locator('table').first().locator('xpath=ancestor::*[contains(@class,"diff")][1]').locator('button:has(svg.octicon-kebab-horizontal)').first().click().catch(() => toolbarButton('kebab-horizontal').click()))
await state('05-preview-menu', () => page.locator('button', { hasText: 'Preview' }).first().click())

// Panels stay open until toggled again; github.com does not persist them, the file tree it does.
const treeVisible = () =>
  page.evaluate(() => {
    const t = document.querySelector('[role="tree"]')
    return !!t && t.getBoundingClientRect().width > 0
  })
const treeWasVisible = await treeVisible()
const byName = (name) => page.getByRole('button', { name }).first()
await byName('Open overview panel').click()
await settle(1500)
await shot('06-overview-panel')
log['06-overview-panel'] = { overlay: await dump('06-overview-panel', 'body') }
await byName('Close overview panel').click()
await settle(800)
await byName('Open comments panel').click()
await settle(1500)
await shot('07-comments-panel')
await byName('Close comments panel').click()
await settle(800)
if (!treeWasVisible) {
  await byName('Expand file tree').click()
  await settle(1500)
}
await shot('08-file-tree')
log['08-file-tree'] = { overlay: await dump('08-file-tree', '[role="tree"]') }
if (!treeWasVisible) {
  await byName('Collapse file tree').click()
  await settle(1500)
}
log.treeRestored = (await treeVisible()) === treeWasVisible

// Hover a changed line, then open (and cancel) an inline comment form.
const row = page.locator('table tr.diff-line-row').nth(4)
await row.hover()
await settle(500)
await shot('09-hover-line')
log['09-hover-line'] = { overlay: await dump('09-hover-line', 'table tr.diff-line-row:nth-child(5)') }
// The inline comment form is captured by states2.mjs.

// Expand the first hunk upwards.
const up = page.locator('button[aria-label^="Expand file up"]').first()
if (await up.count()) {
  await up.click()
  await settle(1500)
  await shot('11-expanded')
  log['11-expanded'] = { overlay: await dump('11-expanded', 'table tbody tr:nth-child(-n+3)') }
}

// Sticky header while scrolled.
await page.evaluate(() => window.scrollTo(0, 1600))
await settle(1000)
await shot('12-sticky')
log['12-sticky'] = { overlay: await dump('12-sticky', '[class*="sticky" i], [class*="Sticky"]') }

await go('/changes?diff=unified')
await shot('13-unified')
fs.writeFileSync(`${outDir}/log.json`, JSON.stringify(log, null, 2))
console.log(JSON.stringify(log, null, 2))
await ctx.close()
