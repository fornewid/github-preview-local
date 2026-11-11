// Compares the text styles of a signed-in github.com pull request with a prv export, tab by tab.
// Text that appears on both pages (tab labels, buttons, commit titles, file names, code lines, …)
// is paired by its content; every pair whose font differs is printed: the font Chrome really
// draws with (not just the CSS stack), size, weight, line height, letter spacing, color, font
// smoothing and text rendering. Icons (octicons) are paired by name and the text of the control
// they sit in, and compared by color.
//
//   node typography.mjs <PR url> <path/to/preview.html> [--width 1440] [--tabs files,commits,checks,conversation]
//
// Read only: github.com is only loaded, nothing is clicked.
import { chromium } from 'playwright-core'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const opt = (name, def) => {
  const i = args.indexOf(name)
  return i < 0 ? def : args.splice(i, 2)[1]
}
const width = +opt('--width', '1440')
const tabs = opt('--tabs', 'files,commits,checks,conversation').split(',')
const [pr, file] = args
if (!pr || !file) {
  console.error('usage: node typography.mjs <PR url> <preview.html> [--width 1440] [--tabs files,commits,checks,conversation]')
  process.exit(2)
}
const ghPath = { conversation: '', commits: '/commits', checks: '/checks', files: '/changes' }
const unknown = tabs.filter((t) => !(t in ghPath))
if (unknown.length) {
  console.error(`unknown tab: ${unknown.join(', ')} (use ${Object.keys(ghPath).join(', ')})`)
  process.exit(2)
}

const opts = { channel: 'chrome', headless: true, viewport: { width, height: 900 }, colorScheme: 'light', locale: 'en-US' }
const gh = await chromium.launchPersistentContext(path.join(os.homedir(), '.cache', 'prv-reference', 'chrome-profile'), {
  ...opts,
  ignoreDefaultArgs: ['--use-mock-keychain'],
})
const local = await (await chromium.launch(opts)).newContext(opts)

// Every visible element with its own text: the text, its computed text styles and its box.
function collect() {
  const out = []
  let i = 0
  for (const e of document.body.querySelectorAll('*')) {
    if (e.closest('script, style, svg, template, [hidden], [aria-hidden="true"]')) continue
    const text = [...e.childNodes]
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (!text || text.length < 2) continue
    const b = e.getBoundingClientRect()
    if (b.width < 1 || b.height < 1) continue
    const cs = getComputedStyle(e)
    if (cs.visibility === 'hidden' || +cs.opacity === 0) continue
    e.setAttribute('data-typo', String(i))
    out.push({
      id: i++,
      text: text.slice(0, 80),
      tag: e.tagName.toLowerCase(),
      cls: (e.getAttribute('class') || '').replace(/prc-([A-Za-z]+)-([A-Za-z]+)-[\w-]{5}/g, 'prc-$1-$2').trim().split(/\s+/)[0] || '',
      family: cs.fontFamily,
      size: cs.fontSize,
      weight: cs.fontWeight,
      lineHeight: cs.lineHeight,
      spacing: cs.letterSpacing,
      color: cs.color,
      style: cs.fontStyle,
      smoothing: cs.getPropertyValue('-webkit-font-smoothing'),
      rendering: cs.textRendering,
      y: Math.round(b.y),
    })
  }
  return out
}

// Every visible octicon: name + the text or label of the control it belongs to, and its color.
function collectIcons() {
  return [...document.querySelectorAll('svg.octicon')]
    .filter((s) => {
      const b = s.getBoundingClientRect()
      return b.width > 0 && !s.closest('[hidden], [aria-hidden="true"]:not(svg)')
    })
    .map((s) => {
      const host = s.closest('a, button, summary, [role="tab"], li, div')
      const label = (host?.getAttribute('aria-label') || host?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40)
      return { key: `${[...s.classList].find((c) => c.startsWith('octicon-'))} "${label}"`, color: getComputedStyle(s).color }
    })
}

// The font Chrome actually uses for the element's text (CSS.getPlatformFontsForNode). Run right
// after collect(): the tagged elements are found in the same document order.
async function platformFonts(page, runs) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('DOM.enable')
  await cdp.send('CSS.enable')
  const { root } = await cdp.send('DOM.getDocument', { depth: 0 })
  const { nodeIds } = await cdp.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: '[data-typo]' })
  for (const r of runs) {
    try {
      const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId: nodeIds[r.id] })
      r.font = fonts
        .sort((a, b) => b.glyphCount - a.glyphCount)
        .map((f) => f.postScriptName || f.familyName)
        .join('+')
    } catch {
      r.font = '?'
    }
  }
  await cdp.detach()
}

async function githubPage(tab) {
  const page = gh.pages()[0] ?? (await gh.newPage())
  await page.goto(pr + ghPath[tab], { waitUntil: 'domcontentloaded', timeout: 90000 })
  await page.waitForTimeout(tab === 'files' ? 6000 : 4000)
  const state = await page.evaluate(() => ({
    login: document.querySelector('meta[name="user-login"]')?.getAttribute('content'),
    background: getComputedStyle(document.body).backgroundColor,
  }))
  if (!state.login) {
    console.error('github.com: not signed in (run node login.mjs first)')
    process.exit(1)
  }
  if (state.background !== 'rgb(255, 255, 255)') console.error(`warning: github.com is not in the light theme (${state.background}); colors will differ`)
  return page
}

async function prvPage(tab) {
  const page = local.pages()[0] ?? (await local.newPage())
  await page.goto('file://' + path.resolve(file), { waitUntil: 'load' })
  await page.waitForTimeout(1500)
  await page.evaluate((t) => window.__prv.getState().setTab(t), tab)
  await page.waitForTimeout(1000)
  return page
}

const keys = ['font', 'size', 'weight', 'lineHeight', 'spacing', 'color', 'style', 'smoothing', 'rendering']
let total = 0
for (const tab of tabs) {
  // Fonts and icons are read right away: github.com may re-render while the export loads.
  const gp = await githubPage(tab)
  const g = await gp.evaluate(collect)
  await platformFonts(gp, g)
  const gIcons = await gp.evaluate(collectIcons)
  const pp = await prvPage(tab)
  const p = await pp.evaluate(collect)
  await platformFonts(pp, p)
  const pIcons = await pp.evaluate(collectIcons)
  // Pair the k-th occurrence of a text on one page with its k-th occurrence on the other.
  const index = (runs) => {
    const m = new Map()
    for (const r of runs) m.set(r.text, [...(m.get(r.text) ?? []), r])
    return m
  }
  const gi = index(g)
  const pairs = []
  for (const [text, list] of index(p)) {
    const other = gi.get(text)
    if (other) list.forEach((r, k) => other[k] && pairs.push([other[k], r]))
  }
  const diffs = pairs.filter(([a, b]) => keys.some((k) => a[k] !== b[k]))
  const iconDiffs = []
  let iconPairs = 0
  for (const [key, list] of Map.groupBy(pIcons, (i) => i.key)) {
    const other = gIcons.filter((i) => i.key === key)
    list.forEach((i, k) => {
      if (!other[k]) return
      iconPairs++
      if (other[k].color !== i.color) iconDiffs.push(`- icon ${key}\n    color: ${other[k].color} → ${i.color}`)
    })
  }
  // Group equal differences (e.g. every code line) into one line.
  const groups = new Map()
  for (const [a, b] of diffs) {
    const what = keys.filter((k) => a[k] !== b[k]).map((k) => `${k}: ${a[k]} → ${b[k]}`).join('; ')
    const key = `${a.cls}|${b.cls}|${what}`
    const grp = groups.get(key) ?? { a, b, what, texts: [] }
    grp.texts.push(a.text)
    groups.set(key, grp)
  }
  const fonts = (runs) => {
    const n = {}
    for (const r of runs) n[r.font] = (n[r.font] ?? 0) + 1
    return Object.entries(n)
      .sort((a, b) => b[1] - a[1])
      .map(([f, c]) => `${f || '(none)'} ×${c}`)
      .join(', ')
  }
  console.log(`\n## ${tab} (${width}px): ${pairs.length} texts on both pages, ${diffs.length} styled differently`)
  console.log(`fonts: github ${fonts(pairs.map(([a]) => a))}\n       prv    ${fonts(pairs.map(([, b]) => b))}`)
  for (const { a, b, what, texts } of groups.values()) {
    console.log(`- "${texts[0]}"${texts.length > 1 ? ` (+${texts.length - 1})` : ''}  gh ${a.tag}.${a.cls} / prv ${b.tag}.${b.cls}\n    ${what}`)
  }
  console.log(`icons: ${iconPairs} on both pages, ${iconDiffs.length} colored differently`)
  for (const line of new Set(iconDiffs)) console.log(line)
  total += diffs.length + iconDiffs.length
}
console.log(`\n${total} differences`)
await gh.close()
await local.browser().close()
process.exit(0)
