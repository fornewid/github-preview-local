// End-to-end checks of the review UI on a gh-prv-local export (static transport), with the local Chrome:
// comments (line, file, edit), settings (layout, whitespace, line height, minimize), expanders,
// viewed, the comments panel, commit picker and commit links, find (Cmd/Ctrl+F), image files,
// file tree filter, review submission, and the layout from 320px to 2560px (file tree and side
// panel dialogs, side panel width, overflow menu, compact headers, tabs that keep the header still).
//
//   node ui-test.mjs <preview.html> [<export with image files>]
import { fileURLToPath } from 'node:url'
import { exportUrl, openChrome, openExport } from './common.mjs'

const file = process.argv[2]
const { browser, ctx, page } = await openChrome()
// gh-prv-local loads nothing from any host: every request must stay inside the file.
const external = []
ctx.on('request', (r) => /^(file|data|blob):/.test(r.url()) || external.push(r.url()))
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
await openExport(page, file, { query: '?diff=split', settings: { treeVisible: false } })

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

await check('no description or merge status: the header has no actions, the panel is Comments', async () => {
  assert((await page.getByRole('button', { name: /Merge status|overview panel/ }).count()) === 0, 'no merge status or overview buttons')
  await page.evaluate(() => window.__prv.getState().setTab('conversation'))
  await settle()
  assert((await page.locator('.Conversation .TimelineComment, .Conversation .markdown-body').count()) === 0, 'no description in Conversation')
  await page.evaluate(() => window.__prv.getState().setTab('files'))
  await settle()
})

await check('settings menu fits its content (no scrollbar inside it)', async () => {
  await page.getByRole('button', { name: 'Open diff view settings' }).click()
  await settle()
  const fit = await page.evaluate(() => {
    const o = document.querySelector('[role="menu"]').closest('[class*="Overlay"]')
    return [o.scrollWidth, o.clientWidth, getComputedStyle(document.querySelector('[role="menu"] li')).boxSizing]
  })
  assert(fit[0] <= fit[1] && fit[2] === 'border-box', `menu ${fit.join(' ')}`)
  await page.keyboard.press('Escape')
  await settle(300)
})

await check('find (Cmd/Ctrl+F): counts every match, paints the ones on screen, goes to the next, Escape closes', async () => {
  const word = await page
    .locator('.DiffEntry td[data-find] .diff-text-inner')
    .evaluateAll((cells) => cells.map((c) => c.textContent.match(/[A-Za-z_]{3,}/)?.[0]).find(Boolean))
  assert(word, 'a word to look for')
  try {
    await find(word)
  } finally {
    if (await page.locator('.FindBar').count()) await page.getByRole('button', { name: 'Close find' }).click()
  }
})
async function find(word) {
  await page.keyboard.press('ControlOrMeta+f')
  await settle(200)
  assert(await page.getByRole('textbox', { name: 'Find in changes' }).evaluate((e) => e === document.activeElement), 'focus in the find bar')
  await page.keyboard.type(word)
  await settle(600)
  const count = async () => (await page.locator('.FindBar-count').textContent()).split('/').map(Number)
  const [at, total] = await count()
  assert(at === 1 && total > 0, `count ${at}/${total}`)
  const painted = () => page.evaluate(() => [CSS.highlights.get('prv-find')?.size ?? 0, CSS.highlights.get('prv-find-current')?.size ?? 0])
  let [all, cur] = await painted()
  assert(all > 0 && cur === 1, `painted ${all}, current ${cur}`)
  await page.keyboard.press('Enter')
  await settle(500)
  assert((await count())[0] === (total > 1 ? 2 : 1), 'Enter goes to the next match')
  await page.keyboard.press('Shift+Enter')
  await settle(500)
  assert((await count())[0] === 1, 'Shift+Enter goes back')
  await page.keyboard.press('Escape')
  await settle(300)
  ;[all, cur] = await painted()
  assert((await page.locator('.FindBar').count()) === 0 && all === 0 && cur === 0, 'closed and cleared')
}

await check('markdown: github.com allowlist, remote images become links, nothing loads', async () => {
  const body = [
    '![tracker](https://tracker.example/p.gif?t=1) and <img src="http://tracker.example/q.png" srcset="https://tracker.example/r.png 2x">',
    '<a href="https://example.com/"><img src="https://tracker.example/in-link.png"></a> ![local](docs/shot.png)',
    '<video poster="https://tracker.example/v.png" src="https://tracker.example/v.mp4"></video><svg><image href="https://tracker.example/s.png"/></svg>',
    '<dialog open>fake</dialog><label for="x">fake label</label><form><button id="submit">x</button></form>',
    '<div role="menu" class="ReviewOverlay" style="position:fixed" id="top" popover>menu</div><a href="javascript:alert(1)">js</a><a name="anchor">named</a>',
    '![](//cdn.example/x.png) ![](data:image/png;base64,AAAA)',
    '- [ ] loose one\n\n- [x] loose two',
    '- [x] done',
  ].join('\n\n')
  // A comment on the first file renders it (the same sanitizer as every comment).
  const id = await page.evaluate((b) => {
    const st = window.__prv.getState()
    st.addComment({ path: st.snapshot.files[0].path, side: 'RIGHT', line: 0, body: b })
    return window.__prv.getState().drafts.at(-1).id
  }, body)
  await settle(800)
  try {
    const md = first().locator('.markdown-body').filter({ hasText: 'fake label' }).first()
    const r = await md.evaluate((el) => ({
      imgs: el.querySelectorAll('img, video, svg, image, source').length,
      blocked: [...el.querySelectorAll('.BlockedImage')].map((b) => `${b.tagName}:${b.getAttribute('href') ?? ''}:${b.textContent}`),
      banned: el.querySelectorAll('dialog, label, form, button, [class]:not(.BlockedImage), [style], [popover]').length,
      ids: el.querySelectorAll('[id]').length,
      names: [...el.querySelectorAll('[name]')].map((e) => e.getAttribute('name')),
      bullets: [...el.querySelectorAll('li')].filter((li) => li.querySelector('input') && getComputedStyle(li).listStyleType !== 'none').length,
      role: el.querySelector('[role]')?.getAttribute('role'),
      js: [...el.querySelectorAll('a')].some((a) => (a.getAttribute('href') ?? '').startsWith('javascript')),
      checkbox: el.querySelector('input[type=checkbox]')?.disabled,
    }))
    assert(r.imgs === 0, `media left: ${r.imgs}`)
    assert(r.blocked.includes('A:https://tracker.example/p.gif?t=1:tracker'), `blocked image link: ${r.blocked}`)
    assert(r.blocked.includes('SPAN::in-link.png') && r.blocked.includes('SPAN::local'), `inside a link / repository path: ${r.blocked}`)
    assert(r.banned === 0, `page-like elements or attributes left: ${r.banned}`)
    assert(r.ids === 0 && r.names.length === 1 && r.names[0] === 'user-content-anchor', `ids ${r.ids}, names ${r.names}`)
    assert(r.blocked.includes('A:https://cdn.example/x.png:x.png') && r.blocked.includes('SPAN::image'), `protocol-relative / data: ${r.blocked}`)
    assert(r.bullets === 0, `task list items with a bullet: ${r.bullets}`)
    assert(r.role === 'menu' && !r.js && r.checkbox === true, JSON.stringify(r))
  } finally {
    await page.evaluate((id) => window.__prv.getState().deleteComment(id), id)
    await settle(400)
  }
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

await check('Confirm approves in an export too (it pushes nothing without --publish)', async () => {
  await page.evaluate(() => window.__prv.getState().setTab('conversation'))
  await settle()
  const confirm = page.locator('.MergeBox').getByRole('button', { name: /Confirm/ })
  assert((await confirm.isEnabled()) && (await confirm.textContent()).trim() === 'Confirm', 'merge box Confirm, enabled')
  assert((await page.locator('.CommitRow-title, .TimelineItem-commitTitle a').count()) === 0, 'no commit links without the native window')
  await page.evaluate(() => window.__prv.getState().setTab('files'))
  await settle()
})

await check('review draft survives closing the overlay', async () => {
  await page.getByRole('button', { name: 'Submit review' }).click()
  await settle()
  await page.getByRole('textbox', { name: 'Review body' }).fill('Draft kept')
  await page.keyboard.press('Escape')
  await settle()
  const overlay = page.locator('.ReviewOverlay')
  assert((await overlay.count()) === 0, 'Escape closes the review overlay')
  // Reopened, Escape still closes it (Primer's handler, as on github.com), three times over.
  for (let i = 0; i < 3; i++) {
    await page.getByRole('button', { name: 'Submit review' }).click()
    await settle()
    if (i === 0) {
      assert((await page.getByRole('textbox', { name: 'Review body' }).inputValue()) === 'Draft kept', 'draft restored')
      assert(await page.getByRole('radio', { name: 'Confirm' }).isEnabled(), 'confirm radio enabled')
    }
    await page.keyboard.press('Escape')
    await settle()
    assert((await overlay.count()) === 0, `Escape closes the reopened overlay (${i + 1})`)
  }
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
  assert((await page.locator('.ReviewForm').count()) === 0, 'the review popup closed (it would cover the dialog)')
})

// ---------------- Widths (github.com's responsive behaviour, docs/reference.md) ----------------
await openExport(page, file, { query: '?diff=split', settings: { treeVisible: true }, wait: 1500 })
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
    await page.getByRole('button', { name: 'Open comments panel' }).click()
    await settle()
  }
  // Earlier checks narrowed the window, which lowers the panel width for this page (Primer): reload.
  await width(1920)
  await page.reload({ waitUntil: 'load' })
  await settle(1500)
  for (const [w, expected] of [[1920, 547], [1440, 484], [1300, 453]]) {
    await width(w)
    await open()
    const got = await page.locator('.SidePanel').evaluate((e) => Math.round(e.getBoundingClientRect().width))
    assert(got === expected, `${w}px: panel ${got}px, expected ${expected}px`)
    await page.locator('.SidePanel').getByRole('button', { name: 'Close comments panel' }).click()
    await settle(300)
  }
  // Like Primer on github.com: narrowing the window lowered the width, widening keeps it.
  await width(1920)
  await open()
  const panelWidth = () => page.locator('.SidePanel').evaluate((e) => Math.round(e.getBoundingClientRect().width))
  assert((await panelWidth()) === 453, `kept the narrower width at 1920px, got ${await panelWidth()}`)
  const handle = page.locator('.SidePanel').getByRole('slider', { name: 'Draggable pane splitter' })
  await handle.dblclick()
  await settle(300)
  assert((await handle.getAttribute('aria-valuenow')) === '544' && (await panelWidth()) === 547, 'double-click resets to 544px')
  await handle.focus()
  await page.keyboard.press('ArrowLeft')
  await settle(300)
  assert((await handle.getAttribute('aria-valuenow')) === '541', 'arrow key resizes by 3px')
  await handle.dblclick()
  await settle(300)
  await page.locator('.SidePanel').getByRole('button', { name: 'Close comments panel' }).click()
  // Docked at 1440px: hidden while the window is narrower than 1012px, docked again after; with
  // it docked the tree stays beside the diffs down to 1044px (not 1076px).
  await width(1440)
  await open()
  await width(1050)
  assert(await page.locator('.FileTreePane').count() === 1, 'tree beside at 1050px with the panel docked')
  await width(1043)
  assert(await page.locator('.FileTreePane').count() === 0, 'tree in a dialog at 1043px')
  await width(900)
  assert((await dialogs()) === 0 && !(await page.locator('.SidePanel').isVisible()), 'docked panel hidden at 900px')
  assert((await page.locator('.SidePanel').count()) === 1, 'still mounted while hidden (keeps an edit)')
  assert(await page.getByRole('button', { name: 'Open comments panel' }).isVisible(), 'a hidden panel reads as closed')
  await width(1440)
  assert(await page.locator('.SidePanel').isVisible(), 'docked again at 1440px')
  // Hidden, then its toggle: it opens as a dialog.
  await width(900)
  await page.getByRole('button', { name: 'Open comments panel' }).click()
  await settle()
  assert((await dialogs()) === 1, 'opens as a dialog')
  await closeDialogs()
  await width(1440)
  assert((await page.locator('.SidePanel').count()) === 0, 'replaced by the dialog, so closed after it')
  // Opened narrow: a dialog, and it stays one when the window widens.
  await width(900)
  await open()
  assert((await dialogs()) === 1 && (await page.locator('.SidePanel').count()) === 0, 'dialog at 900px')
  await width(1440)
  assert((await dialogs()) === 1 && (await page.locator('.SidePanel').count()) === 0, 'still a dialog at 1440px')
  await closeDialogs()
  assert((await dialogs()) === 0, 'Escape closes it')
})

await check('labels shorten under 816px and controls move into "More options" at 544px', async () => {
  await width(816)
  assert(await page.getByRole('button', { name: 'Submit review' }).isVisible(), 'Submit review at 816px')
  await width(815)
  assert(await page.getByRole('button', { name: 'Review', exact: true }).isVisible(), 'Review at 815px')
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

await check('the title and the tabs stay put when switching tabs (1920px)', async () => {
  await width(1920)
  const at = []
  for (const tab of ['files', 'conversation', 'commits', 'checks']) {
    await page.evaluate((t) => window.__prv.getState().setTab(t), tab)
    await settle(300)
    at.push(await page.evaluate(() => [document.querySelector('.PullHeader-title'), document.querySelector('.TabNav-link')].map((e) => Math.round(e.getBoundingClientRect().left)).join(',')))
  }
  assert(new Set(at).size === 1, `positions per tab: ${at.join(' | ')}`)
  await page.evaluate(() => window.__prv.getState().setTab('files'))
  await width(1440)
})

await check("native views (fake bridge): a commit's title opens Files changed for that commit", async () => {
  const native = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-US' })
  await native.addInitScript({ path: fileURLToPath(new URL('./fake-native.js', import.meta.url)) })
  const p = await native.newPage()
  p.on('pageerror', (e) => errors.push(e.message))
  await p.goto(exportUrl(file), { waitUntil: 'load' })
  await p.waitForTimeout(1500)
  await p.getByRole('link', { name: /^Commits/ }).click()
  await p.waitForTimeout(400)
  const title = p.locator('a.CommitRow-title').first()
  const sha = await p.locator('a.CommitRow-sha').first().textContent()
  // While the commit loads (slowed down here), the Commits tab stays under the progress bar, like
  // github.com: Files changed never shows the previous diff as if it were the commit's.
  await p.evaluate(() => (window.__prvSlowRange = 1200))
  await title.click()
  await p.waitForTimeout(600)
  const during = await p.evaluate(() => ({ tab: window.__prv.getState().tab, bar: !!document.querySelector('.ProgressBar:not(.is-done)'), rows: document.querySelectorAll('.CommitRow').length }))
  assert(during.tab === 'commits' && during.bar && during.rows > 0, `while loading: ${JSON.stringify(during)}`)
  await p.waitForTimeout(1200)
  const state = await p.evaluate(() => ({ tab: window.__prv.getState().tab, from: window.__prv.getState().range.from }))
  assert(state.tab === 'files' && state.from?.startsWith(sha.trim()), `after loading: ${JSON.stringify(state)}`)
  assert((await p.locator('.CommitPicker-button').textContent()).trim() === sha.trim(), 'the commit picker shows the commit')
  await p.waitForTimeout(500)
  assert(!(await p.locator('.ProgressBar').count()), 'the progress bar is gone once loaded')
  await p.evaluate(() => (window.__prvSlowRange = 0))
  // The conversation timeline links its commits too.
  await p.getByRole('link', { name: /^Conversation/ }).click()
  await p.waitForTimeout(400)
  assert((await p.locator('.TimelineItem-commitTitle a.Link--secondary, .TimelineItem-sha a.Link--secondary').count()) >= 2, 'timeline commit links')
  await native.close()
})

await check('Confirm: an approval for the agent, or with --publish a push and a pull request (fake bridge)', async () => {
  for (const publish of [false, true]) {
    const native = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-US' })
    await native.addInitScript({ path: fileURLToPath(new URL('./fake-native.js', import.meta.url)) })
    await native.addInitScript((v) => (window.__prvPublish = v), publish)
    const p = await native.newPage()
    p.on('pageerror', (e) => errors.push(e.message))
    await p.goto(exportUrl(file), { waitUntil: 'load' })
    await p.waitForTimeout(1500)
    await p.getByRole('link', { name: /^Conversation/ }).click()
    await p.waitForTimeout(300)
    const merge = (await p.locator('.MergeBox').getByRole('button', { name: /Confirm/ }).textContent()).trim()
    assert(merge === (publish ? 'Confirm and create pull request' : 'Confirm'), `merge box: ${merge}`)
    await p.locator('.MergeBox').getByRole('button', { name: /Confirm/ }).click()
    await p.waitForTimeout(500)
    const form = p.locator('.ReviewForm')
    const caption = await form.getByRole('radio', { name: 'Confirm' }).evaluate((r) => r.closest('[class*="FormControl"]')?.parentElement?.textContent ?? '')
    const titled = await form.getByRole('textbox', { name: 'Title' }).count()
    const button = (await form.locator('.ReviewForm-submit').textContent()).trim()
    if (publish) {
      assert(/Push .+ and open a pull request into/.test(caption), `caption: ${caption}`)
      assert(titled === 1 && button.startsWith('Confirm and create pull request'), `title field ${titled}, button ${button}`)
    } else {
      assert(/approve these changes for a pull request into/.test(caption), `caption: ${caption}`)
      assert(titled === 0 && button.startsWith('Submit review'), `title field ${titled}, button ${button}`)
    }
    await native.close()
  }
  // An export: the approval tells the agent to open the pull request itself.
  const p = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  p.on('pageerror', (e) => errors.push(e.message))
  await openExport(p, file, { wait: 1500 })
  await p.getByRole('button', { name: 'Submit review' }).click()
  await p.waitForTimeout(300)
  await p.getByRole('radio', { name: 'Confirm' }).check()
  await p.locator('.ReviewForm-submit').click()
  await p.waitForTimeout(800)
  const md = await p.locator('.SubmittedDialog pre').innerText()
  assert(/# Pull request preview: Confirmed/.test(md) && /Nothing was pushed: push `.+` and open the pull request into `.+` the way this repository does it/.test(md), md.slice(0, 300))
  await p.close()
})

await check('image files: added or deleted alone, changed in 2-up, Swipe and Onion Skin; sizes in the header', async () => {
  const images = process.argv[3]
  if (!images) return // no second export given
  const ip = await ctx.newPage()
  await openExport(ip, images, { settings: { treeVisible: false } })
  const changed = ip.locator('.DiffEntry', { has: ip.locator('.ImageDiff-modes') }).first()
  await changed.scrollIntoViewIfNeeded()
  await ip.waitForTimeout(600)
  const loaded = (sel) => changed.locator(sel).evaluateAll((imgs) => imgs.every((i) => i.complete && i.naturalWidth > 0) && imgs.length)
  assert((await loaded('.ImageDiff-twoUp img')) === 2, '2-up shows both images')
  assert(/W: \d+px \| H: \d+px/.test(await changed.locator('.ImageDiff-meta').first().textContent()), 'sizes under the images')
  await changed.getByRole('radio', { name: 'Swipe' }).click()
  await ip.waitForTimeout(300)
  const slider = changed.getByRole('slider')
  await slider.focus()
  await ip.keyboard.press('ArrowRight')
  assert((await slider.getAttribute('aria-valuenow')) === '5', 'the swipe handle moves with the arrow keys')
  await changed.getByRole('radio', { name: 'Onion Skin' }).click()
  await changed.locator('input[type=range]').fill('30')
  const opacity = await changed.locator('.ImageDiff-frame--added').evaluate((e) => getComputedStyle(e).opacity)
  assert(opacity === '0.3', `onion skin opacity ${opacity}`)
  const sizes = await ip.locator('.DiffFileHeader-size').allTextContents()
  assert(sizes.length > 0 && sizes.every((t) => /^-?[\d.]+ (Bytes?|KB|MB|GB)$/.test(t)), `header sizes: ${sizes.join(', ')}`)
  await ip.close()
})

await check('native views (fake bridge): checks list beside the log, stacked at 768px and below', async () => {
  const native = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-US' })
  await native.addInitScript({ path: fileURLToPath(new URL('./fake-native.js', import.meta.url)) })
  const p = await native.newPage()
  p.on('pageerror', (e) => errors.push(e.message))
  await p.goto(exportUrl(file), { waitUntil: 'load' })
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

await check('no request left the file (no host contacted)', async () => {
  assert(external.length === 0, `requested: ${[...new Set(external)].slice(0, 5).join(', ')}`)
})

console.log(results.join('\n'))
console.log(errors.length ? `console errors:\n${errors.join('\n')}` : 'no console errors')
await browser.close()
process.exit(failed || errors.length ? 1 : 0)
