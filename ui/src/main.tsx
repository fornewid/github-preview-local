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

// Theme selection mirrors github.com's <html data-color-mode data-light-theme data-dark-theme>.
const params = new URLSearchParams(location.search)
const theme = params.get('theme') ?? localStorage.getItem('prv:theme') ?? 'auto'
const html = document.documentElement
html.dataset.colorMode = theme === 'light' || theme === 'dark' ? theme : theme === 'auto' ? 'auto' : 'dark'
html.dataset.lightTheme = theme === 'light_high_contrast' ? 'light_high_contrast' : 'light'
html.dataset.darkTheme = ['dark_dimmed', 'dark_high_contrast'].includes(theme) ? theme : 'dark'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

createTransport()
  .then((t) => useStore.getState().init(t))
  .catch((e) => useStore.setState({ error: String(e), loading: false }))
  .finally(() => {
    if (!(window as unknown as { __PRV_SELFTEST__?: boolean }).__PRV_SELFTEST__) return
    // `PRV_SELFTEST=1 prv`: report what was rendered through the native IPC path, then exit.
    setTimeout(async () => {
      const s = useStore.getState()
      // Zoom like Cmd+= does (not saved): the page must lay out for the smaller CSS width. A zoom
      // the user saved is already applied, so compute from the unzoomed width and restore it after.
      const saved = s.settings.zoom || 1
      const base = window.innerWidth * saved
      s.applySettings({ zoom: 1.5 }, false)
      await new Promise((r) => setTimeout(r, 1200))
      // 1440px / 1.5 = 960px: the file tree must have left the side (it opens as a dialog there).
      const zoom = { base, zoomed: window.innerWidth, treePane: !!document.querySelector('.FileTreePane') }
      s.applySettings({ zoom: saved }, false)
      await new Promise((r) => setTimeout(r, 600))
      const report = {
        ok:
          !s.error &&
          !!s.snapshot &&
          document.querySelectorAll('.pl-k, .pl-c, .pl-s, .pl-en').length > 0 &&
          Math.abs(zoom.zoomed - base / 1.5) < 2 &&
          (base / 1.5 >= 1076 || !zoom.treePane) &&
          Math.abs(window.innerWidth - base / saved) < 2,
        zoom,
        error: s.error,
        files: s.snapshot?.files.length ?? 0,
        rows: document.querySelectorAll('.DiffTable tr').length,
        highlighted: document.querySelectorAll('.pl-k, .pl-c, .pl-s, .pl-en').length,
        checks: s.checks.map((c) => c.name),
        title: document.title,
      }
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('selftest_done', { report })
    }, 4000)
  })
