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
import { createTransport } from './transport'
import { useStore } from './store'
import { runSelftest } from './selftest'

// Theme selection mirrors github.com's <html data-color-mode data-light-theme data-dark-theme>.
const params = new URLSearchParams(location.search)
const theme = params.get('theme') ?? localStorage.getItem('prv:theme') ?? 'auto'
const html = document.documentElement
html.dataset.colorMode = theme === 'light' || theme === 'dark' ? theme : theme === 'auto' ? 'auto' : 'dark'
html.dataset.lightTheme = theme === 'light_high_contrast' ? 'light_high_contrast' : 'light'
html.dataset.darkTheme = ['dark_dimmed', 'dark_high_contrast'].includes(theme) ? theme : 'dark'
// The native window (WebKit) picks other fonts than Chrome for the same CSS; prv.css evens that out.
if ((window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) html.classList.add('prv-native')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

createTransport()
  .then((t) => useStore.getState().init(t))
  .catch((e) => useStore.setState({ error: String(e), loading: false }))
  .finally(() => {
    const mode = (window as unknown as { __PRV_SELFTEST__?: true | 'flows' }).__PRV_SELFTEST__
    // `PRV_SELFTEST=1 prv` (or `=flows`): exercise the native IPC path, report, then exit.
    if (mode) void runSelftest(mode)
  })
