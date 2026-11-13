import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@primer/primitives/dist/css/primitives.css'
import '@primer/primitives/dist/css/functional/themes/light.css'
import '@primer/primitives/dist/css/functional/themes/dark.css'
import '@primer/primitives/dist/css/functional/themes/dark-dimmed.css'
import '@primer/primitives/dist/css/functional/themes/light-high-contrast.css'
import '@primer/primitives/dist/css/functional/themes/dark-high-contrast.css'
import '@wooorm/starry-night/style/core'
import './styles/prv.css'
import { App } from './App'
import { createTransport, type Transport } from './transport'
import { useStore } from './store'
import { runSelftest } from './selftest'

// Theme selection (`?theme=`) mirrors github.com's <html data-color-mode data-light-theme data-dark-theme>.
const theme = new URLSearchParams(location.search).get('theme') ?? 'auto'
const html = document.documentElement
html.dataset.colorMode = theme === 'auto' ? 'auto' : theme === 'light' || theme === 'light_high_contrast' ? 'light' : 'dark'
html.dataset.lightTheme = theme === 'light_high_contrast' ? 'light_high_contrast' : 'light'
html.dataset.darkTheme = ['dark_dimmed', 'dark_high_contrast'].includes(theme) ? theme : 'dark'
// The native window (WebKit) picks other fonts than Chrome for the same CSS; prv.css evens that out.
if (window.__TAURI_INTERNALS__) html.classList.add('prv-native')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

/**
 * Links never take the review away: other sites open in a new tab (the native window hands them to
 * the browser itself), and paths relative to this page (in a comment, say) do nothing. In a browser
 * tab, leaving with a review being written asks first.
 *
 * A jump within the page (a file name, `#…`) replaces the address instead of adding a history
 * entry as github.com does: a browser lets a tab close itself only while it has one (issue #18).
 */
function keepThePage(kind: Transport['kind']) {
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return
    const a = (e.target as Element | null)?.closest?.('a[href]')
    const href = a?.getAttribute('href') ?? ''
    if (!a) return
    if (href.startsWith('#')) {
      e.preventDefault()
      let id = href.slice(1)
      try {
        id = decodeURIComponent(id)
      } catch {
        // Not encoded after all: the id as written.
      }
      const target = document.getElementById(id)
      // `#` and `#top` go to the top, as in a browser.
      if (target) target.scrollIntoView()
      else if (!id || id.toLowerCase() === 'top') window.scrollTo(0, 0)
      try {
        history.replaceState(history.state, '', href)
      } catch {
        // A page that may not change its address (opened in a sandbox, say): the jump is enough.
      }
      return
    }
    let url: URL
    try {
      url = new URL(href, location.href)
    } catch {
      // Not an address at all: going nowhere.
      return e.preventDefault()
    }
    if (url.protocol === 'mailto:') return
    if (/^https?:$/.test(url.protocol) && url.origin !== location.origin) {
      if (kind === 'native') return
      e.preventDefault()
      window.open(url.href, '_blank', 'noopener,noreferrer')
      return
    }
    e.preventDefault()
  })
  // A file dropped anywhere would replace the page (nothing here takes files); text still drops
  // into the text boxes.
  for (const type of ['dragover', 'drop'] as const)
    window.addEventListener(type, (e) => {
      if (!e.defaultPrevented && e.dataTransfer?.types.includes('Files')) e.preventDefault()
    })
  if (kind === 'browser')
    window.addEventListener('beforeunload', (e) => {
      const s = useStore.getState()
      if (!s.submitted && (s.reviewDraft.body.trim() || s.composing)) {
        e.preventDefault()
        e.returnValue = ''
      }
    })
}

createTransport()
  .then((t) => {
    keepThePage(t.kind)
    return useStore.getState().init(t)
  })
  .catch((e) => useStore.setState({ error: String(e), loading: false }))
  .finally(() => {
    const mode = (window as unknown as { __PRV_SELFTEST__?: true | 'flows' }).__PRV_SELFTEST__
    // `GH_PRV_LOCAL_SELFTEST=1 gh-prv-local` (or `=flows`): exercise the native IPC path, report, then exit.
    if (mode) void runSelftest(mode)
  })
