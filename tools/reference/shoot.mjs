// Screenshots a prv export (`prv export -o preview.html`) at the same size as capture.mjs.
//
//   node shoot.mjs preview.html out/ [split|unified] [light|dark]
import { chromium } from 'playwright-core'
import fs from 'node:fs'
import path from 'node:path'

const [, , file, outDir = 'out', diff = 'split', scheme = 'light'] = process.argv
if (!file) {
  console.error('usage: node shoot.mjs <preview.html> [outDir] [split|unified] [light|dark]')
  process.exit(1)
}
fs.mkdirSync(outDir, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await (
  await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: scheme, locale: 'en-US' })
).newPage()
page.on('pageerror', (e) => console.error('pageerror:', e.message))
await page.goto(`file://${path.resolve(file)}?diff=${diff}`, { waitUntil: 'load' })
await page.waitForTimeout(2500)
await page.screenshot({ path: `${outDir}/prv-${diff}-${scheme}.png` })
await browser.close()
console.log(`saved to ${outDir}`)
