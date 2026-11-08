import { useState } from 'react'
import {
  ChecklistIcon,
  CommentDiscussionIcon,
  FileDiffIcon,
  GitCommitIcon,
  GitPullRequestIcon,
  RepoIcon,
} from '@primer/octicons-react'
import { useStore, type Tab } from '../store'
import { CopyButton, DiffStatBlocks } from './common'
import { plural } from '../diff/util'

export function AppHeader() {
  const s = useStore((st) => st.snapshot)!
  const kind = useStore((st) => st.transport?.kind)
  return (
    <header className="AppHeader">
      <RepoIcon size={16} className="color-fg-muted" />
      <nav className="AppHeader-context" aria-label="Repository">
        {s.repo.owner && (
          <>
            <a href="#top">{s.repo.owner}</a>
            <span className="sep">/</span>
          </>
        )}
        <a href="#top">
          <strong>{s.repo.name}</strong>
        </a>
      </nav>
      <span className="Label Label--secondary AppHeader-badge">Local preview</span>
      <div className="AppHeader-right">
        {s.repo.host && <span>{s.repo.host}</span>}
        <span title={s.repo.root}>{kind === 'static' ? 'Static export' : s.mode === 'worktree' ? 'Working tree' : 'Committed changes'}</span>
      </div>
    </header>
  )
}

export function StateLabel({ compact }: { compact?: boolean }) {
  const pr = useStore((st) => st.snapshot?.existingPr)
  return (
    <span className={`State State--open ${compact ? 'State--small' : ''}`} title={pr ? 'Status: Open' : 'Status: Local preview'}>
      <GitPullRequestIcon size={16} />
      {pr ? 'Open' : 'Preview'}
    </span>
  )
}

export function PrHeader() {
  const s = useStore((st) => st.snapshot)!
  const prTitle = useStore((st) => st.prTitle)
  const setPr = useStore((st) => st.setPr)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(prTitle)
  const commits = s.commits.length
  return (
    <div className="gh-header" id="top">
      <div className="gh-header-show">
        {editing ? (
          <form
            className="gh-header-title"
            style={{ display: 'flex', gap: 8 }}
            onSubmit={(e) => {
              e.preventDefault()
              setPr(draft.trim() || s.title, null)
              setEditing(false)
            }}
          >
            <input className="form-control" value={draft} autoFocus onChange={(e) => setDraft(e.target.value)} />
            <button className="btn" type="submit">
              Save
            </button>
            <button className="btn btn-invisible" type="button" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </form>
        ) : (
          <h1 className="gh-header-title">
            <bdi>{prTitle}</bdi>
            {s.existingPr && <span className="gh-header-number"> #{s.existingPr.number}</span>}
          </h1>
        )}
        {!editing && (
          <div className="gh-header-actions">
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                setDraft(prTitle)
                setEditing(true)
              }}
            >
              Edit
            </button>
          </div>
        )}
      </div>
      <div className="gh-header-meta">
        <StateLabel />
        <div style={{ flex: 'auto', minWidth: 0 }}>
          <span className="author">{s.author}</span> wants to merge {plural(commits, 'commit')} into{' '}
          <span className="commit-ref" title={s.base.ref}>
            {s.base.name}
          </span>{' '}
          from{' '}
          <span className="commit-ref" title={s.head.ref}>
            {s.head.name}
          </span>
          <CopyButton text={s.head.name} label="Copy head branch name to clipboard" />
        </div>
      </div>
    </div>
  )
}

export function TabNav() {
  const s = useStore((st) => st.snapshot)!
  const tab = useStore((st) => st.tab)
  const setTab = useStore((st) => st.setTab)
  const drafts = useStore((st) => st.drafts.length)
  const checks = useStore((st) => st.checks.length)
  const hideWs = useStore((st) => st.settings.hideWhitespace)
  const add = s.files.reduce((a, f) => a + (hideWs ? f.additionsW : f.additions), 0)
  const del = s.files.reduce((a, f) => a + (hideWs ? f.deletionsW : f.deletions), 0)
  const items: Array<[Tab, string, typeof FileDiffIcon, number]> = [
    ['conversation', 'Conversation', CommentDiscussionIcon, drafts],
    ['commits', 'Commits', GitCommitIcon, s.commits.length],
    ['checks', 'Checks', ChecklistIcon, checks],
    ['files', 'Files changed', FileDiffIcon, s.files.length],
  ]
  return (
    <div className="tabnav">
      <nav className="tabnav-tabs" aria-label="Pull request tabs">
        {items.map(([key, label, Icon, count]) => (
          <button
            key={key}
            type="button"
            className={`tabnav-tab ${tab === key ? 'selected' : ''}`}
            aria-current={tab === key ? 'page' : undefined}
            onClick={() => setTab(key)}
          >
            <Icon size={16} />
            {label}
            <span className="Counter" title={String(count)}>
              {count}
            </span>
          </button>
        ))}
      </nav>
      <div className="tabnav-extra">
        <span className="diffstat" id="diffstat">
          <span className="additions">+{add.toLocaleString()}</span>{' '}
          <span className="deletions">−{del.toLocaleString()}</span> <DiffStatBlocks add={add} del={del} />
        </span>
      </div>
    </div>
  )
}
