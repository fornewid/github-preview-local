// What the tools in this folder share: the signed-in Chrome profile and opening github.com with it,
// opening a gh-prv-local export, and the file tree toggle. Importing this module does nothing by itself.
import { chromium } from 'playwright-core'
import os from 'node:os'
import path from 'node:path'

/** The profile login.mjs signs in with: outside the repository, it holds your GitHub session. */
export const DEFAULT_PROFILE = path.join(os.homedir(), '.cache', 'prv-reference', 'chrome-profile')

// Window size, light or dark scheme (default light), device scale (default 1); English UI.
const contextOptions = ({ width = 1440, height = 900, scheme, scale }) => ({
  viewport: { width, height },
  ...(scheme && { colorScheme: scheme }),
  ...(scale && { deviceScaleFactor: scale }),
  locale: 'en-US',
})

/**
 * The installed Google Chrome, headless, signed in with `profile` (login.mjs). Returns the context and
 * its page. `extra` goes to launchPersistentContext as it is (for example handleSIGINT).
 */
export async function openGithub({ width, height, scheme, scale, profile = DEFAULT_PROFILE, ...extra } = {}) {
  const ctx = await chromium.launchPersistentContext(profile, {
    channel: 'chrome',
    headless: true,
    ...contextOptions({ width, height, scheme, scale }),
    // login.mjs signs in with a plain Chrome, which encrypts cookies with the real keychain.
    ignoreDefaultArgs: ['--use-mock-keychain'],
    ...extra,
  })
  return { ctx, page: ctx.pages()[0] ?? (await ctx.newPage()) }
}

/** The installed Google Chrome, headless, with a fresh profile (for exports): browser, context, page. */
export async function openChrome({ width, height, scheme, scale } = {}) {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const ctx = await browser.newContext(contextOptions({ width, height, scheme, scale }))
  return { browser, ctx, page: await ctx.newPage() }
}

/**
 * Loads a signed-in github.com page. It keeps live-update connections open, so this waits for
 * `selector` (none: skip; `optional`: a missing one is fine) instead of network idle, then `wait` ms.
 */
export async function gotoGithub(page, url, { selector = 'table', optional = false, wait = 3000 } = {}) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 })
  if (selector) {
    const shown = page.waitForSelector(selector, { timeout: 60000 })
    await (optional ? shown.catch(() => {}) : shown)
  }
  await page.waitForTimeout(wait)
}

/** The pull request's URL without the Files changed path (/files, /changes, …) or a trailing slash. */
export const prBase = (url) => url.replace(/\/(files|changes).*$/, '').replace(/\/$/, '')

export const exportUrl = (file) => 'file://' + path.resolve(file)

/**
 * Opens a gh-prv-local export in `page` with these settings (saved before a reload, on top of split
 * view and compact lines) and waits `wait` ms. `clear: false` keeps the rest of localStorage (viewed
 * files, pending comments).
 */
export async function openExport(page, file, { query = '', settings = {}, clear = true, wait = 2000 } = {}) {
  const url = exportUrl(file) + query
  await page.goto(url, { waitUntil: 'load' })
  await page.evaluate(
    ([s, clear]) => {
      if (clear) localStorage.clear()
      localStorage.setItem('prv:settings', JSON.stringify({ diffView: 'split', compact: true, ...s }))
    },
    [settings, clear],
  )
  await page.goto(url, { waitUntil: 'load' })
  await page.waitForTimeout(wait)
}

/** Whether the file tree is shown beside the diffs (not in a dialog), on github.com and on an export. */
export const treeVisible = (page) =>
  page.evaluate(() => {
    const t = document.querySelector('[role="tree"]')
    return !!t && t.getBoundingClientRect().width > 0 && !t.closest('[role="dialog"]')
  })

/**
 * Shows or hides the file tree with the toolbar toggle and returns whether it now is as asked.
 * github.com keeps the choice per user: the tools put it back as they found it.
 */
export async function setTreeVisible(page, visible) {
  if ((await treeVisible(page)) !== visible) {
    await page.getByRole('button', { name: visible ? 'Expand file tree' : 'Collapse file tree' }).first().click()
    await page.waitForTimeout(1500)
  }
  return (await treeVisible(page)) === visible
}
