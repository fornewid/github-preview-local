import { useEffect, useMemo, useRef, useState } from 'react'
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
import { ActionList, ActionMenu, Button, Dialog, IconButton, SegmentedControl } from '@primer/react'
import { canConfirm, useStore, type Panel } from '../../store'
import { Avatar, Markdown } from '../common'
import { MarkdownEditor } from '../MarkdownEditor'
import { ChecksStatusIcon, useChecksSummary } from '../PageHeader'
import { anchorFor, plural } from '../../diff/util'
import { clampSidePanel, setSidePanelWidth, SIDE_PANEL, sidePanelMax, useSidePanelWidth } from '../../layout'

const PANELS: Array<[Panel, string, typeof InfoIcon]> = [
  ['comments', 'Comments', CommentDiscussionIcon],
  ['merge', 'Merge status', GitMergeIcon],
  ['overview', 'Overview', InfoIcon],
]

export function SidePanel({ docked, hidden = false }: { docked: boolean; hidden?: boolean }) {
  const panel = useStore((st) => st.panel)
  const setPanel = useStore((st) => st.setPanel)
  const [editing, setEditing] = useState(false)
  // The description draft lives here: the panel may switch between docked and dialog mid-edit.
  const [draft, setDraft] = useState('')
  // Start every edit from the current description (it can change elsewhere, e.g. in Confirm).
  useEffect(() => {
    if (editing) setDraft(useStore.getState().prBody)
  }, [editing])
  const width = useSidePanelWidth((st) => st.width)
  useEffect(() => setEditing(false), [panel])
  if (!panel) return null
  const [, title, Icon] = PANELS.find(([k]) => k === panel)!
  const editButton = panel === 'overview' && !editing && (
    <IconButton variant="invisible" icon={PencilIcon} aria-label="Edit description" onClick={() => setEditing(true)} />
  )
  const body = (
    <>
      {panel === 'overview' && <OverviewPanel editing={editing} setEditing={setEditing} body={draft} setBody={setDraft} />}
      {panel === 'comments' && <CommentsPanel />}
      {panel === 'merge' && <MergePanel />}
    </>
  )
  // Narrower windows: a dialog from the right edge (fullscreen below 768px), titled like the panel.
  if (!docked)
    return (
      <Dialog
        title={title}
        width="xlarge"
        position={{ narrow: 'fullscreen', regular: 'right' }}
        onClose={() => setPanel(null)}
        className="SidePanelDialog"
        renderHeader={({ dialogLabelId }) => (
          <Dialog.Header>
            <div className="SidePanelDialog-headerInner">
              <div className="SidePanelDialog-headerContent">
                <Dialog.Title id={dialogLabelId}>{title}</Dialog.Title>
              </div>
              {editButton}
              <Dialog.CloseButton onClose={() => setPanel(null)} />
            </div>
          </Dialog.Header>
        )}
        renderBody={() => <div className="SidePanelDialog-body">{body}</div>}
      />
    )
  return (
    <aside className="SidePanel" aria-label={title} hidden={hidden} style={{ ['--side-panel-width' as string]: `${width}px` }}>
      <SidePanelDivider width={width} onResizeEnd={setSidePanelWidth} />
      <div className="SidePanel-inner">
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
            {editButton}
            <IconButton variant="invisible" icon={XIcon} aria-label={`Close ${title.toLowerCase()} panel`} onClick={() => setPanel(null)} />
          </div>
        </div>
        <div className="SidePanel-body">{body}</div>
      </div>
    </aside>
  )
}

/**
 * Drag handle on the panel's left edge (Primer's "Draggable pane splitter"): drag, arrow keys
 * (3px steps) or double-click to reset. CSS clamps the width the way github.com clamps it; the
 * handle mirrors that for its ARIA values. Dragging writes the CSS variable directly and commits
 * once, like Primer, so the panel content does not re-render on every pointer move.
 */
function SidePanelDivider({ width, onResizeEnd }: { width: number; onResizeEnd: (w: number) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [, rerender] = useState(0)
  useEffect(() => {
    // The clamp depends on the window width.
    const onResize = () => rerender((n) => n + 1)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  const now = Math.round(clampSidePanel(width))
  const preview = (w: number) => {
    const aside = ref.current?.closest<HTMLElement>('.SidePanel')
    aside?.style.setProperty('--side-panel-width', `${clampSidePanel(w)}px`)
    ref.current?.setAttribute('aria-valuenow', String(Math.round(clampSidePanel(w))))
  }
  return (
    <div className="SidePanel-divider">
      <div
        ref={ref}
        className="SidePanel-handle"
        role="slider"
        tabIndex={0}
        aria-label="Draggable pane splitter"
        aria-valuemin={SIDE_PANEL.min}
        aria-valuemax={sidePanelMax()}
        aria-valuenow={now}
        aria-valuetext={`Pane width ${now} pixels`}
        onPointerDown={(e) => {
          if (e.button !== 0) return
          e.preventDefault()
          const el = e.currentTarget
          el.setPointerCapture(e.pointerId)
          el.dataset.dragging = 'true'
          const startX = e.clientX
          // The rendered width (CSS clamps it), so the panel does not jump when dragging starts.
          const start = el.closest('.SidePanel')?.querySelector<HTMLElement>('.SidePanel-inner')?.getBoundingClientRect().width ?? now
          let last = start
          const move = (ev: PointerEvent) => {
            // The panel is at the end: moving left makes it wider.
            last = start + (startX - ev.clientX)
            preview(last)
          }
          const end = () => {
            delete el.dataset.dragging
            el.removeEventListener('pointermove', move)
            el.removeEventListener('pointerup', end)
            el.removeEventListener('lostpointercapture', end)
            // A click without a drag keeps the saved width (it may be wider than this window allows).
            if (last !== start) onResizeEnd(clampSidePanel(last))
          }
          el.addEventListener('pointermove', move)
          el.addEventListener('pointerup', end)
          el.addEventListener('lostpointercapture', end)
        }}
        onKeyDown={(e) => {
          if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return
          e.preventDefault()
          // From the current width, which may be above what is shown (Primer does the same).
          onResizeEnd(clampSidePanel(width + (e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -3 : 3)))
        }}
        onDoubleClick={() => onResizeEnd(SIDE_PANEL.default)}
      />
    </div>
  )
}

function OverviewPanel({
  editing,
  setEditing,
  body,
  setBody,
}: {
  editing: boolean
  setEditing: (v: boolean) => void
  body: string
  setBody: (v: string) => void
}) {
  const prBody = useStore((st) => st.prBody)
  const setPr = useStore((st) => st.setPr)
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
  const range = useStore((st) => st.range)
  const existing = useStore((st) => st.existingPr)
  const findPr = useStore((st) => st.findPr)
  const confirmable = canConfirm({ transport, range })
  const summary = useChecksSummary()
  useEffect(() => {
    if (confirmable) void findPr()
  }, [confirmable, findPr])
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
      ? 'Add a .gh-prv-local.toml to define checks.'
      : 'Open this preview with gh-prv-local to run them.'
  const conflicts = s.conflicts
  const pr = existing?.pr ?? s.existingPr
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
        <Button variant="primary" disabled={!confirmable} onClick={() => openReview('CONFIRM')}>
          {pr ? `Confirm and push to #${pr.number}` : 'Confirm and create pull request'}
        </Button>
        <p className="MergePanel-note">
          {!transport.capabilities.publish
            ? 'Publishing is available in the native window (`gh-prv-local`).'
            : range.from
              ? 'Switch back to all commits to confirm.'
              : existing?.error
                ? `Publishing is blocked: ${existing.error.split('\n')[0]}`
                : `Confirm pushes ${s.head.name} and ${pr ? 'updates the open pull request' : `opens a pull request into ${s.base.name}`}.`}
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
