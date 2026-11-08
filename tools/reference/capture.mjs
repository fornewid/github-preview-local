// Captures a github.com pull request "Files changed" page with the local Chrome:
// screenshots of the main states and computed styles of the key elements.
//
//   node capture.mjs https://github.com/<owner>/<repo>/pull/<n>/files out/
import { chromium } from 'playwright-core'
import fs from 'node:fs'

const [, , url, outDir = 'out', scheme = 'light'] = process.argv
if (!url) {
  console.error('usage: node capture.mjs <pull request files URL> [outDir] [light|dark]')
  process.exit(1)
}
fs.mkdirSync(outDir, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: scheme, locale: 'en-US' })
const page = await ctx.newPage()
const base = url.replace(/\?.*$/, '')
const go = async (q) => {
  await page.goto(base + q, { waitUntil: 'networkidle', timeout: 60000 })
  await page.waitForTimeout(1500)
}
const close = () => page.click('body', { position: { x: 5, y: 600 } })

await go('?diff=split&w=0')
await page.screenshot({ path: `${outDir}/split.png` })
for (const [name, sel] of [
  ['gear', '.pr-toolbar details-toggle summary'],
  ['commits-menu', '.diffbar-range-menu summary'],
  ['file-filter', 'file-filter summary'],
  ['file-menu', '.js-file-header-dropdown summary'],
]) {
  const el = await page.$(sel)
  if (!el) continue
  await el.click()
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${outDir}/${name}.png` })
  await close()
}
await page.evaluate(() => window.scrollTo(0, 1500))
await page.waitForTimeout(500)
await page.screenshot({ path: `${outDir}/split-scrolled.png` })
await go('?diff=unified&w=0')
await page.screenshot({ path: `${outDir}/unified.png` })

const sels = {
  title: 'h1.gh-header-title', tab: '.tabnav-tab', toolbar: '.pr-toolbar', fileHeader: '.file-header', num: '.blob-num-context',
  numAdd: '.blob-num-addition', numDel: '.blob-num-deletion', code: '.blob-code-context', codeAdd: '.blob-code-addition',
  codeDel: '.blob-code-deletion', hunk: '.blob-code-hunk', expander: '.blob-num-expandable', inner: '.blob-code-inner', word: '.blob-code-addition .x',
}
const props = ['font-family', 'font-size', 'font-weight', 'line-height', 'color', 'background-color', 'padding', 'border', 'border-radius', 'width', 'height']
const styles = {}
for (const [k, s] of Object.entries(sels)) {
  styles[k] = await page.evaluate(([s, props]) => {
    const e = document.querySelector(s)
    if (!e) return null
    const cs = getComputedStyle(e)
    return Object.fromEntries(props.map((p) => [p, cs.getPropertyValue(p)]))
  }, [s, props])
}
fs.writeFileSync(`${outDir}/styles.json`, JSON.stringify(styles, null, 2))
await browser.close()
console.log(`saved to ${outDir}`)
