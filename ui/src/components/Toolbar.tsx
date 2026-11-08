import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertIcon, GearIcon, SidebarCollapseIcon, SidebarExpandIcon, XIcon } from '@primer/octicons-react'
import { useStore } from '../store'
import { CommentBox, Menu } from './common'
import { StateLabel } from './Header'
import { anchorFor, extOf, plural, shortDate, viewedKey } from '../diff/util'
import type { ReviewEvent } from '../types'

export function FilesToolbar() {
  const sentinel = useRef<HTMLDivElement>(null)
  const [stuck, setStuck] = useState(false)
  const prTitle = useStore((st) => st.prTitle)
  const pr = useStore((st) => st.snapshot?.existingPr)
  useEffect(() => {
    const el = sentinel.current
    if (!el) return
    const io = new IntersectionObserver(([e]) => setStuck(!e.isIntersecting), { threshold: 0 })
    io.observe(el)
    return () => io.disconnect()
  }, [])
  return (
    <>
      <div ref={sentinel} style={{ height: 1, marginTop: -1 }} />
      <div className={`pr-toolbar ${stuck ? 'is-stuck' : ''}`}>
        <div className="diffbar">
          <div className="diffbar-stuck-state">
            <StateLabel compact />
          </div>
          <div className="diffbar-left">
            <div className="diffbar-stuck-title">
              <a className="Link--primary" href="#top" style={{ color: 'inherit', textDecoration: 'none' }}>
                {prTitle}
              </a>
              {pr && <span className="num">#{pr.number}</span>}
            </div>
            <div className="diffbar-items">
              <TreeToggle />
              <CommitsMenu />
              <FileFilterMenu />
              <ClearFilters />
              <ConversationsMenu />
              <SettingsMenu />
            </div>
          </div>
          <div className="diffbar-right">
            <ViewedProgress />
            <ReviewMenu />
          </div>
        </div>
      </div>
    </>
  )
}

function TreeToggle() {
  const visible = useStore((st) => st.settings.treeVisible)
  const apply = useStore((st) => st.applySettings)
  return (
    <button
      type="button"
      className="file-tree-toggle"
      aria-label={visible ? 'Hide file tree' : 'Show file tree'}
      title={visible ? 'Hide file tree' : 'Show file tree'}
      onClick={() => apply({ treeVisible: !visible })}
    >
      {visible ? <SidebarExpandIcon size={16} /> : <SidebarCollapseIcon size={16} />}
    </button>
  )
}

function CommitsMenu() {
  const s = useStore((st) => st.snapshot)!
  const range = useStore((st) => st.range)
  const reload = useStore((st) => st.reload)
  const ranges = useStore((st) => st.transport?.capabilities.ranges)
  const [anchor, setAnchor] = useState<number | null>(null)
  const label = useMemo(() => {
    if (!range.from && !range.to) return 'all commits'
    const from = s.commits.findIndex((c) => c.sha === range.from)
    const to = s.commits.findIndex((c) => c.sha === range.to)
    if (from === to) return s.commits[from]?.short ?? range.from?.slice(0, 7)
    return `${plural(to - from + 1, 'commit')}`
  }, [range, s.commits])
  return (
    <Menu
      className="diffbar-item"
      summary={
        <>
          Changes from <strong>{label}</strong>
          <span className="dropdown-caret" />
        </>
      }
    >
      {(close) => (
        <div className="select-menu-modal" role="menu">
          <div className="select-menu-header">Commits</div>
          <div className="select-menu-list">
            <button
              type="button"
              className={`select-menu-item ${!range.from ? 'selected' : ''}`}
              onClick={() => {
                close()
                void reload({})
              }}
            >
              <div className="text-emphasized">Show all changes</div>
              <span className="description">{plural(s.commits.length, 'commit')}</span>
            </button>
            <div className="select-menu-divider">
              Select commit <span className="note">Hold shift + click to select a range</span>
            </div>
            {!ranges && (
              <div className="select-menu-blankslate">Commit ranges are available in the native window (`prv`).</div>
            )}
            {s.commits.map((c, i) => {
              const fromI = s.commits.findIndex((x) => x.sha === range.from)
              const toI = s.commits.findIndex((x) => x.sha === range.to)
              const inRange = range.from && i >= fromI && i <= toI
              return (
                <button
                  key={c.sha}
                  type="button"
                  disabled={!ranges}
                  className={`select-menu-item ${inRange ? 'selected' : ''}`}
                  onClick={(e) => {
                    if (e.shiftKey && anchor != null) {
                      const a = Math.min(anchor, i)
                      const b = Math.max(anchor, i)
                      close()
                      void reload({ from: s.commits[a].sha, to: s.commits[b].sha })
                      return
                    }
                    setAnchor(i)
                    close()
                    void reload({ from: c.sha, to: c.sha })
                  }}
                >
                  <code>{c.short}</code>
                  <div className="text-emphasized">{c.subject}</div>
                  <span className="description">
                    {c.author} on {shortDate(c.date)}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      )}
    </Menu>
  )
}

function FileFilterMenu() {
  const s = useStore((st) => st.snapshot)!
  const filter = useStore((st) => st.filter)
  const setFilter = useStore((st) => st.setFilter)
  const exts = useMemo(() => {
    const m = new Map<string, number>()
    for (const f of s.files) {
      const e = extOf(f.path) || 'No extension'
      m.set(e, (m.get(e) ?? 0) + 1)
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [s.files])
  const hasDeleted = s.files.some((f) => f.status === 'deleted')
  const selected = (e: string) => !filter.exts || filter.exts.includes(e)
  const allSelected = !filter.exts || filter.exts.length === exts.length
  const active = !allSelected || !filter.showViewed || !filter.showDeleted
  return (
    <Menu
      className="diffbar-item"
      summary={
        <>
          <strong>{active ? 'File filter (active)' : 'File filter'}</strong>
          <span className="dropdown-caret" />
        </>
      }
    >
      {() => (
        <div className="select-menu-modal" role="menu" style={{ width: 300 }}>
          <div className="select-menu-header">Filter by extension</div>
          <div>
            {exts.map(([e, n]) => (
              <label key={e} className="SelectMenu-checkbox-item">
                <input
                  type="checkbox"
                  checked={selected(e)}
                  onChange={() => {
                    const cur = filter.exts ?? exts.map(([x]) => x)
                    const next = cur.includes(e) ? cur.filter((x) => x !== e) : [...cur, e]
                    setFilter({ exts: next.length === exts.length ? null : next })
                  }}
                />
                {e}&nbsp;<span className="count">({n})</span>
              </label>
            ))}
            <label
              className="SelectMenu-checkbox-item muted"
              onClick={() => setFilter({ exts: null })}
              style={{ cursor: allSelected ? 'default' : 'pointer' }}
            >
              {allSelected ? `All ${plural(exts.length, 'file type')} selected` : `Select all ${plural(exts.length, 'file type')}`}
            </label>
            <hr className="SelectMenu-divider" />
            {hasDeleted && (
              <label className="SelectMenu-checkbox-item">
                <input type="checkbox" checked={filter.showDeleted} onChange={() => setFilter({ showDeleted: !filter.showDeleted })} />
                Deleted files
              </label>
            )}
            <label className="SelectMenu-checkbox-item">
              <input type="checkbox" checked={filter.showViewed} onChange={() => setFilter({ showViewed: !filter.showViewed })} />
              Viewed files
            </label>
          </div>
        </div>
      )}
    </Menu>
  )
}

function ClearFilters() {
  const filter = useStore((st) => st.filter)
  const setFilter = useStore((st) => st.setFilter)
  if (!filter.exts && filter.showViewed && filter.showDeleted) return null
  return (
    <button
      type="button"
      className="diffbar-button"
      style={{ color: 'var(--fgColor-accent)', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 }}
      onClick={() => setFilter({ exts: null, showViewed: true, showDeleted: true })}
    >
      <XIcon size={16} fill="var(--fgColor-muted)" /> Clear filters
    </button>
  )
}

function ConversationsMenu() {
  const drafts = useStore((st) => st.drafts)
  return (
    <Menu
      className="diffbar-item"
      summary={
        <>
          <strong>Conversations</strong>
          <span className="dropdown-caret" />
        </>
      }
    >
      {(close) => (
        <div className="select-menu-modal" role="menu">
          <div className="select-menu-header">Conversations</div>
          <div className="select-menu-list">
            {drafts.length === 0 && <div className="select-menu-blankslate">There are no conversations yet.</div>}
            {drafts.map((d) => (
              <button
                key={d.id}
                type="button"
                className="select-menu-item"
                onClick={() => {
                  close()
                  document.getElementById(`comment-${d.id}`)?.scrollIntoView({ block: 'center' })
                }}
              >
                <div className="text-emphasized">{d.body.split('\n')[0] || '(empty)'}</div>
                <span className="description">
                  {d.path}:{d.startLine && d.startLine !== d.line ? `${d.startLine}-${d.line}` : d.line} · Pending
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </Menu>
  )
}

function DiffViewArt({ kind }: { kind: 'unified' | 'split' }) {
  const g = 'var(--diffBlob-additionWord-bgColor)'
  const r = 'var(--diffBlob-deletionWord-bgColor)'
  const n = 'var(--bgColor-neutral-muted)'
  const rows =
    kind === 'unified'
      ? [
          [g, 32],
          [g, 24],
          [r, 28],
          [n, 30],
          [r, 22],
          [g, 30],
        ]
      : []
  return (
    <svg width="50" height="50" viewBox="0 0 50 50" aria-hidden>
      <rect x="2.5" y="2.5" width="45" height="45" rx="4" fill="var(--bgColor-default)" stroke="var(--borderColor-default)" />
      {kind === 'unified'
        ? rows.map(([c, w], i) => <rect key={i} x="7" y={8 + i * 6} width={w as number} height="3.5" rx="1.5" fill={c as string} />)
        : [
            [r, g],
            [n, g],
            [r, n],
            [n, g],
            [r, g],
            [n, n],
          ].map(([a, b], i) => (
            <g key={i}>
              <rect x="7" y={8 + i * 6} width="16" height="3.5" rx="1.5" fill={a} />
              <rect x="27" y={8 + i * 6} width="16" height="3.5" rx="1.5" fill={b} />
            </g>
          ))}
    </svg>
  )
}

function SettingsMenu() {
  const settings = useStore((st) => st.settings)
  const apply = useStore((st) => st.applySettings)
  const [view, setView] = useState(settings.diffView)
  const [ws, setWs] = useState(settings.hideWhitespace)
  return (
    <Menu
      className="diffbar-item"
      label="Diff settings"
      summary={
        <span style={{ display: 'inline-flex', alignItems: 'center', color: 'var(--fgColor-muted)' }}>
          <GearIcon size={16} />
          <span className="dropdown-caret" />
        </span>
      }
    >
      {(close) => (
        <div className="Popover-message" onMouseDown={(e) => e.stopPropagation()}>
          <h5>Diff view</h5>
          <div className="diff-view-options">
            {(['unified', 'split'] as const).map((k) => (
              <div key={k} className={`diff-view-option ${view === k ? 'selected' : ''}`} onClick={() => setView(k)}>
                <div className="art">
                  <DiffViewArt kind={k} />
                </div>
                <label>
                  <input type="radio" name="diff" checked={view === k} onChange={() => setView(k)} />
                  {k === 'unified' ? 'Unified' : 'Split'}
                </label>
              </div>
            ))}
          </div>
          <label className="whitespace-option">
            <input type="checkbox" checked={ws} onChange={(e) => setWs(e.target.checked)} />
            Hide whitespace
          </label>
          <div style={{ display: 'flex', flexDirection: 'column', padding: '0 4px', marginTop: 8 }}>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                apply({ diffView: view, hideWhitespace: ws })
                close()
              }}
            >
              Apply and reload
            </button>
          </div>
        </div>
      )}
    </Menu>
  )
}

function ViewedProgress() {
  const files = useStore((st) => st.snapshot!.files)
  const viewed = useStore((st) => st.viewed)
  const n = files.filter((f) => viewed[f.path] === viewedKey(f)).length
  return (
    <span className="viewed-progress" title={`${n} of ${files.length} files viewed`}>
      <progress max={files.length || 1} value={n} />
      {n} / {files.length} files viewed
    </span>
  )
}

function ReviewMenu() {
  const s = useStore((st) => st.snapshot)!
  const transport = useStore((st) => st.transport)!
  const drafts = useStore((st) => st.drafts)
  const checks = useStore((st) => st.checks)
  const prTitle = useStore((st) => st.prTitle)
  const prBody = useStore((st) => st.prBody)
  const setPr = useStore((st) => st.setPr)
  const submit = useStore((st) => st.submit)
  const busy = useStore((st) => st.busy)
  const [event, setEvent] = useState<ReviewEvent>('COMMENT')
  const [body, setBody] = useState('')
  const [draft, setDraft] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const canPublish = transport.capabilities.publish
  const failed = checks.filter((c) => c.status === 'failure')
  const notRun = checks.filter((c) => c.status === 'idle')
  const pr = s.existingPr

  const doSubmit = async () => {
    setError(null)
    if (event === 'REQUEST_CHANGES' && !body.trim() && drafts.length === 0) {
      setError('Leave a comment or add review comments before requesting changes.')
      return
    }
    try {
      await submit(event, body, event === 'CONFIRM' ? { draft } : undefined)
    } catch (e) {
      setError(String(e))
    }
  }

  return (
    <Menu
      className="diffbar-item"
      summaryClassName="btn btn-sm btn-primary"
      summary={
        <>
          Review changes
          {drafts.length > 0 && (
            <span className="Counter" style={{ background: 'rgba(255,255,255,0.2)', color: 'inherit', marginLeft: 4 }}>
              {drafts.length}
            </span>
          )}
          <span className="dropdown-caret" />
        </>
      }
    >
      {() => (
        <div className="review-menu" onMouseDown={(e) => e.stopPropagation()}>
          <h4>Finish your review</h4>
          {error && (
            <div className="flash flash-error">
              <AlertIcon size={16} /> <span style={{ whiteSpace: 'pre-wrap' }}>{error}</span>
            </div>
          )}
          <CommentBox value={body} onChange={setBody} onSubmitShortcut={doSubmit} />
          <div className="review-options">
            <label className="review-option">
              <input type="radio" name="event" checked={event === 'COMMENT'} onChange={() => setEvent('COMMENT')} />
              <span>
                <span className="label">Comment</span>
                <span className="note">Submit general feedback for the author (or AI agent) without blocking.</span>
              </span>
            </label>
            <label className={`review-option ${canPublish ? '' : 'disabled'}`}>
              <input
                type="radio"
                name="event"
                disabled={!canPublish}
                checked={event === 'CONFIRM'}
                onChange={() => setEvent('CONFIRM')}
              />
              <span>
                <span className="label">Confirm</span>
                <span className="note">
                  {canPublish
                    ? pr
                      ? `Push \`${s.head.name}\` to the existing pull request #${pr.number}.`
                      : `Push \`${s.head.name}\` and open a pull request into \`${s.base.name}\`.`
                    : 'Available in the native window (`prv`).'}
                </span>
              </span>
            </label>
            {event === 'CONFIRM' && (
              <div className="confirm-panel">
                {s.dirty && (
                  <div className="flash flash-warn">
                    <AlertIcon size={16} /> You have uncommitted changes. Only committed changes are pushed.
                  </div>
                )}
                {checks.length > 0 && (failed.length > 0 || notRun.length > 0) && (
                  <div className="flash flash-warn">
                    <AlertIcon size={16} />
                    {failed.length > 0
                      ? `${plural(failed.length, 'check')} failed.`
                      : `${plural(notRun.length, 'check')} not run yet.`}{' '}
                    See the Checks tab.
                  </div>
                )}
                {!pr && (
                  <>
                    <label style={{ fontWeight: 600, display: 'block', marginBottom: 4 }}>Title</label>
                    <input className="form-control" value={prTitle} onChange={(e) => setPr(e.target.value, null)} />
                    <label style={{ fontWeight: 600, display: 'block', margin: '12px 0 4px' }}>Description</label>
                    <CommentBox value={prBody} onChange={(v) => setPr(null, v)} placeholder="Add a description" />
                    <label style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 8 }}>
                      <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} />
                      Create as draft pull request
                    </label>
                  </>
                )}
              </div>
            )}
            <label className="review-option">
              <input type="radio" name="event" checked={event === 'REQUEST_CHANGES'} onChange={() => setEvent('REQUEST_CHANGES')} />
              <span>
                <span className="label">Request changes</span>
                <span className="note">Submit feedback that must be addressed before pushing.</span>
              </span>
            </label>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button type="button" className="btn btn-sm btn-primary" disabled={!!busy} onClick={doSubmit}>
              {busy ? busy : event === 'CONFIRM' ? (pr ? 'Confirm and push' : 'Confirm and create pull request') : 'Submit review'}
            </button>
            <span className="color-fg-muted" style={{ fontSize: 12 }}>
              {drafts.length ? `${plural(drafts.length, 'pending comment')}` : 'No pending comments'}
            </span>
          </div>
        </div>
      )}
    </Menu>
  )
}

export function scrollToFile(path: string) {
  const el = document.getElementById(anchorFor(path))
  if (!el) return
  const y = el.getBoundingClientRect().top + window.scrollY - 60
  window.scrollTo({ top: y })
}
