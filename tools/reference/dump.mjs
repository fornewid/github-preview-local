// Dumps the subtree under a CSS selector of a signed-in GitHub page (or a local gh-prv-local export):
// tag, classes, label, text, box and the main computed styles of every visible element.
//
//   node dump.mjs <url | path/to/preview.html> <selector> [light|dark] [width] [--click selector]...
//
// Prints an indented outline; useful to read exact sizes, spacing and colors.
import fs from 'node:fs'
import { exportUrl, openChrome, openGithub } from './common.mjs'

const args = process.argv.slice(2)
const clicks = []
for (let i = args.indexOf('--click'); i >= 0; i = args.indexOf('--click')) clicks.push(args.splice(i, 2)[1])
const [target, selector, scheme = 'light', width = '1440'] = args
const local = fs.existsSync(target)
const { ctx, page } = await (local ? openChrome : openGithub)({ width: +width, scheme })
await page.goto(local ? exportUrl(target) : target, { waitUntil: local ? 'load' : 'domcontentloaded', timeout: 90000 })
await page.waitForSelector('table', { timeout: 60000 }).catch(() => {})
await page.waitForTimeout(local ? 2500 : 3500)
for (const c of clicks) {
  await page.locator(c).first().click()
  await page.waitForTimeout(700)
}
const out = await page.evaluate((sel) => {
  const P = ['font-size', 'font-weight', 'line-height', 'color', 'background-color', 'border-top', 'border-right', 'border-bottom', 'border-left', 'border-radius', 'padding', 'margin', 'gap', 'height', 'box-shadow', 'position', 'top']
  const def = { 'font-weight': '400', 'background-color': 'rgba(0, 0, 0, 0)', 'border-radius': '0px', padding: '0px', margin: '0px', gap: 'normal', 'box-shadow': 'none', position: 'static', top: 'auto' }
  const lines = []
  const walk = (e, d) => {
    if (lines.length > 600) return
    const cs = getComputedStyle(e)
    const b = e.getBoundingClientRect()
    if (b.width === 0 && b.height === 0 && cs.display !== 'contents') return
    if (e.tagName === 'path') return
    const st = P.filter((p) => {
      const v = cs.getPropertyValue(p)
      if (p.startsWith('border-') && p !== 'border-radius') return !v.startsWith('0px')
      return v && def[p] !== v
    }).map((p) => `${p}:${cs.getPropertyValue(p)}`)
    const text = [...e.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(' ').slice(0, 50)
    const cls = (e.getAttribute('class') || '').replace(/prc-([A-Za-z]+)-([A-Za-z]+)-[\w-]{5}/g, 'prc-$1-$2').slice(0, 90)
    lines.push(`${'  '.repeat(Math.min(d, 24))}${e.tagName.toLowerCase()}${cls ? '.' + cls.trim().replace(/\s+/g, '.') : ''}${e.getAttribute('aria-label') ? ` [${e.getAttribute('aria-label')}]` : ''}${text ? ` "${text}"` : ''} @${[b.x, b.y, b.width, b.height].map((v) => Math.round(v * 10) / 10).join(',')} ${st.join('; ')}`)
    for (const c of e.children) walk(c, d + 1)
  }
  document.querySelectorAll(sel).forEach((e) => walk(e, 0))
  return lines.join('\n')
}, selector)
console.log(out)
await ctx.close()
process.exit(0)
