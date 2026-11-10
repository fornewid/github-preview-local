// Captures the signed-in "Files changed" page (the new experience) with the profile from login.mjs:
// viewport/full-page screenshots and a structural style snapshot (tag, role, test id, aria label,
// box and computed styles of every visible element). Re-run after GitHub ships a design change
// and diff the JSON against the previous snapshot.
//
//   node snapshot.mjs <pull request URL> <outDir> [light|dark] [profileDir]
import { chromium } from 'playwright-core'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const [, , prUrl, outDir, scheme = 'light', profileArg] = process.argv
// Captures hold your signed-in page: write them only where you choose (e.g. .ref/, ignored by git).
if (!prUrl || !outDir) {
  console.error('usage: node snapshot.mjs <https://github.com/o/r/pull/N> <outDir> [light|dark] [profileDir]')
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
  // login.mjs signs in with a plain Chrome, which encrypts cookies with the real keychain.
  ignoreDefaultArgs: ['--use-mock-keychain'],
})
const page = ctx.pages()[0] || (await ctx.newPage())
const base = prUrl.replace(/\/(files|changes).*$/, '').replace(/\/$/, '')

export const STYLE_PROPS = [
  'display', 'position', 'font-family', 'font-size', 'font-weight', 'line-height', 'color', 'background-color',
  'border-top', 'border-right', 'border-bottom', 'border-left', 'border-radius', 'padding', 'margin', 'gap',
  'box-shadow', 'width', 'height', 'white-space', 'tab-size', 'text-decoration', 'opacity', 'cursor',
]

async function structure(root = 'body') {
  return page.evaluate(
    ([root, props]) => {
      const out = []
      const vis = (e) => {
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      }
      const walk = (e, depth) => {
        if (!(e instanceof Element) || out.length > 40000) return
        if (!vis(e)) {
          // `display: contents` wrappers have no box but their children do.
          if (getComputedStyle(e).display === 'contents') for (const c of e.children) walk(c, depth + 1)
          return
        }
        // Long diffs: the first rows of each table body are enough.
        if (e.tagName === 'TR' && e.parentElement?.tagName === 'TBODY' && [...e.parentElement.children].indexOf(e) > 60) return
        const cs = getComputedStyle(e)
        const r = e.getBoundingClientRect()
        const text = [...e.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(' ').slice(0, 80)
        out.push({
          depth,
          tag: e.tagName.toLowerCase(),
          cls: (e.getAttribute('class') || '').slice(0, 200),
          testid: e.getAttribute('data-testid') || undefined,
          role: e.getAttribute('role') || undefined,
          aria: e.getAttribute('aria-label') || undefined,
          text: text || undefined,
          box: [r.x, r.y + scrollY, r.width, r.height].map((v) => Math.round(v * 10) / 10),
          style: Object.fromEntries(props.map((p) => [p, cs.getPropertyValue(p)])),
        })
        for (const c of e.children) walk(c, depth + 1)
      }
      walk(document.querySelector(root) || document.body, 0)
      return out
    },
    [root, STYLE_PROPS],
  )
}

const go = async (q) => {
  // Signed-in pages keep live-update connections open, so wait for content instead of network idle.
  await page.goto(base + q, { waitUntil: 'domcontentloaded', timeout: 90000 })
  await page.waitForSelector(q.startsWith('/changes') || q.startsWith('/files') ? 'table' : 'main', { timeout: 60000 }).catch(() => {})
  await page.waitForTimeout(3000)
}

const login = await (async () => {
  await go('')
  return page.evaluate(() => document.querySelector('meta[name="user-login"]')?.getAttribute('content') || '')
})()
console.log('signed in as:', login || '(not signed in)')

const result = { login: !!login, pages: {} }
for (const [name, q] of [
  ['changes-split', '/changes?diff=split'],
  ['changes-unified', '/changes?diff=unified'],
  ['files-redirect', '/files'],
  ['conversation', ''],
  ['commits', '/commits'],
  ['checks', '/checks'],
]) {
  await go(q)
  result.pages[name] = { url: page.url(), title: await page.title() }
  await page.screenshot({ path: `${outDir}/${name}.png` })
  await page.screenshot({ path: `${outDir}/${name}-full.png`, fullPage: true }).catch(() => {})
  if (name === 'changes-split' || name === 'conversation') {
    fs.writeFileSync(`${outDir}/${name}.structure.json`, JSON.stringify(await structure(), null, 0))
    fs.writeFileSync(`${outDir}/${name}.html`, await page.content())
  }
}
// Stylesheets used by the page (Primer CSS / CSS modules), for exact values.
await go('/changes?diff=split')
const sheets = await page.evaluate(() => [...document.styleSheets].map((s) => s.href).filter(Boolean))
fs.writeFileSync(`${outDir}/stylesheets.json`, JSON.stringify(sheets, null, 2))
fs.writeFileSync(`${outDir}/result.json`, JSON.stringify(result, null, 2))
console.log(JSON.stringify(result, null, 2))
await ctx.close()
