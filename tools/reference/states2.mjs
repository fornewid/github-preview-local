// More states of the signed-in "Files changed" page: submenus, the hover comment button, the
// inline comment form, the file tree filter, the merge status panel and the expander rows.
// Read-only; anything it opens is closed again and the file tree is restored.
//
//   node states2.mjs <pull request URL> <outDir> [light|dark]
import { chromium } from 'playwright-core'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const [, , prUrl, outDir = 'out', scheme = 'light'] = process.argv
fs.mkdirSync(outDir, { recursive: true })
const ctx = await chromium.launchPersistentContext(path.join(os.homedir(), '.cache', 'prv-reference', 'chrome-profile'), {
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
const PROPS = ['font-size', 'font-weight', 'line-height', 'color', 'background-color', 'border', 'border-radius', 'padding', 'margin', 'box-shadow', 'width', 'height', 'gap', 'display', 'position']
const settle = (ms = 700) => page.waitForTimeout(ms)
const shot = (n) => page.screenshot({ path: `${outDir}/${n}.png` })
async function dump(name, selector) {
  const r = await page.evaluate(
    ([sel, props]) => {
      const out = []
      const walk = (e, d) => {
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
      document.querySelectorAll(sel).forEach((e) => walk(e, 0))
      return out
    },
    [selector, PROPS],
  )
  fs.writeFileSync(`${outDir}/${name}.json`, JSON.stringify(r))
  return r.length
}
const overlays = '[role="dialog"], [role="menu"], [class*="prc-Overlay"]'
async function step(name, fn) {
  try {
    log[name] = (await fn()) ?? 'ok'
  } catch (e) {
    log[name] = { error: e.message.split('\n')[0] }
    await shot(name + '-error').catch(() => {})
  }
}
await page.goto(base + '/changes?diff=split', { waitUntil: 'domcontentloaded', timeout: 90000 })
await page.waitForSelector('table', { timeout: 60000 })
await settle(3000)
const treeWasVisible = await page.evaluate(() => {
  const t = document.querySelector('[role="tree"]')
  return !!t && t.getBoundingClientRect().width > 0
})

// Expander rows (exact markup).
await step('expander-rows', async () => {
  const html = await page.evaluate(() =>
    [...document.querySelectorAll('tr.diff-line-row')].filter((r) => r.querySelector('button[aria-label^="Expand"]')).map((r) => r.outerHTML.replace(/<path[^>]*><\/path>/g, '')),
  )
  fs.writeFileSync(`${outDir}/expander-rows.html`, html.join('\n\n'))
  return html.length
})

// Settings: whitespace submenu.
await step('14-whitespace-submenu', async () => {
  await page.locator('button:has(svg.octicon-gear)').first().click()
  await settle(500)
  await page.locator('[role="menuitem"]', { hasText: 'Whitespace' }).first().click()
  await settle(600)
  await shot('14-whitespace-submenu')
  const n = await dump('14-whitespace-submenu', overlays)
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await settle(400)
  return n
})

// Hover a deletion line and find the add-comment affordance.
await step('15-hover', async () => {
  const cell = page.locator('td.left-side-diff-cell').nth(3)
  await cell.scrollIntoViewIfNeeded()
  await cell.hover()
  await settle(500)
  await shot('15-hover')
  const row = page.locator('tr.diff-line-row').nth(4)
  const html = await row.evaluate((r) => r.outerHTML.replace(/<path[^>]*><\/path>/g, ''))
  fs.writeFileSync(`${outDir}/15-hover-row.html`, html)
  const buttons = await page.evaluate(() =>
    [...document.querySelectorAll('button')].filter((b) => b.getBoundingClientRect().width > 0 && b.closest('table')).map((b) => ({ aria: b.getAttribute('aria-label'), cls: b.className, box: (({ x, y, width, height }) => [x, y, width, height])(b.getBoundingClientRect()) })).slice(0, 20),
  )
  return buttons
})

await step('16-comment-form', async () => {
  const btn = page.locator('table button[aria-label*="comment" i]:visible, table button:has(svg.octicon-plus):visible').first()
  if (!(await btn.count())) return 'no add-comment button'
  await btn.click()
  await settle(1200)
  await shot('16-comment-form')
  const n = await dump('16-comment-form', 'table form, table [class*="Comment" i]:not(tr), [class*="InlineComment" i], [class*="inline-comment" i]')
  const cancel = page.locator('button', { hasText: /^Cancel$/ }).first()
  if (await cancel.count()) {
    await cancel.click()
    await settle(500)
    const discard = page.locator('button', { hasText: /Discard|Yes/ }).first()
    if (await discard.count()) await discard.click()
  }
  await settle(400)
  return n
})

// File tree filter menu, then restore the tree.
await step('17-tree-filter', async () => {
  if (!treeWasVisible) {
    await page.locator('button[aria-label="Expand file tree"]:visible, [data-testid="expand-file-tree-button"]:visible').first().click()
    await settle(1200)
  }
  await page.locator('[role="tree"]').first().waitFor()
  const filterBtn = page.locator('button:has(svg.octicon-filter):visible').first()
  await filterBtn.click()
  await settle(600)
  await shot('17-tree-filter')
  const n = await dump('17-tree-filter', overlays)
  await page.keyboard.press('Escape')
  await settle(300)
  await dump('17-tree', '[role="tree"]')
  await dump('17-tree-pane', '[class*="PageLayout-Pane"]')
  return n
})
await step('restore-tree', async () => {
  const visible = await page.evaluate(() => {
    const t = document.querySelector('[role="tree"]')
    return !!t && t.getBoundingClientRect().width > 0
  })
  if (visible !== treeWasVisible) {
    await page.locator(visible ? 'button[aria-label="Collapse file tree"]:visible, button:has(svg.octicon-sidebar-expand):visible' : 'button[aria-label="Expand file tree"]:visible').first().click()
    await settle(1500)
  }
  return { treeWasVisible }
})

// Merge status panel.
await step('18-merge-status', async () => {
  await page.locator('button', { hasText: 'Merge status' }).first().click()
  await settle(2000)
  await shot('18-merge-status')
  const n = await dump('18-merge-status', '[class*="Panel" i][class*="Content" i], aside, [role="complementary"]')
  const close = page.locator('button[aria-label^="Close" i]:visible').first()
  if (await close.count()) await close.click()
  await settle(500)
  return n
})

fs.writeFileSync(`${outDir}/log.json`, JSON.stringify(log, null, 2))
console.log(JSON.stringify(log, null, 2))
await ctx.close()
