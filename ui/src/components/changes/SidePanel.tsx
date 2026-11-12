import { useRef, useState } from 'react'
import { CommentDiscussionIcon, XIcon } from '@primer/octicons-react'
import { Dialog, IconButton, SegmentedControl } from '@primer/react'
import { useStore } from '../../store'
import { Avatar } from '../common'
import { revealFile } from './DiffEntry'
import { clampSidePanel, setSidePanelWidth, SIDE_PANEL, useSidePanelWidth } from '../../layout'

/**
 * The side panel beside the diffs: the review comments. (github.com also has Overview and Merge
 * status panels; a local review needs neither, see docs/reference.md.)
 */
export function SidePanel({ docked, hidden = false }: { docked: boolean; hidden?: boolean }) {
  const panel = useStore((st) => st.panel)
  const setPanel = useStore((st) => st.setPanel)
  const width = useSidePanelWidth((st) => st.width)
  if (!panel) return null
  const title = 'Comments'
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
              <Dialog.CloseButton onClose={() => setPanel(null)} />
            </div>
          </Dialog.Header>
        )}
        renderBody={() => (
          <div className="SidePanelDialog-body">
            <CommentsPanel />
          </div>
        )}
      />
    )
  return (
    <aside className="SidePanel" aria-label={title} hidden={hidden} style={{ ['--side-panel-width' as string]: `${width}px` }}>
      <SidePanelDivider width={width} onResizeEnd={setSidePanelWidth} />
      <div className="SidePanel-inner">
        <div className="SidePanel-header">
          <h2 className="SidePanel-title">
            <CommentDiscussionIcon size={16} />
            {title}
          </h2>
          <div className="SidePanel-headerActions">
            <IconButton variant="invisible" icon={XIcon} aria-label="Close comments panel" onClick={() => setPanel(null)} />
          </div>
        </div>
        <div className="SidePanel-body">
          <CommentsPanel />
        </div>
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
  // The clamp depends on the window width.
  const max = useSidePanelWidth((st) => st.max)
  const now = Math.round(clampSidePanel(width, max))
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
        aria-valuemax={max}
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

function CommentsPanel() {
  const drafts = useStore((st) => st.drafts)
  const author = useStore((st) => st.snapshot?.author ?? 'you')
  const [filter, setFilter] = useState(1)
  return (
    <div className="CommentsPanel">
      <div className="CommentsPanel-filters">
        <SegmentedControl aria-label="Filter comments" size="small" onChange={setFilter}>
          <SegmentedControl.Button selected={filter === 0}>All</SegmentedControl.Button>
          <SegmentedControl.Button selected={filter === 1}>Unresolved</SegmentedControl.Button>
          <SegmentedControl.Button selected={filter === 2}>Mine</SegmentedControl.Button>
        </SegmentedControl>
      </div>
      {drafts.length === 0 ? (
        <div className="CommentsPanel-empty">
          <CommentDiscussionIcon size={24} />
          <h3>No review comments yet</h3>
          <p>Click + on a line to add a comment for your AI agent.</p>
        </div>
      ) : (
        <ul className="CommentsPanel-list">
          {drafts.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                className="CommentsPanel-item"
                onClick={() => {
                  useStore.getState().setTab('files')
                  revealFile(c.path, `comment-${c.id}`)
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
