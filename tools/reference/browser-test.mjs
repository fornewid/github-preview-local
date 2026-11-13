// The browser tab mode, end to end, with headless Chrome: the server's guards (token, Host, Origin,
// cross-site requests, CSP), concurrent saves, links, a review submitted from the tab (printed on
// stdout, the run ends), a closed tab (the run ends as "closed") and a tab that closes itself after
// the review ("Don't show this again"). No browser of yours opens
// (GH_PRV_LOCAL_BROWSER=none). Use a scratch repository: the review comments stay out of it, but
// the state of its branch is written.
//
//   node browser-test.mjs <gh-prv-local binary> <repository> [base=main]
import { spawn } from 'node:child_process'
import { openChrome } from './common.mjs'
const [, , bin, repo, base = 'main'] = process.argv
const results = []
const check = (name, ok, detail = '') => results.push(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ': ' + detail}`)

function start(port) {
  // No flag: a browser tab is the default; GH_PRV_LOCAL_BROWSER=none only prints the address.
  const p = spawn(bin, ['-C', repo, '--no-fetch', '--base', base], { env: { ...process.env, GH_PRV_LOCAL_PORT: String(port), GH_PRV_LOCAL_BROWSER: 'none' } })
  let out = ''
  let err = ''
  p.stdout.on('data', (d) => (out += d))
  p.stderr.on('data', (d) => (err += d))
  const url = new Promise((res) => p.stderr.on('data', () => { const m = err.match(/http:\/\/127\.0\.0\.1:\d+\/\?code=[0-9a-f]+/); if (m) res(m[0]) }))
  const exit = new Promise((res) => p.on('exit', (code) => res(code)))
  return { p, url, exit, out: () => out, err: () => err }
}

// 1. Submit a review from the tab.
{
  const run = start(19611)
  const url = await run.url
  const origin = url.split('/?')[0]
  const launch = url.split('code=')[1]
  // The page trades the one-time code in the address for this run's token.
  const { browser, ctx, page: tab } = await openChrome({ width: 1440, height: 900 })
  const external = []
  ctx.on('request', (r) => r.url().startsWith(origin) || /^(data|blob):/.test(r.url()) || external.push(r.url()))
  await tab.goto(url)
  await tab.waitForSelector('.DiffEntry', { timeout: 20000 })
  check('page loads over HTTP and drops the code from the address', !tab.url().includes('code='), tab.url())
  const token = await tab.evaluate(() => sessionStorage.getItem('prv:token'))
  const trade = (c) => fetch(origin + '/api/session', { method: 'POST', headers: { 'X-Prv-Code': c } }).then((r) => r.status)
  check('the code works once: a second use is refused', (await trade(launch)) === 401)
  check('a wrong code is refused', (await trade('0'.repeat(32))) === 401)
  check('the code is not the token', !!token && token !== launch)
  // Security: token, Host, Origin, Sec-Fetch-Site.
  const api = (headers, path = '/api/list_checks', method = 'POST') => fetch(origin + path, { method, headers, body: method === 'POST' ? '{}' : undefined }).then((r) => r.status)
  check('no token: 401', (await api({ 'Content-Type': 'application/json' })) === 401)
  check('wrong token: 401', (await api({ 'X-Prv-Token': 'x'.repeat(32) })) === 401)
  check('right token: 200', (await api({ 'X-Prv-Token': token })) === 200)
  check('another Origin: 403', (await api({ 'X-Prv-Token': token, Origin: 'https://evil.example' })) === 403)
  check('cross-site request: 403', (await api({ 'X-Prv-Token': token, 'Sec-Fetch-Site': 'cross-site' })) === 403)
  const notJson = await fetch(origin + '/api/save_state', { method: 'POST', headers: { 'X-Prv-Token': token }, body: '{not json' })
  check('a body that is not JSON: 400 (the state is left alone)', notJson.status === 400, String(notJson.status))
  // Host header (DNS rebinding): raw request, fetch cannot set Host.
  const net = await import('node:net')
  const rebound = await new Promise((res) => {
    const s = net.connect(Number(origin.split(':')[2]), '127.0.0.1', () => s.write(`GET / HTTP/1.1\r\nHost: evil.example:${origin.split(':')[2]}\r\n\r\n`))
    let d = ''
    s.on('data', (c) => (d += c)).on('end', () => res(d.split('\r\n')[0]))
  })
  check('another Host: 403', /403/.test(rebound), rebound)
  const page = await fetch(origin + '/', { headers: { 'Sec-Fetch-Site': 'none' } })
  check('page has CSP with frame-ancestors none', /frame-ancestors 'none'/.test(page.headers.get('content-security-policy') ?? ''), page.headers.get('content-security-policy'))

  // Saves from many threads at once leave a valid state file.
  const save = (i) => fetch(origin + '/api/save_state', { method: 'POST', headers: { 'X-Prv-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify({ state: { viewed: {}, drafts: [], n: i } }) })
  await fetch(origin + '/api/get_snapshot', { method: 'POST', headers: { 'X-Prv-Token': token }, body: '{}' })
  let broken = 0
  for (let round = 0; round < 20; round++) {
    await Promise.all(Array.from({ length: 16 }, (_, i) => save(i)))
    const st = await (await fetch(origin + '/api/load_state', { method: 'POST', headers: { 'X-Prv-Token': token }, body: '{}' })).json()
    if (!st.ok) broken++
  }
  check('concurrent saves keep the state file valid', broken === 0, String(broken) + ' broken')
  check('connected: commit picker allows ranges', !(await tab.locator('.CommitPicker-note').count()))
  await tab.reload()
  await tab.waitForSelector('.DiffEntry', { timeout: 20000 })
  check('a reload keeps working (token kept for the tab)', (await tab.locator('.App-error').count()) === 0)
  // Links: another site opens in a new tab, a relative link does nothing; the review stays.
  await tab.evaluate(() => {
    const st = window.__prv.getState()
    st.addComment({ path: st.snapshot.files[0].path, side: 'RIGHT', line: 0, body: '[out](https://example.com/) [rel](docs/x.md)' })
  })
  await tab.waitForTimeout(500)
  const before = tab.url()
  await ctx.route('https://example.com/**', (r) => r.fulfill({ body: 'ok' }))
  const popup = ctx.waitForEvent('page', { timeout: 5000 }).catch(() => null)
  await tab.locator('.markdown-body a', { hasText: 'out' }).first().click()
  const opened = await popup
  check('an outside link opens a new tab', !!opened && tab.url() === before, String(opened && opened.url()))
  if (opened) await opened.close()
  await tab.locator('.markdown-body a', { hasText: 'rel' }).first().click()
  await tab.waitForTimeout(500)
  check('a relative link keeps the page', tab.url() === before, tab.url())
  // A file name jumps to its file without a history entry (a tab with one can close itself).
  const entries = await tab.evaluate(() => history.length)
  await tab.locator('.DiffFileHeader-name a').last().click()
  await tab.waitForTimeout(300)
  const jumped = await tab.evaluate(() => ({ n: history.length, hash: location.hash, y: scrollY }))
  check('a file name jumps to the file and keeps one history entry', jumped.n === entries && /^#diff-/.test(jumped.hash) && jumped.y > 0, JSON.stringify({ entries, ...jumped }))
  external.length = 0 // the routed example.com tab above was ours
  await tab.evaluate(() => { const st = window.__prv.getState(); st.deleteComment(st.drafts.at(-1).id) })
  const cell = tab.locator('td.right-side-diff-cell').first()
  await cell.hover()
  await cell.getByRole('button', { name: 'Add comment' }).click()
  await tab.getByRole('textbox', { name: 'Add diff comment' }).fill('From the browser tab')
  await tab.getByRole('button', { name: 'Start a review' }).click()
  await tab.getByRole('button', { name: 'Submit review' }).click()
  await tab.getByRole('textbox', { name: 'Review body' }).fill('Browser review')
  await tab.getByRole('radio', { name: 'Request changes' }).check()
  await tab.locator('.ReviewForm-submit').click()
  const code = await Promise.race([run.exit, new Promise((r) => setTimeout(() => r('timeout'), 15000))])
  check('the CLI exits after the submit', code === 0, String(code))
  check('the review is on stdout', /Changes requested/.test(run.out()) && /From the browser tab/.test(run.out()), run.out().slice(0, 200))
  await tab.waitForTimeout(500)
  check('the tab says it is done', /Review submitted/.test(await tab.locator('.SubmittedDialog').innerText()) && (await tab.locator('.ReviewForm').count()) === 0)
  const dontShow = tab.getByRole('checkbox', { name: "Don't show this again" })
  check('"Don\'t show this again" starts off', (await dontShow.count()) === 1 && !(await dontShow.isChecked()))
  await dontShow.check()
  const saved = await tab.evaluate(() => JSON.parse(localStorage.getItem('prv:settings') ?? '{}').closeTab)
  check('ticking it is saved for the next review (this tab stays)', saved === true && !tab.isClosed())
  check('no request to any other host', external.length === 0, external.join(', '))
  await browser.close()
}

// 2. Close the tab: the CLI ends with "closed".
{
  const run = start(19612)
  const url = await run.url
  const { browser, page: tab } = await openChrome({ width: 1200, height: 800 })
  await tab.goto(url)
  await tab.waitForSelector('.DiffEntry', { timeout: 20000 })
  const t0 = Date.now()
  await browser.close()
  const code = await Promise.race([run.exit, new Promise((r) => setTimeout(() => r('timeout'), 45000))])
  check(`closing the tab ends the run (${Math.round((Date.now() - t0) / 1000)}s)`, code === 0 && /closed/.test(run.out()), `${code} ${run.out()}`)
  if (code === 'timeout') run.p.kill()
}
// 3–4. "Don't show this again": the tab closes itself once the review is submitted, unless the
// browser refuses (a tab it did not open by script, with more than one history entry).
async function submitWithCloseTab(port, { extraEntry }) {
  const run = start(port)
  const url = await run.url
  const { browser, ctx, page: blank } = await openChrome({ width: 1200, height: 800 })
  // A tab opened at the address, as gh-prv-local opens it (newPage's about:blank would be a second
  // history entry): one history entry, and not opened by a script.
  const { targetInfo } = await (await ctx.newCDPSession(blank)).send('Target.getTargetInfo')
  const opened = ctx.waitForEvent('page')
  await (await browser.newBrowserCDPSession()).send('Target.createTarget', { url, browserContextId: targetInfo.browserContextId })
  const tab = await opened
  await blank.close()
  await tab.waitForSelector('.DiffEntry', { timeout: 20000 })
  await tab.evaluate(() => localStorage.setItem('prv:settings', JSON.stringify({ closeTab: true })))
  await tab.reload()
  await tab.waitForSelector('.DiffEntry', { timeout: 20000 })
  await tab.locator('.DiffFileHeader-name a').first().click()
  if (extraEntry) await tab.evaluate(() => history.pushState(null, '', '#elsewhere'))
  const entries = await tab.evaluate(() => history.length)
  // Waited for from before the submit (the close may come right after it); the dialog shows only
  // once the browser has kept the tab open.
  const closed = Promise.race([
    tab.waitForEvent('close', { timeout: 20000 }).then(() => true, () => false),
    tab.waitForSelector('.SubmittedDialog', { timeout: 20000 }).then(() => false, () => new Promise(() => {})),
  ])
  await tab.getByRole('button', { name: 'Submit review' }).click()
  await tab.getByRole('textbox', { name: 'Review body' }).fill('Closing review')
  await tab.locator('.ReviewForm-submit').click()
  const code = await Promise.race([run.exit, new Promise((r) => setTimeout(() => r('timeout'), 15000))])
  if (code === 'timeout') run.p.kill()
  return { browser, tab, entries, closed: await closed, code, out: run.out() }
}
{
  const r = await submitWithCloseTab(19613, { extraEntry: false })
  check('"Don\'t show this again": the review goes out and the tab closes itself', r.code === 0 && /Closing review/.test(r.out) && r.closed, JSON.stringify({ code: r.code, closed: r.closed, entries: r.entries }))
  await r.browser.close()
}
{
  const r = await submitWithCloseTab(19614, { extraEntry: true })
  const text = r.closed ? '' : await r.tab.locator('.SubmittedDialog').innerText().catch(() => '')
  const ticked = !r.closed && (await r.tab.getByRole('checkbox', { name: "Don't show this again" }).isChecked().catch(() => false))
  check('a tab the browser keeps open shows the dialog instead (still ticked)', r.code === 0 && !r.closed && /close it yourself/.test(text) && ticked, JSON.stringify({ code: r.code, closed: r.closed, entries: r.entries, text }))
  await r.browser.close()
}
// 5. Confirm without --publish: the approval goes to stdout and nothing is pushed (the server
// refuses to publish in this run).
{
  const run = start(19615)
  const url = await run.url
  const origin = url.split('/?')[0]
  const { browser, page: tab } = await openChrome({ width: 1200, height: 800 })
  await tab.goto(url)
  await tab.waitForSelector('.DiffEntry', { timeout: 20000 })
  const token = await tab.evaluate(() => sessionStorage.getItem('prv:token'))
  const refused = await (await fetch(origin + '/api/publish', { method: 'POST', headers: { 'X-Prv-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify({ req: { title: 't', body: '', draft: false } }) })).json()
  check('without --publish the server does not push', /does not push/.test(refused.error ?? ''), JSON.stringify(refused))
  await tab.getByRole('button', { name: 'Submit review' }).click()
  await tab.getByRole('radio', { name: 'Confirm' }).check()
  await tab.getByRole('textbox', { name: 'Review body' }).fill('Ship it')
  await tab.locator('.ReviewForm-submit').click()
  const code = await Promise.race([run.exit, new Promise((r) => setTimeout(() => r('timeout'), 15000))])
  if (code === 'timeout') run.p.kill()
  check('Confirm: the approval on stdout, for the agent to open the pull request', code === 0 && /Pull request preview: Confirmed/.test(run.out()) && /Nothing was pushed/.test(run.out()) && /Ship it/.test(run.out()), `${code} ${run.out().slice(0, 300)}`)
  await browser.close()
}
console.log(results.join('\n'))
process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0)
