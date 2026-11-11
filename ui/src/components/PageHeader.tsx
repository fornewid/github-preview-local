import { useState } from 'react'
import {
  AlertIcon,
  CheckCircleIcon,
  ChecklistIcon,
  CommentDiscussionIcon,
  DotFillIcon,
  FileDiffIcon,
  GitCommitIcon,
  GitMergeIcon,
  PencilIcon,
  RepoIcon,
  XCircleIcon,
  CheckIcon,
  CircleIcon,
  XIcon,
  type Icon,
} from '@primer/octicons-react'
import { BranchName, Button, CounterLabel, Heading, IconButton, Label, StateLabel, TextInput } from '@primer/react'
import { PageHeader } from '@primer/react/experimental'
import { useShallow } from 'zustand/react/shallow'
import { useStore, type Tab } from '../store'
import { CopyButton, DiffSquares } from './common'
import { plural } from '../diff/util'
import { useVisiblePanel } from '../layout'
import type { ExistingPr } from '../types'

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

export type ChecksSummary = {
  status: 'none' | 'success' | 'failure' | 'pending' | 'idle'
  passed: number
  failed: number
  /** Not run yet. */
  idle: number
  /** Running or queued. */
  running: boolean
  total: number
}

/** Counts only: a chunk of check output does not re-render the header or the tabs. */
export function useChecksSummary(): ChecksSummary {
  const counts = useStore(
    useShallow((st) => {
      let passed = 0
      let failed = 0
      let idle = 0
      let running = false
      for (const c of st.checks) {
        if (c.status === 'success') passed++
        else if (c.status === 'failure') failed++
        else if (c.status === 'idle') idle++
        else if (c.status === 'running' || c.status === 'queued') running = true
      }
      return { passed, failed, idle, running, total: st.checks.length }
    }),
  )
  const { passed, failed, running, total } = counts
  const status = !total ? 'none' : failed ? 'failure' : running ? 'pending' : passed === total ? 'success' : 'idle'
  return { ...counts, status }
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

/** github.com's 32px status circle: the checks page header and the merge box sections. */
export function StatusBadge({ tone, icon: Glyph }: { tone: 'success' | 'danger' | 'attention' | 'neutral'; icon: Icon }) {
  return (
    <span className={`StatusBadge StatusBadge--${tone}`}>
      <Glyph size={16} />
    </span>
  )
}

export function ChecksStatusBadge({ status }: { status: ChecksSummary['status'] }) {
  switch (status) {
    case 'success':
      return <StatusBadge tone="success" icon={CheckIcon} />
    case 'failure':
      return <StatusBadge tone="danger" icon={XIcon} />
    case 'pending':
      return <StatusBadge tone="attention" icon={DotFillIcon} />
    case 'idle':
      return <StatusBadge tone="neutral" icon={DotFillIcon} />
    default:
      return <StatusBadge tone="neutral" icon={GitMergeIcon} />
  }
}

/** The merge box's conflicts section: unknown (no merge base check), conflicting or clean. */
export function ConflictsBadge({ conflicts }: { conflicts: string[] | null | undefined }) {
  if (conflicts == null) return <StatusBadge tone="neutral" icon={AlertIcon} />
  return conflicts.length ? <StatusBadge tone="attention" icon={AlertIcon} /> : <StatusBadge tone="success" icon={CheckIcon} />
}

/** Title and detail line of the conflicts section; `files` words the list of conflicting files. */
export function conflictsText(conflicts: string[] | null | undefined, files: (conflicts: string[]) => string) {
  if (conflicts == null) return { title: 'Merge status unknown', sub: 'Conflicts could not be checked for this view.' }
  if (conflicts.length) return { title: 'This branch has conflicts that must be resolved', sub: files(conflicts) }
  return { title: 'No conflicts with base branch', sub: 'Merging can be performed automatically.' }
}

/** The merge box's Confirm button. */
export function confirmLabel(pr: ExistingPr | null) {
  return pr ? `Confirm and push to #${pr.number}` : 'Confirm and create pull request'
}

/** Why Confirm cannot push: the first line of the failed pull request lookup. */
export function publishBlocked(error: string) {
  return `Publishing is blocked: ${error.split('\n')[0]}`
}

/** Title, merge-status action, state line and tabs (Primer PageHeader, as on github.com). */
export function PullHeader() {
  const s = useStore((st) => st.snapshot)!
  const prTitle = useStore((st) => st.prTitle)
  const setPr = useStore((st) => st.setPr)
  const panel = useVisiblePanel()
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
          <span className="PullHeader-mergeLong">Merge status</span>
          <span className="PullHeader-mergeShort">Status</span>
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
              <CopyButton text={s.head.name} label="Copy head branch name to clipboard" copiedLabel={null} stopPropagation={false} />
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
