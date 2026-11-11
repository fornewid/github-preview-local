// Opens the menus, submenus, panels and forms of the signed-in "Files changed" page one at a time and
// records a screenshot plus the structure and styles of what opened for each state: menus, dialogs,
// panels, hover, the inline comment form, the file tree and its filter, the merge status panel, an
// expanded hunk and the expander rows. Read-only: it never submits, marks files viewed or changes
// settings that GitHub stores server-side; anything it opens is closed again and the file tree is
// put back as it was.
//
//   node states.mjs <pull request URL> <outDir> [light|dark] [profileDir]
import fs from 'node:fs'
import { gotoGithub, openGithub, prBase, setTreeVisible, treeVisible } from './common.mjs'

const [, , prUrl, outDir, scheme = 'light', profileArg] = process.argv
// Captures hold your signed-in page: write them only where you choose (e.g. .ref/, ignored by git).
if (!prUrl || !outDir) {
  console.error('usage: node states.mjs <https://github.com/o/r/pull/N> <outDir> [light|dark] [profileDir]')
  process.exit(1)
}
fs.mkdirSync(outDir, { recursive: true })
const { ctx, page } = await openGithub({ scheme, scale: 2, profile: profileArg || undefined })
const base = prBase(prUrl)
const log = {}

const PROPS = ['font-size', 'font-weight', 'line-height', 'color', 'background-color', 'border', 'border-radius', 'padding', 'margin', 'box-shadow', 'width', 'height', 'gap', 'display', 'position']
// Everything rendered in a portal or overlay: menus, dialogs, panels.
const OVERLAYS = '[role="dialog"], [role="menu"], [role="listbox"], [class*="prc-Overlay"], [data-portal-root] > *, #__primerPortalRoot__ > *'

// Structure and styles of every visible element under `selector` (each element once), to <name>.json.
async function dump(name, selector = OVERLAYS) {
  const r = await page.evaluate(
    ([sel, props]) => {
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
      document.querySelectorAll(sel).forEach((e) => walk(e, 0))
      return out
    },
    [selector, PROPS],
  )
  fs.writeFileSync(`${outDir}/${name}.json`, JSON.stringify(r))
  return r.length
}

const shot = (name, opts = {}) => page.screenshot({ path: `${outDir}/${name}.png`, ...opts })
const settle = (ms = 700) => page.waitForTimeout(ms)
const go = (q = '/changes?diff=split') => gotoGithub(page, base + q)
async function close() {
  await page.keyboard.press('Escape')
  await settle(300)
}
// Opens a menu or dialog, records it and closes it.
async function state(name, fn, selector) {
  try {
    await fn()
    await settle()
    await shot(name)
    log[name] = { overlay: await dump(name, selector) }
  } catch (e) {
    log[name] = { error: e.message.split('\n')[0] }
  }
  await close()
}
// Runs a scripted step; its result (or error, with a screenshot) goes to the log.
async function step(name, fn) {
  try {
    log[name] = (await fn()) ?? 'ok'
  } catch (e) {
    log[name] = { error: e.message.split('\n')[0] }
    await shot(name + '-error').catch(() => {})
  }
}
const toolbarButton = (icon) => page.locator(`button:has(svg.octicon-${icon})`).first()
const byName = (name) => page.getByRole('button', { name }).first()

await go()
const treeWasVisible = await treeVisible(page)
await shot('00-split')
await state('01-commits-menu', () => page.locator('button', { hasText: 'All commits' }).first().click())
await state('02-settings-menu', () => toolbarButton('gear').click())
await state('03-submit-review', () => page.locator('button', { hasText: 'Submit review' }).first().click())
await state('04-file-menu', () => page.locator('table').first().locator('xpath=ancestor::*[contains(@class,"diff")][1]').locator('button:has(svg.octicon-kebab-horizontal)').first().click().catch(() => toolbarButton('kebab-horizontal').click()))
await state('05-preview-menu', () => page.locator('button', { hasText: 'Preview' }).first().click())

// Panels stay open until toggled again; github.com does not persist them, the file tree it does.
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
await setTreeVisible(page, true)
await shot('08-file-tree')
log['08-file-tree'] = { overlay: await dump('08-file-tree', '[role="tree"]') }
log.treeRestored = await setTreeVisible(page, treeWasVisible)

// Hover a changed line (the inline comment form is 16-comment-form below).
const row = page.locator('table tr.diff-line-row').nth(4)
await row.hover()
await settle(500)
await shot('09-hover-line')
log['09-hover-line'] = { overlay: await dump('09-hover-line', 'table tr.diff-line-row:nth-child(5)') }

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

// Submenus, the hover comment button, the inline comment form, the tree filter and the merge panel,
// from a fresh split page.
await go()

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
  await toolbarButton('gear').click()
  await settle(500)
  await page.locator('[role="menuitem"]', { hasText: 'Whitespace' }).first().click()
  await settle(600)
  await shot('14-whitespace-submenu')
  const n = await dump('14-whitespace-submenu')
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
  const html = await page.locator('tr.diff-line-row').nth(4).evaluate((r) => r.outerHTML.replace(/<path[^>]*><\/path>/g, ''))
  fs.writeFileSync(`${outDir}/15-hover-row.html`, html)
  return page.evaluate(() =>
    [...document.querySelectorAll('button')].filter((b) => b.getBoundingClientRect().width > 0 && b.closest('table')).map((b) => ({ aria: b.getAttribute('aria-label'), cls: b.className, box: (({ x, y, width, height }) => [x, y, width, height])(b.getBoundingClientRect()) })).slice(0, 20),
  )
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

// File tree filter menu, then the tree goes back as it was.
await step('17-tree-filter', async () => {
  await setTreeVisible(page, true)
  await page.locator('[role="tree"]').first().waitFor()
  await page.locator('button:has(svg.octicon-filter):visible').first().click()
  await settle(600)
  await shot('17-tree-filter')
  const n = await dump('17-tree-filter')
  await page.keyboard.press('Escape')
  await settle(300)
  await dump('17-tree', '[role="tree"]')
  await dump('17-tree-pane', '[class*="PageLayout-Pane"]')
  return n
})
await step('restore-tree', async () => ({ treeWasVisible, restored: await setTreeVisible(page, treeWasVisible) }))

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
