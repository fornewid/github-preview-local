// Renders the README screenshots (docs/images) from a gh-prv-local export.
//
//   node docshots.mjs <preview.html> [outDir=../../docs/images]
import { chromium } from 'playwright-core'
import path from 'node:path'

const [, , file, outDir = new URL('../../docs/images', import.meta.url).pathname] = process.argv
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const url = 'file://' + path.resolve(file)

async function page(scheme, settings) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: scheme, locale: 'en-US' })
  const p = await ctx.newPage()
  await p.goto(url, { waitUntil: 'load' })
  await p.evaluate((s) => {
    localStorage.clear()
    localStorage.setItem('prv:settings', JSON.stringify({ diffView: 'split', compact: true, treeVisible: true, ...s }))
  }, settings)
  await p.goto(url, { waitUntil: 'load' })
  await p.waitForTimeout(2500)
  return p
}

let p = await page('light', {})
await p.screenshot({ path: `${outDir}/split-light.png` })
p = await page('light', { diffView: 'unified' })
await p.screenshot({ path: `${outDir}/unified-light.png` })
p = await page('dark', {})
await p.screenshot({ path: `${outDir}/split-dark.png` })

// Review: a pending comment, then "Finish your review".
p = await page('light', { treeVisible: false })
const cell = p.locator('td.right-side-diff-cell').nth(12)
await cell.hover()
await cell.getByRole('button', { name: 'Add comment' }).click()
await p.getByRole('textbox', { name: 'Add diff comment' }).fill('Use `mutableIntStateOf` only if this is always an `Int`.')
await p.getByRole('button', { name: 'Start a review' }).click()
await p.waitForTimeout(400)
await p.getByRole('button', { name: 'Submit review' }).click()
await p.getByRole('textbox', { name: 'Review body' }).fill('Looks good overall, one question about the state holder.')
await p.waitForTimeout(500)
await p.screenshot({ path: `${outDir}/review.png` })

p = await page('light', { treeVisible: false })
await p.getByRole('button', { name: 'Merge status' }).click()
await p.waitForTimeout(800)
await p.screenshot({ path: `${outDir}/merge-status.png` })
await browser.close()
console.log(`saved to ${outDir}`)
