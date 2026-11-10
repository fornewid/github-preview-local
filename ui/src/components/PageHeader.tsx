import { useState } from 'react'
import {
  CheckCircleIcon,
  ChecklistIcon,
  CommentDiscussionIcon,
  CopyIcon,
  DotFillIcon,
  FileDiffIcon,
  GitCommitIcon,
  GitMergeIcon,
  PencilIcon,
  RepoIcon,
  XCircleIcon,
  CheckIcon,
  CircleIcon,
} from '@primer/octicons-react'
import { BranchName, Button, CounterLabel, Heading, IconButton, Label, StateLabel, TextInput } from '@primer/react'
import { PageHeader } from '@primer/react/experimental'
import { useStore, type Tab } from '../store'
import { copyText, DiffSquares } from './common'
import { plural } from '../diff/util'

/** Repository context bar (GitHub's global header without the site navigation). */
export function AppHeader() {
  const s = useStore((st) => st.snapshot)!
  const kind = useStore((st) => st.transport?.kind)
  return (
    <header className="AppHeader">
      <div className="AppHeader-globalBar">
        <RepoIcon size={16} className="AppHeader-icon" />
        <nav className="AppHeader-context" aria-label="Repository">
          {s.repo.owner && (
            <>
              <span className="AppHeader-context-item">{s.repo.owner}</span>
              <span className="AppHeader-context-sep">/</span>
            </>
          )}
          <span className="AppHeader-context-item AppHeader-repo">{s.repo.name}</span>
        </nav>
        <Label variant="secondary" className="AppHeader-badge">
          Local preview
        </Label>
        <div className="AppHeader-right" title={s.repo.root}>
          {s.repo.host && <span>{s.repo.host}</span>}
          <span>{kind === 'static' ? 'Static export' : s.mode === 'worktree' ? 'Working tree' : 'Committed changes'}</span>
        </div>
      </div>
    </header>
  )
}

export type ChecksSummary = { status: 'none' | 'success' | 'failure' | 'pending' | 'idle'; passed: number; failed: number; total: number }

export function useChecksSummary(): ChecksSummary {
  const checks = useStore((st) => st.checks)
  const passed = checks.filter((c) => c.status === 'success').length
  const failed = checks.filter((c) => c.status === 'failure').length
  const running = checks.some((c) => c.status === 'running' || c.status === 'queued')
  const status = !checks.length ? 'none' : failed ? 'failure' : running ? 'pending' : passed === checks.length ? 'success' : 'idle'
  return { status, passed, failed, total: checks.length }
}

export function ChecksStatusIcon({ status, size = 16 }: { status: ChecksSummary['status']; size?: number }) {
  switch (status) {
    case 'success':
      return <CheckCircleIcon size={size} fill="var(--fgColor-success)" />
    case 'failure':
      return <XCircleIcon size={size} fill="var(--fgColor-danger)" />
    case 'pending':
      return <DotFillIcon size={size} fill="var(--fgColor-attention)" />
    case 'idle':
      return <CircleIcon size={size} fill="var(--fgColor-muted)" />
    default:
      return <GitMergeIcon size={size} fill="var(--fgColor-muted)" />
  }
}

function CopyBranchButton({ name }: { name: string }) {
  const [done, setDone] = useState(false)
  return (
    <IconButton
      size="small"
      variant="invisible"
      icon={done ? CheckIcon : CopyIcon}
      aria-label="Copy head branch name to clipboard"
      onClick={() =>
        void copyText(name).then(() => {
          setDone(true)
          setTimeout(() => setDone(false), 2000)
        })
      }
    />
  )
}

/** Title, merge-status action, state line and tabs (Primer PageHeader, as on github.com). */
export function PullHeader() {
  const s = useStore((st) => st.snapshot)!
  const prTitle = useStore((st) => st.prTitle)
  const setPr = useStore((st) => st.setPr)
  const panel = useStore((st) => st.panel)
  const setPanel = useStore((st) => st.setPanel)
  const tab = useStore((st) => st.tab)
  const setTab = useStore((st) => st.setTab)
  const checks = useChecksSummary()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(prTitle)
  const save = () => {
    setPr(draft.trim() || s.title, null)
    setEditing(false)
  }
  const mergeOpen = tab === 'files' && panel === 'merge'
  const openMerge = () => {
    if (tab !== 'files') setTab('files')
    setPanel(mergeOpen ? null : 'merge')
  }
  return (
    <PageHeader role="banner" aria-label="Pull request header" className="PullHeader">
      <PageHeader.TitleArea>
        {editing ? (
          <form
            className="PullHeader-edit"
            onSubmit={(e) => {
              e.preventDefault()
              save()
            }}
          >
            <TextInput aria-label="Title" value={draft} autoFocus block size="large" onChange={(e) => setDraft(e.target.value)} />
            <Button type="submit">Save</Button>
            <Button variant="invisible" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </form>
        ) : (
          <div className="PullHeader-titleWithAction">
            <Heading as="h1" className="PullHeader-title">
              <span className="PullHeader-titleText">{prTitle}</span>
            </Heading>
            <span className="PullHeader-titleSuffix">
              {s.existingPr && <span className="PullHeader-number">#{s.existingPr.number}</span>}
              <IconButton
                className="PullHeader-editButton"
                variant="invisible"
                icon={PencilIcon}
                aria-label="Edit title"
                onClick={() => {
                  setDraft(prTitle)
                  setEditing(true)
                }}
              />
            </span>
          </div>
        )}
      </PageHeader.TitleArea>
      <PageHeader.Actions className="PullHeader-actions">
        <Button
          className={`PullHeader-mergeStatus status-${checks.status}`}
          leadingVisual={() => <ChecksStatusIcon status={checks.status} />}
          aria-expanded={mergeOpen}
          onClick={openMerge}
        >
          Merge status
        </Button>
      </PageHeader.Actions>
      <PageHeader.Description className="PullHeader-description">
        <div className="PullHeader-meta">
          <StateLabel status="pullOpened" className="PullHeader-state">
            {s.existingPr ? 'Open' : 'Preview'}
          </StateLabel>
          <div className="PullHeader-summary">
            <span className="PullHeader-author">{s.author}</span>
            <span>wants to merge {plural(s.commits.length, 'commit')} into</span>
            <span className="PullHeader-branches">
              <BranchName as="span" title={s.base.ref}>
                {s.base.name}
              </BranchName>
              <span>from</span>
              <BranchName as="span" title={s.head.ref}>
                {s.head.name}
              </BranchName>
              <CopyBranchButton name={s.head.name} />
            </span>
          </div>
        </div>
      </PageHeader.Description>
      <PageHeader.Navigation className="PullHeader-navigation">
        <TabNav />
      </PageHeader.Navigation>
    </PageHeader>
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
    <div className="TabNav-wrapper">
      <nav className="TabNav" aria-label="Pull request navigation">
        <div className="TabNav-list">
          {items.map(([key, label, Icon, count]) => (
            <a
              key={key}
              href={`#${key}`}
              className={`TabNav-link ${tab === key ? 'selected' : ''}`}
              aria-current={tab === key ? 'page' : undefined}
              onClick={(e) => {
                e.preventDefault()
                setTab(key)
              }}
            >
              <Icon size={16} className="TabNav-icon" />
              {label}
              <CounterLabel className="TabNav-counter">{count}</CounterLabel>
            </a>
          ))}
        </div>
      </nav>
      <div className="TabNav-extra">
        <DiffStat add={add} del={del} />
      </div>
    </div>
  )
}

export function DiffStat({ add, del }: { add: number; del: number }) {
  return (
    <div className="DiffStat">
      <span className="DiffStat-add">+{add.toLocaleString()}</span>
      <span className="DiffStat-del">-{del.toLocaleString()}</span>
      <span className="sr-only">
        Lines changed: {add} additions &amp; {del} deletions
      </span>
      <DiffSquares add={add} del={del} />
    </div>
  )
}
