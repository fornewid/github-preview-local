import { Component, useMemo, type ReactNode } from 'react'
import { useStore } from './store'
import { AppHeader, PrHeader, TabNav } from './components/Header'
import { FilesToolbar } from './components/Toolbar'
import { FileTree } from './components/FileTree'
import { FileList } from './components/FileView'
import { ChecksTab, CommitsTab, ConversationTab } from './components/Tabs'
import { copyText } from './components/common'
import { extOf, viewedKey } from './diff/util'

/** Keeps a rendering error in one part of the page from blanking the window. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="flash flash-error" style={{ margin: 16 }}>
        <div>
          <strong>Something went wrong while rendering this view.</strong>
          <pre style={{ whiteSpace: 'pre-wrap', margin: '8px 0' }}>{String(this.state.error.stack ?? this.state.error)}</pre>
          <button type="button" className="btn btn-sm" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
        </div>
      </div>
    )
  }
}

export function App() {
  const loading = useStore((st) => st.loading)
  const error = useStore((st) => st.error)
  const snapshot = useStore((st) => st.snapshot)
  const tab = useStore((st) => st.tab)
  if (error)
    return (
      <div className="page">
        <div className="flash flash-error">{error}</div>
      </div>
    )
  if (!snapshot) return <div className="loading-page">Loading…</div>
  return (
    <>
      <AppHeader />
      <div className="page">
        <PrHeader />
        <TabNav />
        {loading && <div className="flash">Loading changes…</div>}
        {snapshot.warnings.length > 0 && tab === 'files' && (
          <div className="flash flash-warn" style={{ marginBottom: 16 }}>
            {snapshot.warnings.join(' ')}
          </div>
        )}
        <ErrorBoundary key={tab}>
          {tab === 'files' && <FilesTab />}
          {tab === 'commits' && <CommitsTab />}
          {tab === 'checks' && <ChecksTab />}
          {tab === 'conversation' && <ConversationTab />}
        </ErrorBoundary>
      </div>
      <SubmittedDialog />
    </>
  )
}

function FilesTab() {
  const files = useStore((st) => st.snapshot!.files)
  const filter = useStore((st) => st.filter)
  const viewed = useStore((st) => st.viewed)
  const treeVisible = useStore((st) => st.settings.treeVisible)
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
      <FilesToolbar />
      <div className={`Layout ${treeVisible ? '' : 'no-sidebar'}`}>
        {treeVisible && (
          <div className="Layout-sidebar">
            <FileTree files={shown} />
          </div>
        )}
        <div className="Layout-main">
          <FileList files={shown} />
        </div>
      </div>
    </>
  )
}

function SubmittedDialog() {
  const submitted = useStore((st) => st.submitted)
  const kind = useStore((st) => st.transport?.kind)
  if (!submitted || kind === 'native') return null
  return (
    <div className="overlay-backdrop">
      <div className="overlay-dialog" role="dialog" aria-modal>
        <header>Review ready — copy it to your AI agent</header>
        <div className="body">
          <pre>{submitted.markdown}</pre>
        </div>
        <footer>
          <button type="button" className="btn" onClick={() => useStore.setState({ submitted: null })}>
            Close
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void copyText(submitted.markdown)}>
            Copy to clipboard
          </button>
        </footer>
      </div>
    </div>
  )
}
