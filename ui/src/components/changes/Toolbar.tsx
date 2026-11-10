import { useEffect, useMemo, useState } from 'react'
import {
  AlertIcon,
  CommentDiscussionIcon,
  GearIcon,
  InfoIcon,
  SidebarCollapseIcon,
  SidebarExpandIcon,
  TriangleDownIcon,
  VersionsIcon,
  XIcon,
} from '@primer/octicons-react'
import {
  ActionList,
  ActionMenu,
  AnchoredOverlay,
  Button,
  Checkbox,
  Dialog,
  Flash,
  FormControl,
  IconButton,
  Radio,
  RadioGroup,
  TextInput,
} from '@primer/react'
import { KeybindingHint } from '@primer/react/experimental'
import { useStore, viewKey } from '../../store'
import type { Commit, ReviewEvent } from '../../types'
import { anchorFor, plural, shortDate, viewedKey } from '../../diff/util'
import { MarkdownEditor } from '../MarkdownEditor'

/** Sticky toolbar above the diffs (new "Files changed" experience). */
export function ChangesToolbar() {
  const treeVisible = useStore((st) => st.settings.treeVisible)
  const apply = useStore((st) => st.applySettings)
  const panel = useStore((st) => st.panel)
  const setPanel = useStore((st) => st.setPanel)
  const drafts = useStore((st) => st.drafts.length)
  return (
    <section className="ChangesToolbar" aria-labelledby="pr-toolbar-heading">
      <h2 id="pr-toolbar-heading" className="sr-only">
        Pull request toolbar
      </h2>
      <div className="ChangesToolbar-start">
        <IconButton
          size="small"
          variant="invisible"
          className="ChangesToolbar-treeToggle"
          icon={treeVisible ? SidebarExpandIcon : SidebarCollapseIcon}
          aria-label={treeVisible ? 'Collapse file tree' : 'Expand file tree'}
          aria-expanded={treeVisible}
          aria-controls="pr-file-tree"
          onClick={() => apply({ treeVisible: !treeVisible })}
        />
        <CommitPicker />
      </div>
      <div className="ChangesToolbar-end">
        <ViewedProgress />
        <div className="ChangesToolbar-divider" />
        <ReviewButton />
        <SettingsMenu />
        <div className="ChangesToolbar-divider" />
        <div className="ChangesToolbar-panels">
          <IconButton
            size="small"
            variant="invisible"
            icon={InfoIcon}
            aria-label={panel === 'overview' ? 'Close overview panel' : 'Open overview panel'}
            aria-expanded={panel === 'overview'}
            onClick={() => setPanel(panel === 'overview' ? null : 'overview')}
          />
          <Button
            size="small"
            className="ChangesToolbar-panelToggle"
            leadingVisual={CommentDiscussionIcon}
            count={drafts}
            aria-label={panel === 'comments' ? 'Close comments panel' : 'Open comments panel'}
            aria-expanded={panel === 'comments'}
            onClick={() => setPanel(panel === 'comments' ? null : 'comments')}
          />
        </div>
      </div>
    </section>
  )
}

function ViewedProgress() {
  const files = useStore((st) => st.snapshot!.files)
  const viewed = useStore((st) => st.viewed)
  const n = files.filter((f) => viewed[f.path] === viewedKey(f)).length
  const total = files.length
  const r = 6
  const c = 2 * Math.PI * r
  return (
    <div className="ViewedProgress">
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
        <circle cx="8" cy="8" r={r} fill="none" stroke="var(--borderColor-default)" strokeWidth="2" />
        <circle
          cx="8"
          cy="8"
          r={r}
          fill="none"
          stroke="var(--fgColor-done, var(--fgColor-accent))"
          strokeWidth="2"
          strokeDasharray={`${total ? (c * n) / total : 0} ${c}`}
          transform="rotate(-90 8 8)"
        />
      </svg>
      <span className="ViewedProgress-text" aria-hidden>
        <span className="ViewedProgress-count">{n}</span> / <span className="ViewedProgress-count">{total}</span>{' '}
        <span className="ViewedProgress-label">viewed</span>
      </span>
      <span className="sr-only">
        {n} of {total} files viewed
      </span>
    </div>
  )
}

/* ---------------- Settings ---------------- */

function SettingsMenu() {
  const settings = useStore((st) => st.settings)
  const apply = useStore((st) => st.applySettings)
  const wsLabel = !settings.hideWhitespace ? 'Always show' : settings.hideWhitespaceDiffOnly ? 'Hide for this diff only' : 'Always hide'
  return (
    <ActionMenu>
      <ActionMenu.Anchor>
        <IconButton size="small" icon={GearIcon} aria-label="Open diff view settings" />
      </ActionMenu.Anchor>
      <ActionMenu.Overlay align="end">
        <ActionList>
          <ActionList.Group selectionVariant="single">
            <ActionList.GroupHeading>Layout</ActionList.GroupHeading>
            <ActionList.Item selected={settings.diffView === 'unified'} onSelect={() => apply({ diffView: 'unified' })}>
              Unified
            </ActionList.Item>
            <ActionList.Item selected={settings.diffView === 'split'} onSelect={() => apply({ diffView: 'split' })}>
              Split
            </ActionList.Item>
          </ActionList.Group>
          <ActionList.Divider />
          <ActionMenu>
            <ActionMenu.Anchor>
              <ActionList.Item>
                Whitespace changes
                <ActionList.Description variant="block">{wsLabel}</ActionList.Description>
              </ActionList.Item>
            </ActionMenu.Anchor>
            <ActionMenu.Overlay>
              <ActionList selectionVariant="single">
                <ActionList.Item
                  selected={!settings.hideWhitespace}
                  onSelect={() => apply({ hideWhitespace: false, hideWhitespaceDiffOnly: false })}
                >
                  Always show
                  <ActionList.Description variant="block">Show in all files.</ActionList.Description>
                </ActionList.Item>
                <ActionList.Item
                  selected={settings.hideWhitespace && !settings.hideWhitespaceDiffOnly}
                  onSelect={() => apply({ hideWhitespace: true, hideWhitespaceDiffOnly: false })}
                >
                  Always hide
                  <ActionList.Description variant="block">Hide in all files.</ActionList.Description>
                </ActionList.Item>
                <ActionList.Item
                  selected={!!settings.hideWhitespaceDiffOnly && settings.hideWhitespace}
                  onSelect={() => apply({ hideWhitespace: true, hideWhitespaceDiffOnly: true })}
                >
                  Hide for this diff only
                  <ActionList.Description variant="block">Other diffs stay unchanged.</ActionList.Description>
                </ActionList.Item>
              </ActionList>
            </ActionMenu.Overlay>
          </ActionMenu>
          <ActionList.Divider />
          <ActionList.Group selectionVariant="single">
            <ActionList.Item selected={settings.minimizeComments} onSelect={() => apply({ minimizeComments: !settings.minimizeComments })}>
              Minimize comments
              <ActionList.TrailingVisual>
                <KeybindingHint keys="i" />
              </ActionList.TrailingVisual>
            </ActionList.Item>
          </ActionList.Group>
          <ActionList.Divider />
          <ActionList.Group selectionVariant="single">
            <ActionList.Item selected={settings.compact} onSelect={() => apply({ compact: !settings.compact })}>
              Compact line height
            </ActionList.Item>
          </ActionList.Group>
        </ActionList>
      </ActionMenu.Overlay>
    </ActionMenu>
  )
}

/** `i` toggles "Minimize comments", like github.com. */
export function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (e.metaKey || e.ctrlKey || e.altKey || !t || t.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return
      const { applySettings, settings } = useStore.getState()
      if (e.key === 'i') applySettings({ minimizeComments: !settings.minimizeComments })
      else if (e.key === 't') {
        applySettings({ treeVisible: true })
        setTimeout(() => (document.getElementById('file-tree-filter') as HTMLInputElement | null)?.focus(), 50)
        e.preventDefault()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])
}

/* ---------------- Commit picker ---------------- */

function commitLine(c: Commit) {
  const who = [c.author, ...c.coAuthors.filter((n) => n !== c.author)]
  return `${who.length > 1 ? `${who[0]} and ${who.length === 2 ? who[1] : `${who.length - 1} others`}` : who[0]} committed on ${shortDate(c.committerDate || c.date)}`
}

function CommitPicker() {
  const s = useStore((st) => st.snapshot)!
  const range = useStore((st) => st.range)
  const lastReview = useStore((st) => st.lastReview)
  const transport = useStore((st) => st.transport)!
  const reload = useStore((st) => st.reload)
  const [open, setOpen] = useState(false)
  const commits = s.commits
  const idx = (sha?: string | null) => (sha ? commits.findIndex((c) => c.sha === sha) : -1)
  const [sel, setSel] = useState<[number, number] | null>(null)
  const [mode, setMode] = useState<'all' | 'since' | 'range'>('all')
  const sinceIndex = lastReview ? idx(lastReview.head) : -1
  const sinceAvailable = sinceIndex >= 0 && sinceIndex < commits.length - 1
  const canRange = transport.capabilities.ranges

  useEffect(() => {
    if (!open) return
    const a = idx(range.from)
    const b = idx(range.to ?? range.from)
    if (a >= 0) {
      setSel([a, b >= 0 ? b : a])
      setMode(sinceAvailable && a === sinceIndex + 1 && b === commits.length - 1 ? 'since' : 'range')
    } else {
      setSel(null)
      setMode('all')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const label = useMemo(() => {
    if (!range.from) return 'All commits'
    const a = idx(range.from)
    const b = idx(range.to ?? range.from)
    if (a < 0) return 'All commits'
    return a === b ? commits[a].short : `${plural(b - a + 1, 'commit')}`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, commits])

  const toggle = (i: number, shift: boolean) => {
    setMode('range')
    if (!sel) return setSel([i, i])
    if (shift) return setSel([Math.min(sel[0], i), Math.max(sel[1], i)])
    if (sel[0] === sel[1] && sel[0] === i) return setSel(null)
    if (i < sel[0]) return setSel([i, sel[1]])
    if (i > sel[1]) return setSel([sel[0], i])
    // Inside the range: shrink it to start or end here.
    return setSel(i - sel[0] < sel[1] - i ? [i + 1, sel[1]] : [sel[0], i - 1])
  }

  const save = () => {
    setOpen(false)
    if (mode === 'all' || (mode === 'range' && !sel)) void reload({})
    else if (mode === 'since') void reload({ from: commits[sinceIndex + 1].sha, to: commits[commits.length - 1].sha })
    else if (sel) void reload({ from: commits[sel[0]].sha, to: commits[sel[1]].sha })
  }

  return (
    <>
      <Button
        size="small"
        leadingVisual={VersionsIcon}
        trailingVisual={TriangleDownIcon}
        className="CommitPicker-button"
        onClick={() => setOpen(true)}
        disabled={!commits.length}
      >
        {label}
      </Button>
      {open && (
        <Dialog
          title="Select commits to view"
          onClose={() => setOpen(false)}
          width="large"
          className="CommitPicker"
          footerButtons={[
            { buttonType: 'default', content: 'Cancel', onClick: () => setOpen(false) },
            { buttonType: 'primary', content: 'Save', onClick: save },
          ]}
        >
          <ActionList className="CommitPicker-modes">
            <ActionList.Group selectionVariant="single">
              <ActionList.Item selected={mode === 'all'} onSelect={() => setMode('all')}>
                All commits
                <ActionList.Description variant="block">{plural(commits.length, 'commit')}</ActionList.Description>
              </ActionList.Item>
              <ActionList.Item
                selected={mode === 'since'}
                disabled={!sinceAvailable || !canRange}
                onSelect={() => setMode('since')}
              >
                Changes since your last review
                <ActionList.Description variant="block">
                  {sinceAvailable
                    ? `${plural(commits.length - 1 - sinceIndex, 'commit')} since ${shortDate(lastReview!.at)}`
                    : 'No previous review found'}
                </ActionList.Description>
              </ActionList.Item>
            </ActionList.Group>
          </ActionList>
          <div className="CommitPicker-rangeHeading">Select a range of commits</div>
          {!canRange && <div className="CommitPicker-note">Commit ranges are available in the native window (`prv`).</div>}
          <ul className="CommitPicker-list">
            {commits.map((c, i) => {
              const checked = mode === 'range' && !!sel && i >= sel[0] && i <= sel[1]
              return (
                <li key={c.sha} className="CommitPicker-item">
                  <Checkbox
                    id={`commit-${c.sha}`}
                    checked={checked}
                    disabled={!canRange}
                    onChange={(e) => toggle(i, (e.nativeEvent as MouseEvent).shiftKey)}
                  />
                  <label htmlFor={`commit-${c.sha}`} className="CommitPicker-text">
                    <span className="CommitPicker-title">{c.subject}</span>
                    <span className="CommitPicker-meta">{commitLine(c)}</span>
                  </label>
                  <span className="CommitPicker-sha">{c.short}</span>
                </li>
              )
            })}
          </ul>
        </Dialog>
      )}
    </>
  )
}

export { commitLine }

/* ---------------- Submit review ---------------- */

function ReviewButton() {
  const reviewOpen = useStore((st) => st.reviewOpen)
  const openReview = useStore((st) => st.openReview)
  const open = reviewOpen != null
  const setOpen = (v: boolean) => openReview(v ? 'COMMENT' : null)
  return (
    <AnchoredOverlay
      open={open}
      onOpen={() => setOpen(true)}
      onClose={() => setOpen(false)}
      align="end"
      width="xlarge"
      overlayProps={{ role: 'dialog', 'aria-labelledby': 'finish-review-title', className: 'ReviewOverlay' }}
      focusZoneSettings={{ disabled: true }}
      renderAnchor={(props) => (
        <Button {...props} size="small" variant="primary" trailingVisual={TriangleDownIcon} className="ReviewButton">
          Submit review
        </Button>
      )}
    >
      {open && <ReviewForm initial={reviewOpen!} onClose={() => setOpen(false)} />}
    </AnchoredOverlay>
  )
}

function ReviewForm({ initial, onClose }: { initial: ReviewEvent; onClose: () => void }) {
  const s = useStore((st) => st.snapshot)!
  const transport = useStore((st) => st.transport)!
  const drafts = useStore((st) => st.drafts)
  const checks = useStore((st) => st.checks)
  const prTitle = useStore((st) => st.prTitle)
  const prBody = useStore((st) => st.prBody)
  const setPr = useStore((st) => st.setPr)
  const submit = useStore((st) => st.submit)
  const busy = useStore((st) => st.busy)
  const existing = useStore((st) => st.existingPr)
  const findPr = useStore((st) => st.findPr)
  const range = useStore((st) => st.range)
  const [event, setEvent] = useState<ReviewEvent>(initial)
  const [body, setBody] = useState('')
  useEffect(() => {
    if (initial === 'CONFIRM') void findPr()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const [draft, setDraft] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const canPublish = transport.capabilities.publish
  const failed = checks.filter((c) => c.status === 'failure')
  const notRun = checks.filter((c) => c.status === 'idle')
  const pr = existing?.pr ?? s.existingPr
  const blocked = !!busy || (event === 'CONFIRM' && (!!existing?.loading || !!existing?.error))

  const doSubmit = async () => {
    if (blocked) return
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
    <div className="ReviewForm">
      <div className="ReviewForm-header">
        <h2 id="finish-review-title" className="ReviewForm-title">
          Finish your review
        </h2>
        <IconButton variant="invisible" icon={XIcon} aria-label="Close" onClick={onClose} />
      </div>
      <div className="ReviewForm-body">
        {error && (
          <Flash variant="danger" className="ReviewForm-flash">
            <span style={{ whiteSpace: 'pre-wrap' }}>{error}</span>
          </Flash>
        )}
        <MarkdownEditor value={body} onChange={setBody} onSubmit={() => void doSubmit()} autoFocus label="Review body" />
        <RadioGroup name="review-event" className="ReviewForm-options" onChange={(v) => v && setEvent(v as ReviewEvent)}>
          <RadioGroup.Label visuallyHidden>Review event</RadioGroup.Label>
          <FormControl>
            <Radio value="COMMENT" checked={event === 'COMMENT'} />
            <FormControl.Label>Comment</FormControl.Label>
            <FormControl.Caption>Submit general feedback without explicit approval.</FormControl.Caption>
          </FormControl>
          <FormControl disabled={!canPublish || !!range.from}>
            <Radio
              value="CONFIRM"
              checked={event === 'CONFIRM'}
              onChange={() => {
                setEvent('CONFIRM')
                void findPr()
              }}
            />
            <FormControl.Label>Confirm</FormControl.Label>
            <FormControl.Caption>
              {!canPublish
                ? 'Available in the native window (`prv`).'
                : range.from
                  ? 'Switch back to all commits to confirm.'
                  : pr
                    ? `Push ${s.head.name} to the existing pull request #${pr.number}.`
                    : `Push ${s.head.name} and open a pull request into ${s.base.name}.`}
            </FormControl.Caption>
          </FormControl>
          {event === 'CONFIRM' && (
            <div className="ReviewForm-confirm">
              {existing?.loading && <div className="fgColor-muted">Checking for an open pull request…</div>}
              {existing?.error && (
                <Flash variant="danger">
                  <span style={{ whiteSpace: 'pre-wrap' }}>Publishing is blocked: {existing.error.split('\n')[0]}</span>{' '}
                  <Button size="small" onClick={() => void findPr()}>
                    Retry
                  </Button>
                </Flash>
              )}
              {pr && (
                <Flash>
                  Pull request #{pr.number} is already open for this branch. Confirm pushes the new commits to it; its title and description
                  stay unchanged.
                </Flash>
              )}
              {s.dirty && (
                <Flash variant="warning">
                  <AlertIcon size={16} /> You have uncommitted changes. Only committed changes are pushed.
                </Flash>
              )}
              {checks.length > 0 && (failed.length > 0 || notRun.length > 0) && (
                <Flash variant="warning">
                  {failed.length > 0 ? `${plural(failed.length, 'check')} failed.` : `${plural(notRun.length, 'check')} not run yet.`} See
                  Merge status.
                </Flash>
              )}
              {!pr && (
                <>
                  <FormControl>
                    <FormControl.Label>Title</FormControl.Label>
                    <TextInput block value={prTitle} onChange={(e) => setPr(e.target.value, null)} />
                  </FormControl>
                  <div className="ReviewForm-description">
                    <div className="ReviewForm-fieldLabel">Description</div>
                    <MarkdownEditor value={prBody} onChange={(v) => setPr(null, v)} placeholder="Add a description" rows={6} label="Pull request description" />
                  </div>
                  <FormControl>
                    <Checkbox checked={draft} onChange={(e) => setDraft(e.target.checked)} />
                    <FormControl.Label>Create as draft pull request</FormControl.Label>
                  </FormControl>
                </>
              )}
            </div>
          )}
          <FormControl>
            <Radio value="REQUEST_CHANGES" checked={event === 'REQUEST_CHANGES'} />
            <FormControl.Label>Request changes</FormControl.Label>
            <FormControl.Caption>Submit feedback that must be addressed before pushing.</FormControl.Caption>
          </FormControl>
        </RadioGroup>
      </div>
      <div className="ReviewForm-footer">
        <span className="ReviewForm-pending">
          {drafts.length ? plural(drafts.length, 'pending comment') : ''}
        </span>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={blocked} onClick={() => void doSubmit()} className="ReviewForm-submit">
          {busy ? busy : event === 'CONFIRM' ? (pr ? 'Confirm and push' : 'Confirm and create pull request') : 'Submit review'}
          {!busy && <KeybindingHint keys="Mod+Enter" variant="onEmphasis" size="small" />}
        </Button>
      </div>
    </div>
  )
}

export function scrollToFile(path: string) {
  const el = document.getElementById(anchorFor(path))
  if (!el) return
  const y = el.getBoundingClientRect().top + window.scrollY - 60
  window.scrollTo({ top: y })
}

export function viewLabel(range: { from?: string | null; to?: string | null }) {
  return viewKey(range)
}
