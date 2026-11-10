// Opens a plain Chrome window (no automation flags, so sign-in pages that block automated
// browsers work) with a dedicated profile, waits until you have signed in to GitHub, then
// closes it. snapshot.mjs captures the signed-in pages headlessly with the same profile.
//
//   node login.mjs [profileDir]
//
// The profile defaults to ~/.cache/prv-reference/chrome-profile (outside the repository; it
// holds your GitHub session). Delete that folder to sign out for good.
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const DEFAULT_PROFILE = path.join(os.homedir(), '.cache', 'prv-reference', 'chrome-profile')
const profile = process.argv[2] || DEFAULT_PROFILE
// The profile holds a GitHub session: keep it private to this user.
fs.mkdirSync(profile, { recursive: true, mode: 0o700 })
fs.chmodSync(profile, 0o700)
if (profile === DEFAULT_PROFILE) fs.chmodSync(path.dirname(profile), 0o700)

// The installed Google Chrome (the same browser playwright's `channel: 'chrome'` drives).
const chrome =
  process.env.CHROME_PATH ||
  {
    darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    win32: path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  }[process.platform] ||
  '/usr/bin/google-chrome'
const child = spawn(chrome, [`--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'https://github.com/login'], {
  stdio: 'ignore',
})
let exited = false
child.on('exit', () => (exited = true))
child.on('error', (e) => {
  console.error(`could not start Chrome (${chrome}): ${e.message}. Set CHROME_PATH.`)
  process.exit(1)
})
console.log(`Sign in to GitHub in the opened window (profile: ${profile}).`)

// Signed in once the session cookie is stored (Chrome writes cookies to disk within ~30s).
const cookies = path.join(profile, 'Default', 'Cookies')
const signedIn = () => {
  try {
    const out = execFileSync('sqlite3', [
      `file:${cookies}?immutable=1`,
      "select count(*) from cookies where host_key in ('github.com','.github.com') and name in ('user_session','dotcom_user')",
    ])
    return Number(out.toString().trim()) >= 2
  } catch {
    return false
  }
}

const deadline = Date.now() + 20 * 60 * 1000
let ok = false
while (Date.now() < deadline && !exited) {
  await new Promise((r) => setTimeout(r, 3000))
  if (signedIn()) {
    ok = true
    break
  }
}
if (!exited) {
  // Graceful shutdown flushes the cookie store.
  child.kill('SIGTERM')
  await new Promise((r) => (exited ? r() : child.on('exit', r)))
}
ok ||= signedIn()
console.log(ok ? 'signed in' : exited ? 'window closed before signing in' : 'not signed in (timed out)')
process.exit(ok ? 0 : 1)
