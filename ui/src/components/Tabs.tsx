import { useMemo, useState } from 'react'
import {
  CheckCircleFillIcon,
  CircleIcon,
  CommentIcon,
  DotFillIcon,
  EllipsisIcon,
  GitCommitIcon,
  GitPullRequestIcon,
  KebabHorizontalIcon,
  PlayIcon,
  StopIcon,
  SyncIcon,
  XCircleFillIcon,
} from '@primer/octicons-react'
import { ActionList, ActionMenu, Button, IconButton } from '@primer/react'
import { canConfirm, useOpenPr, useStore } from '../store'
import { connected } from '../transport'
import { Avatar, CopyButton, copyText } from './common'
import { ChecksStatusBadge, ConflictsBadge, conflictsText, confirmLabel, useChecksSummary } from './PageHeader'
import { commitLine } from './changes/Toolbar'
import { commitAuthors, longDate, plural } from '../diff/util'
import type { CheckState, CheckStatus, Commit } from '../types'

export function CheckStatusIcon({ status }: { status: CheckStatus }) {
  switch (status) {
    case 'success':
      return <CheckCircleFillIcon size={16} fill="var(--fgColor-success)" />
    case 'failure':
      return <XCircleFillIcon size={16} fill="var(--fgColor-danger)" />
    case 'running':
      return <SyncIcon size={16} className="anim-rotate" fill="var(--fgColor-attention)" />
    case 'queued':
      return <DotFillIcon size={16} fill="var(--fgColor-attention)" />
    case 'cancelled':
      return <StopIcon size={16} fill="var(--fgColor-muted)" />
    default:
      return <CircleIcon size={16} fill="var(--fgColor-muted)" />
  }
}

export function ConversationTab() {
  const s = useStore((st) => st.snapshot)!
  const drafts = useStore((st) => st.drafts)
  const setTab = useStore((st) => st.setTab)
  const openReview = useStore((st) => st.openReview)
  const transport = useStore((st) => st.transport)
  const range = useStore((st) => st.range)
  const pr = useOpenPr()
  const confirmable = canConfirm({ transport, range })
  const checks = useChecksSummary()
  const conflicts = conflictsText(s.conflicts, (files) => files.slice(0, 5).join(', '))
  return (
    <div className="Conversation">
      <div className="Conversation-timeline">
        <div className="TimelineItem">
          <div className="TimelineItem-badge">
            <GitCommitIcon size={16} />
          </div>
          <div className="TimelineItem-body">
            <Avatar name={s.author} size={20} /> <strong>{s.author}</strong> added {plural(s.commits.length, 'commit')}
          </div>
        </div>
        {s.commits.map((c) => (
          <TimelineCommit key={c.sha} c={c} />
        ))}
        {drafts.length > 0 && (
          <div className="TimelineItem">
            <div className="TimelineItem-badge">
              <CommentIcon size={16} />
            </div>
            <div className="TimelineItem-body">
              {plural(drafts.length, 'pending review comment')} ·{' '}
              <a href="#files" onClick={(e) => (e.preventDefault(), setTab('files'))}>
                view in Files changed
              </a>
            </div>
          </div>
        )}
        <div className="MergeBox">
          <div className="MergeBox-icon">
            <GitPullRequestIcon size={24} />
          </div>
          <div className="MergeBox-box">
            <div className="MergeBox-row">
              <ChecksStatusBadge status={checks.status} />
              <div className="MergeBox-text">
                <h3>
                  {checks.status === 'none'
                    ? 'No local checks configured'
                    : checks.status === 'failure'
                      ? `${plural(checks.failed, 'check')} failed`
                      : checks.status === 'success'
                        ? 'All checks have passed'
                        : 'Some checks haven’t completed yet'}
                </h3>
                <div className="MergeBox-sub">
                  {checks.total
                    ? `${checks.passed} successful, ${checks.failed} failing, ${checks.total - checks.passed - checks.failed} not run`
                    : 'Add a .gh-prv-local.toml to define checks.'}
                </div>
              </div>
              <Button size="small" onClick={() => setTab('checks')}>
                Show checks
              </Button>
            </div>
            <div className="MergeBox-row">
              <ConflictsBadge conflicts={s.conflicts} />
              <div className="MergeBox-text">
                <h3>{conflicts.title}</h3>
                <div className="MergeBox-sub">{conflicts.sub}</div>
              </div>
            </div>
            <div className="MergeBox-row MergeBox-actions">
              <Button
                variant="primary"
                disabled={!confirmable}
                onClick={() => {
                  setTab('files')
                  openReview('CONFIRM')
                }}
              >
                {confirmLabel(pr)}
              </Button>
            </div>
          </div>
        </div>
      </div>
      <aside className="Conversation-sidebar">
        <div className="SidebarItem">
          <h3>Base</h3>
          <div>
            <span className="BranchRef">{s.base.name}</span> <code>{s.base.sha.slice(0, 7)}</code>
          </div>
        </div>
        <div className="SidebarItem">
          <h3>Compare</h3>
          <div>
            <span className="BranchRef">{s.head.name}</span> <code>{s.head.sha.slice(0, 7)}</code>
          </div>
        </div>
        <div className="SidebarItem">
          <h3>Merge base</h3>
          <code>{s.mergeBase.slice(0, 7)}</code>
        </div>
        <div className="SidebarItem">
          <h3>Reviewers</h3>
          <div>{drafts.length ? plural(drafts.length, 'pending comment') : 'No reviews'}</div>
        </div>
      </aside>
    </div>
  )
}

function CommitAvatars({ c }: { c: Commit }) {
  const names = commitAuthors(c).slice(0, 3)
  return (
    <span className="CommitAvatars" aria-hidden>
      {names.map((n, i) => (
        <span key={i} className="CommitAvatars-item" style={{ zIndex: 3 - i }}>
          <Avatar name={n} size={20} />
        </span>
      ))}
    </span>
  )
}

/**
 * Opens Files changed for one commit, as github.com's commit links do; null in an export, which has
 * only the diff of all commits.
 */
function useCommitLink(sha: string) {
  const live = useStore((st) => connected(st.transport))
  const openCommit = useStore((st) => st.openCommit)
  if (!live) return null
  return {
    href: '#files',
    onClick: (e: React.MouseEvent) => {
      e.preventDefault()
      openCommit(sha)
    },
  }
}

/** A commit in the conversation timeline: github.com shows the message as muted code. */
function TimelineCommit({ c }: { c: Commit }) {
  const [open, setOpen] = useState(false)
  const link = useCommitLink(c.sha)
  return (
    <div className="TimelineItem TimelineItem--condensed">
      <div className="TimelineItem-badge">
        <GitCommitIcon size={16} />
      </div>
      <div className="TimelineItem-body TimelineItem-commit">
        <div className="TimelineItem-commitLine">
          <CommitAvatars c={c} />
          <span className="TimelineItem-commitMessage">
            <code className="TimelineItem-commitTitle">
              {link ? (
                <a {...link} className="Link--secondary">
                  {c.subject}
                </a>
              ) : (
                c.subject
              )}
            </code>
            {c.body && (
              <button type="button" className="TimelineItem-expander" aria-expanded={open} aria-label="Show description" onClick={() => setOpen(!open)}>
                …
              </button>
            )}
          </span>
          <code className="TimelineItem-sha">
            {link ? (
              <a {...link} className="Link--secondary">
                {c.short}
              </a>
            ) : (
              c.short
            )}
          </code>
        </div>
        {open && <pre className="TimelineItem-commitBody">{c.body}</pre>}
      </div>
    </div>
  )
}

function CommitRow({ c }: { c: Commit }) {
  const [open, setOpen] = useState(false)
  const link = useCommitLink(c.sha)
  return (
    <li className="CommitRow">
      <div className="CommitRow-main">
        <div className="CommitRow-titleLine">
          {link ? (
            <a {...link} className="CommitRow-title">
              {c.subject}
            </a>
          ) : (
            <span className="CommitRow-title">{c.subject}</span>
          )}
          {c.body && (
            <IconButton
              size="small"
              variant="invisible"
              className="CommitRow-ellipsis"
              icon={EllipsisIcon}
              aria-expanded={open}
              aria-label="Show description"
              onClick={() => setOpen(!open)}
            />
          )}
        </div>
        <div className="CommitRow-meta">
          <CommitAvatars c={c} />
          <span>{commitLine(c)}</span>
        </div>
        {open && <pre className="CommitRow-body">{c.body}</pre>}
      </div>
      <div className="CommitRow-actions">
        {link ? (
          <Button as="a" {...link} size="small" variant="invisible" className="CommitRow-sha">
            {c.short}
          </Button>
        ) : (
          <code className="CommitRow-sha">{c.short}</code>
        )}
        <CopyButton text={c.sha} label="Copy full SHA" />
      </div>
      {/* Under 544px github.com folds the SHA and its buttons into a menu. */}
      <div className="CommitRow-menu">
        <ActionMenu>
          <ActionMenu.Anchor>
            <IconButton variant="invisible" icon={KebabHorizontalIcon} aria-label="Commit actions" />
          </ActionMenu.Anchor>
          <ActionMenu.Overlay align="end">
            <ActionList>
              <ActionList.Item onSelect={() => void copyText(c.sha)}>Copy full SHA for {c.short}</ActionList.Item>
            </ActionList>
          </ActionMenu.Overlay>
        </ActionMenu>
      </div>
    </li>
  )
}

export function CommitsTab() {
  const s = useStore((st) => st.snapshot)!
  // Oldest first; consecutive commits with the same committer date share a group (like github.com).
  const groups = useMemo(() => {
    const out: Array<[string, Commit[]]> = []
    for (const c of s.commits) {
      const k = longDate(c.committerDate || c.date)
      const last = out[out.length - 1]
      if (last && last[0] === k) last[1].push(c)
      else out.push([k, [c]])
    }
    return out
  }, [s.commits])
  if (!s.commits.length)
    return (
      <div className="Blankslate-box">
        <h3>No commits</h3>
        <p>The head branch has no commits ahead of the base branch.</p>
      </div>
    )
  return (
    <div className="Commits">
      {groups.map(([date, commits]) => (
        <div key={`${date}-${commits[0].sha}`} className="Commits-group">
          <div className="Commits-groupTitle">
            <GitCommitIcon size={16} /> Commits on {date}
          </div>
          <ul className="Commits-list">
            {commits.map((c) => (
              <CommitRow key={c.sha} c={c} />
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}

export function ChecksTab() {
  const checks = useStore((st) => st.checks)
  const checksError = useStore((st) => st.checksError)
  const native = useStore((st) => connected(st.transport))
  const s = useStore((st) => st.snapshot)!
  const summary = useChecksSummary()
  const { runCheck, runAllChecks, cancelCheck } = useStore.getState()
  const [selected, setSelected] = useState<string | null>(null)
  const last = s.commits[s.commits.length - 1]
  if (!native)
    return (
      <div className="Blankslate-box">
        <h3>Local checks run from gh-prv-local</h3>
        <p>
          Open this preview with <code>gh-prv-local</code> to run checks.
        </p>
      </div>
    )
  if (checksError)
    return (
      <div className="Blankslate-box">
        <h3>Could not read the checks configuration</h3>
        <pre className="Blankslate-pre">{checksError}</pre>
      </div>
    )
  if (!checks.length)
    return (
      <div className="Blankslate-box">
        <h3>No checks found</h3>
        <p>
          Add <code>.gh-prv-local.toml</code> to the repository root, for example:
        </p>
        <p className="Blankslate-note">Checks run commands from this repository on your machine — only run them in repositories you trust.</p>
        <pre className="Blankslate-pre">{'[[checks]]\nname = "lint"\nrun = "npm run lint"\n\n[[checks]]\nname = "test"\nrun = "./gradlew test"'}</pre>
      </div>
    )
  const cur: CheckState | undefined = checks.find((c) => c.name === selected)
  const { running } = summary
  return (
    <div className="Checks">
      <div className="Checks-header">
        <span className="Checks-headerIcon">
          <ChecksStatusBadge status={summary.status} />
        </span>
        <span className="Checks-headerTitle">{last?.subject ?? s.head.name}</span>
        <code className="Checks-headerSha">{s.head.sha.slice(0, 7)}</code>
        <span className="Checks-headerSpacer" />
        <Button size="small" leadingVisual={PlayIcon} disabled={running} onClick={() => void runAllChecks()}>
          Run all
        </Button>
      </div>
      <div className="Checks-layout">
        <ul className="Checks-sidebar">
          {checks.map((c) => (
            <li key={c.name}>
              <button type="button" className={`Checks-item ${cur?.name === c.name ? 'selected' : ''}`} onClick={() => setSelected(c.name)}>
                <CheckStatusIcon status={c.status} />
                <span className="Checks-itemText">
                  <span className="Checks-itemName">{c.name}</span>
                  <span className="Checks-itemSource">on: {c.source}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
        <div className="Checks-main">
          {!cur ? (
            <div className="Checks-placeholder">Select a check to view from the sidebar</div>
          ) : (
            <div className="CheckRun">
              <div className="CheckRun-header">
                <CheckStatusIcon status={cur.status} />
                <div className="CheckRun-titles">
                  <h2>{cur.name}</h2>
                  <div className="CheckRun-command">$ {cur.run}</div>
                </div>
                {cur.status === 'running' || cur.status === 'queued' ? (
                  <Button size="small" onClick={() => void cancelCheck(cur.name)}>
                    Cancel
                  </Button>
                ) : (
                  <Button size="small" disabled={running} onClick={() => void runCheck(cur.name)}>
                    {cur.status === 'idle' ? 'Run' : 'Re-run'}
                  </Button>
                )}
              </div>
              <pre className="CheckRun-log">
                {cur.output || (cur.status === 'idle' ? 'This check has not run yet.' : '')}
                {cur.status === 'success' || cur.status === 'failure' ? `\n\nProcess exited with code ${cur.exitCode ?? '(killed)'}` : ''}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
