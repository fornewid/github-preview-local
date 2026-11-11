// Captures, from a gh-prv-local export, the states of states.mjs that gh-prv-local has (00–04, 06, 08 and
// 12–18; not the Preview menu, the comments panel, the hovered line or the expanded hunk), under the
// same file names, so they can be compared side by side with the github.com captures (compare.py).
//
//   node local-states.mjs <preview.html> <outDir> [light|dark]
import fs from 'node:fs'
import { openChrome, openExport } from './common.mjs'

const [, , file, outDir = 'out', scheme = 'light'] = process.argv
fs.mkdirSync(outDir, { recursive: true })
const { browser, page } = await openChrome({ scheme, scale: 2 })
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
const settle = (ms = 600) => page.waitForTimeout(ms)
const shot = (n) => page.screenshot({ path: `${outDir}/${n}.png` })
// Viewed files and pending comments carry over from one open() to the next.
const open = (query = '?diff=split', settings = { treeVisible: false }) => openExport(page, file, { query, settings, clear: false, wait: 2500 })
async function step(name, fn) {
  try {
    await fn()
    await settle()
    await shot(name)
  } catch (e) {
    errors.push(`${name}: ${e.message.split('\n')[0]}`)
  }
  await page.keyboard.press('Escape')
  await settle(300)
}

await open()
await shot('00-split')
await step('01-commits-menu', () => page.locator('button', { hasText: 'All commits' }).first().click())
await step('02-settings-menu', () => page.getByRole('button', { name: 'Open diff view settings' }).click())
await step('03-submit-review', () => page.locator('button', { hasText: 'Submit review' }).first().click())
await step('04-file-menu', () => page.locator('.DiffFileHeader').first().getByRole('button', { name: 'More options' }).click())
await step('14-whitespace-submenu', async () => {
  await page.getByRole('button', { name: 'Open diff view settings' }).click()
  await settle(400)
  await page.locator('[role="menuitem"]', { hasText: 'Whitespace' }).first().click()
})
await page.keyboard.press('Escape')
await step('15-hover', async () => {
  const cell = page.locator('td.left-side-diff-cell').nth(3)
  await cell.hover()
})
await step('16-comment-form', async () => {
  const cell = page.locator('td.left-side-diff-cell').nth(3)
  await cell.hover()
  await settle(200)
  await cell.locator('button[aria-label="Add comment"]').click()
})
await page.locator('button', { hasText: /^Cancel$/ }).first().click().catch(() => {})
await step('06-overview-panel', () => page.getByRole('button', { name: 'Open overview panel' }).click())
await page.getByRole('button', { name: /Close overview/ }).first().click().catch(() => {})
await step('18-merge-status', () => page.locator('button', { hasText: 'Merge status' }).first().click())
await open('?diff=split', { treeVisible: true })
await shot('08-file-tree')
await step('17-tree-filter', () => page.getByRole('button', { name: 'Filter options' }).click())
await open('?diff=unified')
await shot('13-unified')
await page.evaluate(() => window.scrollTo(0, 1600))
await settle(800)
await shot('12-sticky')
fs.writeFileSync(`${outDir}/errors.json`, JSON.stringify(errors, null, 2))
console.log(errors.length ? errors.join('\n') : 'no errors')
await browser.close()
