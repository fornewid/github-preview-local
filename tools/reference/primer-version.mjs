// Finds which @primer/react release github.com is running, from a page captured by snapshot.mjs.
// Primer's CSS-module class names carry a content hash (`prc-Button-ButtonBase-9n-Xk`), so the
// release whose CSS defines every `prc-*` class on the page is the one to install in ui/.
//
//   node primer-version.mjs <captured page .html> [how many recent releases, default 12]
//
// Also compares the page's light theme tokens with the installed @primer/primitives.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const [, , htmlFile, countArg = '12'] = process.argv
if (!htmlFile) {
  console.error('usage: node primer-version.mjs <page.html> [count]')
  process.exit(1)
}
const html = fs.readFileSync(htmlFile, 'utf8')
const classes = [...new Set(html.match(/\bprc-[A-Za-z]+-[A-Za-z0-9]+-[A-Za-z0-9_-]{5}\b/g) ?? [])]
console.log(`${classes.length} Primer React classes on the page`)

const versions = JSON.parse(execFileSync('npm', ['view', '@primer/react', 'versions', '--json'], { encoding: 'utf8' }))
  .filter((v) => !v.includes('-'))
  .slice(-Number(countArg))
  .reverse()
// A per-user cache (not a shared temp dir): npm pack and tar run inside it.
const cache = path.join(os.homedir(), '.cache', 'prv-reference', 'primer-react')
fs.mkdirSync(cache, { recursive: true, mode: 0o700 })

const cssOf = (dir) => {
  let out = ''
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.css')) out += fs.readFileSync(p, 'utf8')
    }
  }
  walk(dir)
  return out
}

const matches = []
for (const v of versions) {
  const dir = path.join(cache, v)
  if (!fs.existsSync(path.join(dir, 'package'))) {
    fs.mkdirSync(dir, { recursive: true })
    const tgz = execFileSync('npm', ['pack', `@primer/react@${v}`, '--silent'], { cwd: dir, encoding: 'utf8' }).trim().split('\n').pop()
    execFileSync('tar', ['xzf', tgz], { cwd: dir })
  }
  const css = cssOf(path.join(dir, 'package', 'dist'))
  const missing = classes.filter((c) => !css.includes(c))
  console.log(`${v}: ${missing.length ? `${missing.length} missing (${missing.slice(0, 3).join(', ')})` : 'all match'}`)
  if (!missing.length) matches.push(v)
}
const installed = JSON.parse(fs.readFileSync(new URL('../../ui/node_modules/@primer/react/package.json', import.meta.url), 'utf8')).version
console.log(`\ninstalled in ui/: ${installed}`)
console.log(matches.length ? `matching releases: ${matches.join(', ')}` : 'no recent release matches: check more releases or a canary build')

// Theme tokens: github.com's light theme vs the installed @primer/primitives.
const themeHref = html.match(/href="([^"]*\/light-[0-9a-f]+\.css)"/)?.[1]
if (themeHref) {
  const res = await fetch(themeHref)
  const gh = Object.fromEntries([...(await res.text()).matchAll(/(--[\w-]+):\s*([^;}]+)/g)].map((m) => [m[1], m[2].trim()]))
  const ours = fs.readFileSync(new URL('../../ui/node_modules/@primer/primitives/dist/css/functional/themes/light.css', import.meta.url), 'utf8')
  const us = Object.fromEntries([...ours.matchAll(/(--[\w-]+):\s*([^;}]+)/g)].map((m) => [m[1], m[2].trim()]))
  const norm = (v) => v.toLowerCase().replace(/\s/g, '').replace(/#([0-9a-f]{3,4})\b/g, (_, h) => '#' + [...h].map((c) => c + c).join(''))
  const diff = Object.keys(gh).filter((k) => k in us && norm(gh[k]) !== norm(us[k]))
  const onlyGh = Object.keys(gh).filter((k) => !(k in us))
  console.log(`\ntheme tokens: ${diff.length} differ, ${onlyGh.length} only on github.com`)
  for (const k of [...diff, ...onlyGh].slice(0, 20)) console.log(`  ${k}: ${gh[k]} | ours: ${us[k] ?? '(none)'}`)
}
