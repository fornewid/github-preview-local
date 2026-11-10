// End-to-end checks of the review UI on a prv export (static transport), with the local Chrome:
// comments (line, file, edit), settings (layout, whitespace, line height, minimize), expanders,
// viewed, panels, commit picker, file tree filter, review submission, and the layout from 320px
// to 2560px (file tree and side panel dialogs, side panel width, overflow menu, compact headers).
//
//   node ui-test.mjs <preview.html>
import { chromium } from 'playwright-core'
import path from 'node:path'

const file = process.argv[2]
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-US' })
const page = await ctx.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
const url = 'file://' + path.resolve(file) + '?diff=split'
await page.goto(url, { waitUntil: 'load' })
await page.evaluate(() => {
  localStorage.clear()
  localStorage.setItem('prv:settings', JSON.stringify({ diffView: 'split', compact: true, treeVisible: false }))
})
await page.goto(url, { waitUntil: 'load' })
await page.waitForTimeout(2000)

let failed = 0
const results = []
async function check(name, fn) {
  try {
    await fn()
    results.push(`ok   ${name}`)
  } catch (e) {
    failed++
    results.push(`FAIL ${name}: ${e.message.split('\n')[0]}`)
  }
}
const assert = (c, msg) => {
  if (!c) throw new Error(msg)
}
const settle = (ms = 400) => page.waitForTimeout(ms)
const first = () => page.locator('.DiffEntry').first()
const settings = async (item) => {
  await page.getByRole('button', { name: 'Open diff view settings' }).click()
  await settle()
  await page.getByRole('menuitemradio', { name: item }).or(page.getByRole('menuitem', { name: item })).first().click()
  await settle(600)
}

await check('line comment: + opens the form and Start a review adds a pending comment', async () => {
  const cell = first().locator('td.left-side-diff-cell').nth(3)
  await cell.hover()
  await cell.getByRole('button', { name: 'Add comment' }).click()
  await settle()
  assert(await page.getByText('Add a comment on line L18').isVisible(), 'form title')
  await page.getByRole('textbox', { name: 'Add diff comment' }).fill('Why remove SuppressLint?')
  await page.getByRole('button', { name: 'Start a review' }).click()
  await settle()
  assert(await first().locator('.ReviewThread').count() === 1, 'thread rendered')
  assert((await first().locator('.ReviewThread').innerText()).includes('Pending'), 'pending label')
})

await check('edit a comment from its menu', async () => {
  await first().locator('.ReviewThread').getByRole('button', { name: 'Comment actions' }).click()
  await page.getByRole('menuitem', { name: 'Edit' }).click()
  await page.getByRole('textbox', { name: 'Edit comment' }).fill('Why remove SuppressLint here?')
  await page.getByRole('button', { name: 'Update comment' }).click()
  await settle()
  assert((await first().locator('.ReviewThread').innerText()).includes('here?'), 'updated body')
})

await check('file comment from the header', async () => {
  await first().getByRole('button', { name: 'Comment on this file' }).click()
  await settle()
  assert(await page.getByText('Add a comment on this file').isVisible(), 'file form')
  await page.getByRole('textbox', { name: 'Add diff comment' }).fill('Split this file?')
  await page.getByRole('button', { name: 'Add review comment' }).click()
  await settle()
  assert(await first().locator('.DiffFileComments .ReviewThread').count() === 1, 'file thread')
})

await check('toolbar comment counter and comments panel', async () => {
  const btn = page.getByRole('button', { name: 'Open comments panel' })
  assert((await btn.innerText()).includes('2'), 'counter shows 2')
  await btn.click()
  await settle()
  assert(await page.locator('.CommentsPanel-item').count() === 2, 'panel lists 2')
  await page.getByRole('button', { name: 'Close comments panel' }).first().click()
})

await check('minimize comments with the i shortcut', async () => {
  await page.locator('body').click({ position: { x: 5, y: 600 } })
  await page.keyboard.press('i')
  await settle()
  assert(await page.locator('.MinimizedThread').count() >= 1, 'minimized')
  await page.keyboard.press('i')
  await settle()
  assert(await page.locator('.MinimizedThread').count() === 0, 'restored')
})

await check('expand up recomputes the first hunk header', async () => {
  await first().getByRole('button', { name: 'Expand file up from line 15' }).click()
  await settle()
  const text = await first().locator('.diff-text-cell.hunk').first().innerText()
  assert(text.includes('@@ -1,38 +1,45 @@'), `hunk header is ${text}`)
  assert(await first().locator('td.new-diff-line-number', { hasText: /^1$/ }).count() >= 1, 'line 1 visible')
})

await check('unified layout and back', async () => {
  await settings('Unified')
  assert(await first().locator('table colgroup col').count() === 3, 'unified has 3 columns')
  await settings('Split')
  assert(await first().locator('table colgroup col').count() === 4, 'split has 4 columns')
})

await check('compact line height toggle (20px <-> 24px rows)', async () => {
  const h = () => first().locator('tr.diff-line-row').nth(3).evaluate((r) => r.getBoundingClientRect().height)
  assert(Math.round(await h()) === 20, 'compact 20px')
  await settings('Compact line height')
  assert(Math.round(await h()) === 24, 'regular 24px')
  await settings('Compact line height')
  assert(Math.round(await h()) === 20, 'compact again')
})

await check('whitespace submenu: always hide and back', async () => {
  await page.getByRole('button', { name: 'Open diff view settings' }).click()
  await settle()
  await page.getByRole('menuitem', { name: /Whitespace changes/ }).click()
  await settle()
  await page.getByRole('menuitemradio', { name: /Always hide/ }).click()
  await settle(600)
  const s = await page.evaluate(() => JSON.parse(localStorage.getItem('prv:settings')).hideWhitespace)
  assert(s === true, 'persisted')
  await page.getByRole('button', { name: 'Open diff view settings' }).click()
  await settle()
  await page.getByRole('menuitem', { name: /Whitespace changes/ }).click()
  await settle()
  await page.getByRole('menuitemradio', { name: /Always show/ }).click()
  await settle(600)
})

await check('viewed collapses the file and updates progress', async () => {
  await first().getByRole('button', { name: 'Not Viewed' }).click()
  await settle()
  assert(await first().locator('.DiffEntry-body').count() === 0, 'collapsed')
  assert((await page.locator('.ViewedProgress').innerText()).includes('1 / 2'), 'progress 1/2')
  await first().getByRole('button', { name: 'Viewed' }).click()
  await settle()
  assert(await first().locator('.DiffEntry-body').count() === 1, 'expanded again')
})

await check('overview panel shows the description', async () => {
  await page.getByRole('button', { name: 'Open overview panel' }).click()
  await settle()
  assert(await page.locator('.SidePanel').isVisible(), 'panel open')
  await page.getByRole('button', { name: 'Close overview panel' }).first().click()
})

await check('commit picker opens and cancels', async () => {
  await page.getByRole('button', { name: 'All commits' }).click()
  await settle()
  assert(await page.getByRole('dialog', { name: 'Select commits to view' }).isVisible(), 'dialog')
  assert(await page.locator('.CommitPicker-item').count() === 2, 'two commits')
  await page.getByRole('button', { name: 'Cancel' }).click()
})

await check('file tree filter', async () => {
  await page.getByRole('button', { name: 'Expand file tree' }).click()
  await settle()
  await page.getByRole('textbox', { name: 'Filter files…' }).fill('LayoutTest')
  await settle()
  assert(await page.locator('.FileTree-file').count() === 1, 'one file left')
  await page.getByRole('textbox', { name: 'Filter files…' }).fill('')
})

await check('CODEOWNERS shield label', async () => {
  const owner = first().locator('.DiffFileHeader-owner')
  if (!(await owner.count())) return
  const label = await owner.getAttribute('aria-label')
  assert(/^Owned by .+ \(from CODEOWNERS line \d+\)$/.test(label ?? ''), `label ${label}`)
})

await check('Confirm is disabled without publishing (static export)', async () => {
  await page.getByRole('button', { name: 'Merge status' }).click()
  await settle()
  assert(await page.locator('.MergePanel').getByRole('button', { name: /Confirm/ }).isDisabled(), 'merge panel confirm disabled')
  await page.getByRole('button', { name: 'Close merge status panel' }).first().click()
})

await check('review draft survives closing the overlay', async () => {
  await page.getByRole('button', { name: 'Submit review' }).click()
  await settle()
  await page.getByRole('textbox', { name: 'Review body' }).fill('Draft kept')
  await page.keyboard.press('Escape')
  await settle()
  await page.getByRole('button', { name: 'Submit review' }).click()
  await settle()
  assert((await page.getByRole('textbox', { name: 'Review body' }).inputValue()) === 'Draft kept', 'draft restored')
  assert(await page.getByRole('radio', { name: 'Confirm' }).isDisabled(), 'confirm radio disabled')
  await page.keyboard.press('Escape')
  await settle()
})

await check('submit a review: request changes with both comments', async () => {
  if (!(await page.locator('.ReviewForm').isVisible())) await page.locator('.ReviewButton').click()
  await settle()
  await page.getByRole('textbox', { name: 'Review body' }).fill('Please address these.')
  await page.getByRole('radio', { name: 'Request changes' }).check()
  await page.locator('.ReviewForm-submit').click()
  await settle(800)
  const md = await page.locator('.SubmittedDialog pre').innerText()
  assert(md.includes('Changes requested'), 'headline')
  assert(md.includes('(whole file)') && md.includes('line 18 (old/deleted side)'), 'both comments')
  assert(md.includes('Please address these.'), 'summary')
})

// ---------------- Widths (github.com's responsive behaviour, docs/reference.md) ----------------
await page.goto(url, { waitUntil: 'load' })
await page.evaluate(() => {
  localStorage.clear()
  localStorage.setItem('prv:settings', JSON.stringify({ diffView: 'split', compact: true, treeVisible: true }))
})
await page.goto(url, { waitUntil: 'load' })
await page.waitForTimeout(1500)
const width = async (w) => {
  await page.setViewportSize({ width: w, height: 900 })
  await page.evaluate(() => window.scrollTo(0, 0))
  await settle(500)
}
const dialogs = () => page.locator('[role="dialog"]').count()
const closeDialogs = async () => {
  // A tooltip on the focused button takes the first Escape (Primer).
  for (let i = 0; i < 3 && (await dialogs()); i++) {
    await page.keyboard.press('Escape')
    await settle(300)
  }
}

await check('no horizontal overflow from 320px to 2560px', async () => {
  for (const w of [2560, 1920, 1440, 1100, 1024, 900, 767, 600, 375, 320]) {
    await width(w)
    const sw = await page.evaluate(() => document.documentElement.scrollWidth)
    assert(sw <= w, `${w}px: page is ${sw}px wide`)
  }
})

await check('under 1076px the file tree opens as a "Files" dialog and closes on selection', async () => {
  await width(1100)
  assert(await page.locator('.FileTreePane').count() === 1, 'tree beside the diffs at 1100px')
  await width(900)
  assert(await page.locator('.FileTreePane').count() === 0, 'no tree pane at 900px')
  await page.getByRole('button', { name: 'Expand file tree' }).click()
  await settle()
  const box = await page.getByRole('dialog', { name: 'Files' }).boundingBox()
  assert(box && box.x === 0 && Math.round(box.width) === 640, `left sheet 640px, got ${JSON.stringify(box)}`)
  await page.getByRole('dialog').getByRole('treeitem', { name: 'BasicReadMoreTextLayoutTest.kt' }).click()
  await settle(800)
  assert((await dialogs()) === 0, 'dialog closed')
  assert((await page.evaluate(() => window.scrollY)) > 0, 'scrolled to the file')
})

await check('side panel: docked width follows the window, a dialog under 1012px', async () => {
  const open = async () => {
    await page.getByRole('button', { name: 'Open overview panel' }).click()
    await settle()
  }
  for (const [w, expected] of [[1920, 547], [1440, 484], [1300, 453]]) {
    await width(w)
    await open()
    const got = await page.locator('.SidePanel').evaluate((e) => Math.round(e.getBoundingClientRect().width))
    assert(got === expected, `${w}px: panel ${got}px, expected ${expected}px`)
    await page.locator('.SidePanel').getByRole('button', { name: 'Close overview panel' }).click()
    await settle(300)
  }
  await width(1920)
  await open()
  const handle = page.locator('.SidePanel').getByRole('slider', { name: 'Draggable pane splitter' })
  await handle.focus()
  await page.keyboard.press('ArrowLeft')
  await settle(300)
  assert((await handle.getAttribute('aria-valuenow')) === '541', 'arrow key resizes by 3px')
  await handle.dblclick()
  await settle(300)
  assert((await handle.getAttribute('aria-valuenow')) === '544', 'double-click resets to 544px')
  await page.locator('.SidePanel').getByRole('button', { name: 'Close overview panel' }).click()
  await width(900)
  await open()
  assert((await dialogs()) === 1 && (await page.locator('.SidePanel').count()) === 0, 'dialog at 900px')
  await closeDialogs()
  assert((await dialogs()) === 0, 'Escape closes it')
})

await check('labels shorten under 816px and controls move into "More options" at 544px', async () => {
  await width(816)
  assert(await page.getByRole('button', { name: 'Submit review' }).isVisible(), 'Submit review at 816px')
  await width(815)
  assert(await page.getByRole('button', { name: 'Review', exact: true }).isVisible(), 'Review at 815px')
  assert(await page.getByRole('button', { name: 'Status', exact: true }).isVisible(), 'Status at 815px')
  await width(375)
  const toolbar = page.locator('.ChangesToolbar')
  assert(!(await toolbar.getByRole('button', { name: 'All commits' }).isVisible()), 'All commits moved')
  await toolbar.getByRole('button', { name: 'More options' }).click()
  await settle()
  const items = await page.getByRole('menuitem').allInnerTexts()
  assert(['Comments', 'All commits', 'Settings'].every((t) => items.some((i) => i.includes(t))), `menu: ${items.join(', ')}`)
  await page.getByRole('menuitem', { name: 'All commits' }).click()
  await settle()
  assert(await page.getByRole('dialog', { name: 'Select commits to view' }).isVisible(), 'commit picker from the menu')
  await page.getByRole('button', { name: 'Cancel' }).click()
  await settle(300)
})

await check('under 768px: compact file header, its menu offers the hidden actions, fullscreen review', async () => {
  await width(700)
  const header = page.locator('.DiffFileHeader').first()
  assert(!(await header.getByRole('button', { name: 'Comment on this file' }).isVisible()), 'comment button hidden')
  await header.getByRole('button', { name: 'More options' }).click()
  await settle()
  await page.getByRole('menuitem', { name: 'Comment on this file' }).click()
  await settle()
  assert(await page.getByText('Add a comment on this file').isVisible(), 'file comment form from the menu')
  await page.getByRole('button', { name: 'Cancel' }).first().click()
  await settle(300)
  await width(500)
  await page.getByRole('button', { name: 'Review', exact: true }).click()
  await settle(700)
  const box = await page.locator('.ReviewOverlay').boundingBox()
  assert(box && box.x === 0 && Math.round(box.width) === 500, `fullscreen review, got ${JSON.stringify(box)}`)
  assert(await page.evaluate(() => document.activeElement?.tagName === 'TEXTAREA'), 'starts in the text box')
  await page.keyboard.press('Escape')
  await settle(300)
})

await check('native views (fake bridge): checks list beside the log, stacked at 768px and below', async () => {
  const native = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-US' })
  await native.addInitScript({ path: new URL('./fake-native.js', import.meta.url).pathname })
  const p = await native.newPage()
  p.on('pageerror', (e) => errors.push(e.message))
  await p.goto('file://' + path.resolve(file), { waitUntil: 'load' })
  await p.waitForTimeout(1500)
  await p.getByRole('link', { name: /^Checks/ }).click()
  await p.waitForTimeout(500)
  const layout = () =>
    p.evaluate(() => {
      const side = document.querySelector('.Checks-sidebar').getBoundingClientRect()
      const main = document.querySelector('.Checks-main').getBoundingClientRect()
      return { side: Math.round(side.width), stacked: main.top >= side.bottom - 1 }
    })
  let l = await layout()
  assert(!l.stacked && l.side === Math.round((1440 - 64) / 3), `1440px: ${JSON.stringify(l)}`)
  await p.setViewportSize({ width: 769, height: 900 })
  await p.waitForTimeout(300)
  assert(!(await layout()).stacked, 'side by side at 769px')
  await p.setViewportSize({ width: 768, height: 900 })
  await p.waitForTimeout(300)
  l = await layout()
  assert(l.stacked, `stacked at 768px: ${JSON.stringify(l)}`)
  await native.close()
})

console.log(results.join('\n'))
console.log(errors.length ? `console errors:\n${errors.join('\n')}` : 'no console errors')
await browser.close()
process.exit(failed || errors.length ? 1 : 0)
