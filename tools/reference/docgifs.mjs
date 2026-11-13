// Records the README animations (docs/images/*.gif) from a gh-prv-local export: Chrome's screencast
// frames of each scene, turned into a GIF by ffmpeg (on PATH). A drawn cursor shows the clicks.
//
//   node docgifs.mjs <preview.html> [outDir=../../docs/images]
import { chromium } from 'playwright-core'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { exportUrl } from './common.mjs'

const [, , file, outDir = fileURLToPath(new URL('../../docs/images', import.meta.url))] = process.argv
const url = exportUrl(file)
const size = { width: 1280, height: 760 }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-prv-local-gifs-'))
const browser = await chromium.launch({ channel: 'chrome', headless: true })

// A visible cursor (headless captures have none) and a ring on every click.
const cursor = () => {
  addEventListener('DOMContentLoaded', () => {
    const c = document.createElement('div')
    c.innerHTML =
      '<svg width="22" height="22" viewBox="0 0 22 22"><path d="M3 2l14 8.5-6.2 1.3 3.6 6.8-2.6 1.3-3.6-6.8L3.8 17z" fill="#1f2328" stroke="#fff" stroke-width="1.4"/></svg>'
    c.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;transform:translate(-100px,-100px)'
    document.body.append(c)
    addEventListener('mousemove', (e) => (c.style.transform = `translate(${e.clientX - 3}px,${e.clientY - 2}px)`), true)
    addEventListener(
      'mousedown',
      (e) => {
        const r = document.createElement('div')
        r.style.cssText = `position:fixed;left:${e.clientX - 14}px;top:${e.clientY - 14}px;width:28px;height:28px;border-radius:50%;border:2px solid #0969da;z-index:2147483646;pointer-events:none;transition:transform .35s,opacity .35s`
        document.body.append(r)
        requestAnimationFrame(() => ((r.style.transform = 'scale(1.6)'), (r.style.opacity = '0')))
        setTimeout(() => r.remove(), 400)
      },
      true,
    )
  })
}

const GIF_WIDTH = 1024

// `play(page, shot)` acts in the page. Frames come from Chrome's screencast (each one lasts until
// the next); with `stills`, only from `await shot(ms)`, a screenshot shown for ms (the screencast
// drops frames while the window is resized).
async function scene(name, settings, play, { native = false, scheme = 'light', stills = false } = {}) {
  const ctx = await browser.newContext({ viewport: size, colorScheme: scheme, locale: 'en-US' })
  await ctx.addInitScript(cursor)
  if (native) await ctx.addInitScript({ path: fileURLToPath(new URL('./fake-native.js', import.meta.url)) })
  await ctx.addInitScript((s) => {
    if (!sessionStorage.getItem('gif')) {
      localStorage.clear()
      localStorage.setItem('prv:settings', JSON.stringify({ diffView: 'split', compact: true, treeVisible: true, ...s }))
      sessionStorage.setItem('gif', '1')
    }
  }, settings)
  const page = await ctx.newPage()
  await page.goto(url, { waitUntil: 'load' })
  await page.waitForTimeout(1500)
  const frames = [] // { data: base64 png, t: seconds } or { data, seconds }
  const shot = async (ms) => frames.push({ data: (await page.screenshot()).toString('base64'), seconds: ms / 1000 })
  const cdp = await ctx.newCDPSession(page)
  if (!stills) {
    cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
      frames.push({ data, t: metadata.timestamp })
      cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {})
    })
    await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 })
  }
  await play(page, shot)
  const end = Date.now() / 1000
  if (!stills) await cdp.send('Page.stopScreencast')
  await ctx.close()
  const dir = fs.mkdtempSync(path.join(tmp, `${name}-`))
  const list = frames.map((f, i) => {
    const png = path.join(dir, `${String(i).padStart(5, '0')}.png`)
    const bytes = Buffer.from(f.data, 'base64')
    fs.writeFileSync(png, bytes)
    // A narrower window: pad to the full frame (grey on the right) so every frame has one size.
    if (bytes.readUInt32BE(16) !== size.width) {
      const pad = `pad=${size.width}:${size.height}:0:0:color=0xd1d9e0`
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', png, '-vf', pad, `${png}.png`])
      fs.renameSync(`${png}.png`, png)
    }
    const seconds = f.seconds ?? (frames[i + 1]?.t ?? end) - f.t
    return `file '${png}'\nduration ${Math.max(0.01, seconds).toFixed(3)}`
  })
  // The concat demuxer needs the last file once more.
  fs.writeFileSync(path.join(dir, 'list.txt'), `${list.join('\n')}\nfile '${path.join(dir, `${String(frames.length - 1).padStart(5, '0')}.png`)}'\n`)
  const out = path.join(outDir, `${name}.gif`)
  const h = Math.round((size.height * GIF_WIDTH) / size.width)
  const filter =
    `fps=12,scale=${GIF_WIDTH}:${h}:flags=lanczos,` +
    'split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle'
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', path.join(dir, 'list.txt'), '-vf', filter, out])
  console.log(`${out}: ${(fs.statSync(out).size / 1e6).toFixed(1)} MB, ${frames.length} frames`)
}

// Moves the cursor to an element (smoothly) and clicks it.
async function click(page, locator) {
  const box = await locator.boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 18 })
  await page.waitForTimeout(150)
  await locator.click()
}
const pause = (page, ms = 700) => page.waitForTimeout(ms)

// 1. Review: a line comment, then Submit review → Request changes.
await scene('review', { treeVisible: false }, async (page) => {
  await page.mouse.move(640, 300)
  await pause(page, 900)
  const cell = page.locator('td.right-side-diff-cell').nth(12)
  // Scroll down to it the way a person would.
  for (let y = (await cell.boundingBox()).y; y > size.height * 0.45; y = (await cell.boundingBox()).y) {
    await page.mouse.wheel(0, Math.min(60, y - size.height * 0.45))
    await page.waitForTimeout(30)
  }
  const box = await cell.boundingBox()
  await page.mouse.move(box.x + 60, box.y + box.height / 2, { steps: 20 })
  await cell.hover({ position: { x: 60, y: box.height / 2 } })
  await pause(page, 400)
  await click(page, cell.getByRole('button', { name: 'Add comment' }))
  await pause(page, 400)
  await page.getByRole('textbox', { name: 'Add diff comment' }).pressSequentially('Use `mutableIntStateOf` here: this is always an `Int`.', { delay: 28 })
  await pause(page, 400)
  await click(page, page.getByRole('button', { name: 'Start a review' }))
  await pause(page, 900)
  await click(page, page.getByRole('button', { name: 'Submit review' }))
  await pause(page, 500)
  await page.getByRole('textbox', { name: 'Review body' }).pressSequentially('One question about the state holder.', { delay: 28 })
  await click(page, page.getByRole('radio', { name: 'Request changes' }))
  await pause(page, 1600)
})

// 2. Local checks (native views, through the test bridge).
await scene(
  'checks',
  { treeVisible: false },
  async (page) => {
    await page.mouse.move(640, 300)
    await pause(page, 600)
    await click(page, page.getByRole('link', { name: /^Checks/ }))
    await pause(page, 900)
    await click(page, page.getByRole('button', { name: 'Run all' }))
    await pause(page, 1500)
    await click(page, page.locator('.Checks-item').nth(1))
    await pause(page, 1800)
  },
  { native: true },
)

// 3. Views (dark theme): unified ↔ split, a file from the tree (find is the browser's in a tab).
await scene(
  'views',
  { treeVisible: true, diffView: 'unified' },
  async (page) => {
    await page.mouse.move(640, 300)
    await pause(page, 900)
    await click(page, page.getByRole('button', { name: 'Open diff view settings' }))
    await pause(page, 500)
    await click(page, page.getByRole('menuitemradio', { name: 'Split' }))
    await pause(page, 1200)
    await click(page, page.locator('.FileTreePane [role="treeitem"]').last())
    await pause(page, 2000)
  },
  { scheme: 'dark' },
)

// 4. Any window size: the file tree becomes a dialog, labels shorten, controls move into a menu.
await scene(
  'widths',
  { treeVisible: true },
  async (page, shot) => {
    await shot(1200)
    for (let w = size.width - 20; w >= 400; w -= 20) {
      await page.setViewportSize({ width: w, height: size.height })
      await page.waitForTimeout(120)
      await shot([1020, 760, 540, 400].includes(w) ? 700 : 70)
    }
    await page.getByRole('button', { name: 'Expand file tree' }).first().click()
    await page.waitForTimeout(500)
    await shot(1800)
  },
  { stills: true },
)

await browser.close()
fs.rmSync(tmp, { recursive: true, force: true })
