// End-to-end checks of the review UI on a prv export (static transport), with the local Chrome:
// comments (line, file, edit), settings (layout, whitespace, line height, minimize), expanders,
// viewed, panels, commit picker, file tree filter and review submission.
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

await check('submit a review: request changes with both comments', async () => {
  await page.getByRole('button', { name: 'Submit review' }).click()
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

console.log(results.join('\n'))
console.log(errors.length ? `console errors:\n${errors.join('\n')}` : 'no console errors')
await browser.close()
process.exit(failed || errors.length ? 1 : 0)
