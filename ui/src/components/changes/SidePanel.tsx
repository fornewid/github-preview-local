import { useMemo, useState } from 'react'
import {
  AlertIcon,
  CheckCircleFillIcon,
  ChevronRightIcon,
  CommentDiscussionIcon,
  GitMergeIcon,
  InfoIcon,
  PencilIcon,
  TriangleDownIcon,
  XIcon,
} from '@primer/octicons-react'
import { ActionList, ActionMenu, Button, IconButton, SegmentedControl } from '@primer/react'
import { useStore, type Panel } from '../../store'
import { Avatar, Markdown } from '../common'
import { MarkdownEditor } from '../MarkdownEditor'
import { ChecksStatusIcon, useChecksSummary } from '../PageHeader'
import { anchorFor, plural } from '../../diff/util'

const PANELS: Array<[Panel, string, typeof InfoIcon]> = [
  ['comments', 'Comments', CommentDiscussionIcon],
  ['merge', 'Merge status', GitMergeIcon],
  ['overview', 'Overview', InfoIcon],
]

export function SidePanel() {
  const panel = useStore((st) => st.panel)
  const setPanel = useStore((st) => st.setPanel)
  const [editing, setEditing] = useState(false)
  if (!panel) return null
  const [, title, Icon] = PANELS.find(([k]) => k === panel)!
  return (
    <aside className="SidePanel" aria-label={title}>
      <div className="SidePanel-header">
        <ActionMenu>
          <ActionMenu.Anchor>
            <Button variant="invisible" leadingVisual={Icon} trailingVisual={TriangleDownIcon} className="SidePanel-switch">
              {title}
            </Button>
          </ActionMenu.Anchor>
          <ActionMenu.Overlay>
            <ActionList selectionVariant="single">
              {PANELS.map(([k, label, I]) => (
                <ActionList.Item key={k} selected={k === panel} onSelect={() => setPanel(k)}>
                  <ActionList.LeadingVisual>
                    <I />
                  </ActionList.LeadingVisual>
                  {label}
                </ActionList.Item>
              ))}
            </ActionList>
          </ActionMenu.Overlay>
        </ActionMenu>
        <div className="SidePanel-headerActions">
          {panel === 'overview' && !editing && (
            <IconButton variant="invisible" icon={PencilIcon} aria-label="Edit description" onClick={() => setEditing(true)} />
          )}
          <IconButton variant="invisible" icon={XIcon} aria-label={`Close ${title.toLowerCase()} panel`} onClick={() => setPanel(null)} />
        </div>
      </div>
      <div className="SidePanel-body">
        {panel === 'overview' && <OverviewPanel editing={editing} setEditing={setEditing} />}
        {panel === 'comments' && <CommentsPanel />}
        {panel === 'merge' && <MergePanel />}
      </div>
    </aside>
  )
}

function OverviewPanel({ editing, setEditing }: { editing: boolean; setEditing: (v: boolean) => void }) {
  const prBody = useStore((st) => st.prBody)
  const setPr = useStore((st) => st.setPr)
  const [body, setBody] = useState(prBody)
  if (editing)
    return (
      <div className="OverviewPanel-edit">
        <MarkdownEditor value={body} onChange={setBody} autoFocus rows={12} label="Pull request description" />
        <div className="InlineComment-footer">
          <Button
            onClick={() => {
              setBody(prBody)
              setEditing(false)
            }}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              setPr(null, body)
              setEditing(false)
            }}
          >
            Update description
          </Button>
        </div>
      </div>
    )
  return prBody.trim() ? (
    <Markdown source={prBody} className="OverviewPanel-body" />
  ) : (
    <div className="OverviewPanel-empty fgColor-muted">
      <em>No description provided.</em>
    </div>
  )
}

function CommentsPanel() {
  const drafts = useStore((st) => st.drafts)
  const author = useStore((st) => st.snapshot?.author ?? 'you')
  const [filter, setFilter] = useState(1)
  const shown = useMemo(() => drafts, [drafts])
  return (
    <div className="CommentsPanel">
      <div className="CommentsPanel-filters">
        <SegmentedControl aria-label="Filter comments" size="small" onChange={setFilter}>
          <SegmentedControl.Button selected={filter === 0}>All</SegmentedControl.Button>
          <SegmentedControl.Button selected={filter === 1}>Unresolved</SegmentedControl.Button>
          <SegmentedControl.Button selected={filter === 2}>Mine</SegmentedControl.Button>
        </SegmentedControl>
      </div>
      {shown.length === 0 ? (
        <div className="CommentsPanel-empty">
          <CommentDiscussionIcon size={24} />
          <h3>No review comments yet</h3>
          <p>Click + on a line to add a comment for your AI agent.</p>
        </div>
      ) : (
        <ul className="CommentsPanel-list">
          {shown.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                className="CommentsPanel-item"
                onClick={() => {
                  useStore.getState().setTab('files')
                  useStore.getState().toggleCollapsed(c.path, false)
                  requestAnimationFrame(() => {
                    const el = document.getElementById(`comment-${c.id}`) ?? document.getElementById(anchorFor(c.path))
                    el?.scrollIntoView({ block: 'center' })
                  })
                }}
              >
                <span className="CommentsPanel-path">
                  {c.path}
                  {c.line > 0 && <span className="fgColor-muted"> {c.side === 'LEFT' ? 'L' : 'R'}{c.line}</span>}
                </span>
                <span className="CommentsPanel-meta">
                  <Avatar name={author} size={16} />
                  <strong>{author}</strong>
                  <span className="Label Label--attention">Pending</span>
                </span>
                <span className="CommentsPanel-body">{c.body.split('\n')[0]}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function MergePanel() {
  const s = useStore((st) => st.snapshot)!
  const transport = useStore((st) => st.transport)!
  const checks = useStore((st) => st.checks)
  const runAll = useStore((st) => st.runAllChecks)
  const setTab = useStore((st) => st.setTab)
  const openReview = useStore((st) => st.openReview)
  const summary = useChecksSummary()
  const running = checks.some((c) => c.status === 'running' || c.status === 'queued')
  const idle = checks.filter((c) => c.status === 'idle').length
  const title =
    summary.status === 'none'
      ? transport.capabilities.checks
        ? 'No local checks configured'
        : 'Local checks run in the native window'
      : summary.status === 'success'
        ? 'All checks have passed'
        : summary.status === 'failure'
          ? 'Some checks were not successful'
          : summary.status === 'pending'
            ? 'Some checks haven’t completed yet'
            : 'Checks haven’t run yet'
  const parts = [
    summary.failed && `${summary.failed} failing`,
    summary.passed && `${summary.passed} successful`,
    idle && `${idle} not run`,
  ].filter(Boolean)
  const sub = summary.total
    ? `${parts.join(', ')} ${summary.total === 1 ? 'check' : 'checks'}`
    : transport.capabilities.checks
      ? 'Add a .prv.toml to define checks.'
      : 'Open this preview with prv to run them.'
  const conflicts = s.conflicts
  const pr = s.existingPr
  return (
    <div className="MergePanel">
      <button type="button" className="MergePanel-row MergePanel-row--link" onClick={() => setTab('checks')}>
        <span className="MergePanel-icon">
          <ChecksStatusIcon status={summary.status} size={24} />
        </span>
        <span className="MergePanel-text">
          <span className="MergePanel-title">{title}</span>
          <span className="MergePanel-sub">{sub}</span>
        </span>
        <ChevronRightIcon size={16} className="MergePanel-chevron" />
      </button>
      {summary.total > 0 && transport.capabilities.checks && summary.status !== 'success' && (
        <div className="MergePanel-row MergePanel-row--actions">
          <Button size="small" disabled={running} onClick={() => void runAll()}>
            {running ? 'Running checks…' : 'Run all checks'}
          </Button>
        </div>
      )}
      <div className="MergePanel-row">
        <span className="MergePanel-icon">
          {conflicts == null ? (
            <AlertIcon size={24} fill="var(--fgColor-muted)" />
          ) : conflicts.length ? (
            <AlertIcon size={24} fill="var(--fgColor-attention)" />
          ) : (
            <CheckCircleFillIcon size={24} fill="var(--fgColor-success)" />
          )}
        </span>
        <span className="MergePanel-text">
          <span className="MergePanel-title">
            {conflicts == null
              ? 'Merge status unknown'
              : conflicts.length
                ? 'This branch has conflicts that must be resolved'
                : 'No conflicts with base branch'}
          </span>
          <span className="MergePanel-sub">
            {conflicts == null
              ? 'Conflicts could not be checked for this view.'
              : conflicts.length
                ? `Conflicting ${plural(conflicts.length, 'file')}: ${conflicts.slice(0, 5).join(', ')}${conflicts.length > 5 ? '…' : ''}`
                : 'Merging can be performed automatically.'}
          </span>
        </span>
      </div>
      <div className="MergePanel-actions">
        <Button variant="primary" disabled={!transport.capabilities.publish} onClick={() => openReview('CONFIRM')}>
          {pr ? `Confirm and push to #${pr.number}` : 'Confirm and create pull request'}
        </Button>
        <p className="MergePanel-note">
          {transport.capabilities.publish
            ? `Confirm pushes ${s.head.name} and ${pr ? 'updates the open pull request' : `opens a pull request into ${s.base.name}`}.`
            : 'Publishing is available in the native window (`prv`).'}
        </p>
        <p className="MergePanel-note">
          Not ready?{' '}
          <a href="#review" onClick={(e) => (e.preventDefault(), openReview('REQUEST_CHANGES'))}>
            Request changes
          </a>{' '}
          to send your comments to the AI agent.
        </p>
      </div>
      {checks.length > 0 && (
        <ul className="MergePanel-checks">
          {checks.map((c) => (
            <li key={c.name}>
              <ChecksStatusIcon status={c.status === 'cancelled' ? 'idle' : c.status === 'queued' || c.status === 'running' ? 'pending' : c.status === 'success' ? 'success' : c.status === 'failure' ? 'failure' : 'idle'} />
              <span>{c.name}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
