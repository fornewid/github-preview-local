// The browser tab mode, end to end, with headless Chrome: the server's guards (token, Host, Origin,
// cross-site requests, CSP), concurrent saves, links, a review submitted from the tab (printed on
// stdout, the run ends) and a closed tab (the run ends as "closed"). No browser of yours opens
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
  check('the tab says it is done', /Review submitted/.test(await tab.locator('body').innerText()))
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
console.log(results.join('\n'))
process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0)
