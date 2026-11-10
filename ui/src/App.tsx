import { Component, useEffect, useMemo, type ReactNode } from 'react'
import { Button, Flash, PageLayout, ThemeProvider } from '@primer/react'
import { useStore } from './store'
import { AppHeader, PullHeader } from './components/PageHeader'
import { ChangesToolbar, useShortcuts } from './components/changes/Toolbar'
import { FileTreeDialog, FileTreePane } from './components/changes/FileTreePane'
import { DiffList } from './components/changes/DiffEntry'
import { SidePanel } from './components/changes/SidePanel'
import { ChecksTab, CommitsTab, ConversationTab } from './components/Tabs'
import { copyText } from './components/common'
import { extOf, viewedKey } from './diff/util'
import { MEDIA, nextZoom, useMediaQuery } from './layout'

/** Keeps a rendering error in one part of the page from blanking the window. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <Flash variant="danger" style={{ margin: 16 }}>
        <strong>Something went wrong while rendering this view.</strong>
        <pre style={{ whiteSpace: 'pre-wrap', margin: '8px 0' }}>{String(this.state.error.stack ?? this.state.error)}</pre>
        <Button size="small" onClick={() => this.setState({ error: null })}>
          Try again
        </Button>
      </Flash>
    )
  }
}

function colorMode(): 'auto' | 'day' | 'night' {
  const m = document.documentElement.dataset.colorMode
  return m === 'light' ? 'day' : m === 'dark' ? 'night' : 'auto'
}

export function App() {
  const error = useStore((st) => st.error)
  const snapshot = useStore((st) => st.snapshot)
  return (
    <ThemeProvider
      colorMode={colorMode()}
      dayScheme={document.documentElement.dataset.lightTheme ?? 'light'}
      nightScheme={document.documentElement.dataset.darkTheme ?? 'dark'}
      preventSSRMismatch
    >
      <div className="App">
        {error ? (
          <div className="App-error">
            <Flash variant="danger">{error}</Flash>
          </div>
        ) : !snapshot ? (
          <div className="App-loading">Loading…</div>
        ) : (
          <Page />
        )}
        <SubmittedDialog />
      </div>
    </ThemeProvider>
  )
}

function Page() {
  const tab = useStore((st) => st.tab)
  const panel = useStore((st) => st.panel)
  const loading = useStore((st) => st.loading)
  const warnings = useStore((st) => st.snapshot!.warnings)
  const docked = useMediaQuery(MEDIA.dockedPanel)
  useShortcuts()
  useZoom()
  const centered = tab === 'conversation' || tab === 'commits'
  const showPanel = !!panel && tab === 'files'
  return (
    <>
      <AppHeader />
      <div className={`App-body ${showPanel && docked ? 'has-panel' : ''}`}>
        <div className={`App-main ${centered ? 'App-main--centered' : ''}`}>
          <PageLayout
            containerWidth="full"
            padding="none"
            rowGap="none"
            columnGap="none"
            className={`PullPage PullPage--${tab}`}
          >
            <PageLayout.Header>
              <PullHeader />
            </PageLayout.Header>
            {tab === 'files' ? (
              <FilesTab loading={loading} warnings={warnings} />
            ) : (
              <PageLayout.Content as="div" padding="none" className="PullPage-content">
                <ErrorBoundary key={tab}>
                  {tab === 'commits' && <CommitsTab />}
                  {tab === 'checks' && <ChecksTab />}
                  {tab === 'conversation' && <ConversationTab />}
                </ErrorBoundary>
              </PageLayout.Content>
            )}
          </PageLayout>
        </div>
        {showPanel && <SidePanel docked={docked} />}
      </div>
    </>
  )
}

function FilesTab({ loading, warnings }: { loading: boolean; warnings: string[] }) {
  const files = useStore((st) => st.snapshot!.files)
  const filter = useStore((st) => st.filter)
  const viewed = useStore((st) => st.viewed)
  const treeVisible = useStore((st) => st.settings.treeVisible)
  const treeDialog = useStore((st) => st.treeDialog)
  // Wide enough: the tree sits beside the diffs (if shown); otherwise it opens as a dialog.
  const treePane = useMediaQuery(MEDIA.treePane)
  useEffect(() => {
    if (treePane && treeDialog) useStore.getState().setTreeDialog(false)
  }, [treePane, treeDialog])
  const shown = useMemo(
    () =>
      files.filter((f) => {
        if (filter.exts && !filter.exts.includes(extOf(f.path) || 'No extension')) return false
        if (!filter.showViewed && viewed[f.path] === viewedKey(f)) return false
        if (!filter.showDeleted && f.status === 'deleted') return false
        return true
      }),
    [files, filter.exts, filter.showViewed, filter.showDeleted, viewed],
  )
  return (
    <>
      <div className="ChangesToolbar-wrapper">
        <ChangesToolbar />
      </div>
      {!treePane && treeDialog && <FileTreeDialog files={shown} all={files} />}
      {treePane && treeVisible && (
        <PageLayout.Pane
          position="start"
          aria-label="File tree"
          resizable
          widthStorageKey="prv:file-tree-width"
          width={{ min: '240px', default: '296px', max: '600px' }}
          sticky
          offsetHeader={60}
          divider="line"
          padding="none"
          className="FileTreePane"
        >
          <FileTreePane files={shown} all={files} />
        </PageLayout.Pane>
      )}
      <PageLayout.Content as="div" padding="none" className="ChangesContent">
        {loading && <Flash className="ChangesContent-flash">Loading changes…</Flash>}
        {warnings.length > 0 && (
          <Flash variant="warning" className="ChangesContent-flash">
            {warnings.join(' ')}
          </Flash>
        )}
        <ErrorBoundary>
          <DiffList files={shown} />
        </ErrorBoundary>
      </PageLayout.Content>
    </>
  )
}

/** Native window: Cmd/Ctrl + `=` / `-` / `0` zoom like a browser, and the level is kept. */
function useZoom() {
  const transport = useStore((st) => st.transport)
  const zoom = useStore((st) => st.settings.zoom)
  const native = transport?.kind === 'native'
  useEffect(() => {
    if (transport?.kind !== 'native') return
    transport
      .setZoom(zoom || 1)
      // The CSS width changed: let width-dependent parts re-check (WebKit sends no event for zoom).
      .then(() => setTimeout(() => window.dispatchEvent(new Event('resize')), 50))
      .catch(() => {})
  }, [transport, zoom])
  useEffect(() => {
    if (!native) return
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return
      const cur = useStore.getState().settings.zoom || 1
      let next: number | null = null
      if (e.code === 'Equal' || e.code === 'NumpadAdd' || e.key === '+' || e.key === '=') next = nextZoom(cur, 1)
      else if (e.code === 'Minus' || e.code === 'NumpadSubtract' || e.key === '-') next = nextZoom(cur, -1)
      else if (e.code === 'Digit0' || e.code === 'Numpad0') next = 1
      if (next === null) return
      e.preventDefault()
      useStore.getState().applySettings({ zoom: next })
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [native])
}

function SubmittedDialog() {
  const submitted = useStore((st) => st.submitted)
  const kind = useStore((st) => st.transport?.kind)
  if (!submitted || kind === 'native') return null
  return (
    <div className="SubmittedDialog-backdrop">
      <div className="SubmittedDialog" role="dialog" aria-modal aria-labelledby="submitted-title">
        <header id="submitted-title">Review ready — copy it to your AI agent</header>
        <div className="SubmittedDialog-body">
          <pre>{submitted.markdown}</pre>
        </div>
        <footer>
          <Button onClick={() => useStore.setState({ submitted: null })}>Close</Button>
          <Button variant="primary" onClick={() => void copyText(submitted.markdown)}>
            Copy to clipboard
          </Button>
        </footer>
      </div>
    </div>
  )
}
