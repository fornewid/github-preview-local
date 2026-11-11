import { Fragment, memo, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CodeReviewIcon,
  CommentIcon,
  FoldDownIcon,
  FoldIcon,
  FoldUpIcon,
  KebabHorizontalIcon,
  NoEntryIcon,
  PlusIcon,
  ShieldLockIcon,
  UnfoldIcon,
} from '@primer/octicons-react'
import { ActionList, ActionMenu, Button, IconButton, Label, Tooltip } from '@primer/react'
import { useShallow } from 'zustand/react/shallow'
import { useMediaQuery } from '../../layout'
import { MEDIA } from '../../media'
import { useStore, viewKey, type CommentTarget } from '../../store'
import { parseHunks, splitLines, type DiffLine } from '../../diff/parse'
import {
  applyExpander,
  buildSplit,
  buildUnified,
  computeGaps,
  expandAll,
  type Expander,
  type Gap,
  type GapState,
  type HunkRow,
  type SplitViewRow,
  type UnifiedRow,
} from '../../diff/model'
import type { HlLines, Run } from '../../diff/highlight'
import type { Range } from '../../diff/word'
import { anchorFor, codeownersFor, contentKey, isViewed, ownersLabel, tabSizeFor } from '../../diff/util'
import type { FileDiff, ReviewComment, Side } from '../../types'
import { Avatar, CopyButton, DiffSquares, Markdown, copyText } from '../common'
import { EditForm, MarkdownEditor } from '../MarkdownEditor'

const LARGE_DIFF_LINES = 1500

/** No expanded context (one object, so memoized rows stay valid). */
const NO_GAPS: Readonly<Record<number, GapState>> = Object.freeze({})

/**
 * Opens a file's diff and scrolls it to the top, under the sticky toolbar (`scroll-margin-top`),
 * or centers an element in it (`anchorId`, e.g. a comment). After the next frame, so a dialog
 * that just closed or a tab that just changed is out of the way.
 */
export function revealFile(path: string, anchorId?: string) {
  useStore.getState().toggleCollapsed(path, false)
  requestAnimationFrame(() => {
    const el = (anchorId && document.getElementById(anchorId)) || document.getElementById(anchorFor(path))
    el?.scrollIntoView(anchorId ? { block: 'center' } : undefined)
  })
}

export function DiffList({ files }: { files: FileDiff[] }) {
  if (!files.length)
    return (
      <div className="DiffList-empty">
        <h3>No files to show</h3>
        <p>No changed files match the current filters.</p>
      </div>
    )
  return (
    <div className="DiffList" data-testid="progressive-diffs-list">
      {files.map((f) => (
        <DiffEntry key={f.path} file={f} />
      ))}
    </div>
  )
}

type LineKind = 'addition' | 'deletion' | 'context'
const kindOf = (t: DiffLine['type']): LineKind => (t === 'add' ? 'addition' : t === 'del' ? 'deletion' : 'context')
const markerOf = (t: DiffLine['type']) => (t === 'add' ? '+' : t === 'del' ? '-' : ' ')

const NUM_BG: Record<LineKind, string> = {
  addition: 'var(--diffBlob-additionNum-bgColor, var(--diffBlob-addition-bgColor-num))',
  deletion: 'var(--diffBlob-deletionNum-bgColor, var(--diffBlob-deletion-bgColor-num))',
  context: 'var(--bgColor-default)',
}
const LINE_BG: Record<LineKind, string> = {
  addition: 'var(--diffBlob-additionLine-bgColor, var(--diffBlob-addition-bgColor-line))',
  deletion: 'var(--diffBlob-deletionLine-bgColor, var(--diffBlob-deletion-bgColor-line))',
  context: 'var(--bgColor-default)',
}

function ViewedBox({ checked }: { checked: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden className={`ViewedBox ${checked ? 'checked' : ''}`}>
      <rect x="1.5" y="1.5" width="13" height="13" rx="3" />
      {checked && <path d="M4.5 8.2 6.8 10.5 11.5 5.8" fill="none" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />}
    </svg>
  )
}

const DiffEntry = memo(function DiffEntry({ file }: { file: FileDiff }) {
  const ref = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)
  const [forceLoad, setForceLoad] = useState(false)
  const settings = useStore(
    useShallow((st) => ({ hideWhitespace: st.settings.hideWhitespace, compact: st.settings.compact, diffView: st.settings.diffView })),
  )
  const ui = useStore((st) => st.fileUI[file.path])
  const viewed = useStore((st) => isViewed(st.viewed, file))
  const editorconfig = useStore((st) => st.snapshot?.editorconfig)
  const codeowners = useStore((st) => st.snapshot?.codeowners?.[1])
  const fileComposing = useStore((st) => st.composing?.path === file.path && st.composing.line === 0)
  const oldKey = contentKey(file, 'old')
  const newKey = contentKey(file, 'new')
  const oldText = useStore((st) => st.contents[oldKey])
  const newText = useStore((st) => st.contents[newKey])
  const hlOld = useStore((st) => st.hl[oldKey])
  const hlNew = useStore((st) => st.hl[newKey])
  const { toggleCollapsed, toggleViewed, ensureContents, setGaps, compose } = useStore.getState()
  const collapsed = ui?.collapsed ?? viewed

  useEffect(() => {
    const el = ref.current
    if (!el || visible) return
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          setVisible(true)
          io.disconnect()
        }
      },
      { rootMargin: '1500px 0px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [visible])

  const ws = settings.hideWhitespace
  const patch = ws ? file.patchW : file.patch
  const add = ws ? file.additionsW : file.additions
  const del = ws ? file.deletionsW : file.deletions
  const hunks = useMemo(() => parseHunks(patch), [patch])
  const newLines = useMemo(() => (newText != null ? splitLines(newText) : null), [newText])
  const oldLines = useMemo(() => (oldText != null ? splitLines(oldText) : null), [oldText])
  const newTotal = file.status === 'deleted' ? 0 : newLines ? newLines.length : null
  const loaded = file.status === 'deleted' ? oldLines != null : newLines != null
  const gaps = useMemo(() => computeGaps(hunks, newTotal, loaded), [hunks, newTotal, loaded])
  const gapState = (ws ? ui?.gapsW : ui?.gaps) ?? NO_GAPS
  const expandable = gaps.some((g) => g.size > 0)
  const anyExpanded = Object.values(gapState).some((g) => g.top + g.bottom > 0)
  const toggleExpandAll = () => setGaps(file.path, anyExpanded ? undefined : expandAll(gaps), ws)
  const patchLines = useMemo(() => hunks.reduce((a, h) => a + h.lines.length, 0), [hunks])
  const tabSize = tabSizeFor(editorconfig, file.path)
  // Computed once the file comes near the viewport (CODEOWNERS can have thousands of rules).
  const owners = useMemo(() => (visible ? codeownersFor(codeowners, file.path) : null), [visible, codeowners, file.path])
  const modeChanged =
    file.oldMode && file.newMode && file.oldMode !== file.newMode && file.status !== 'added' && file.status !== 'deleted'
  const renders =
    !collapsed &&
    !file.submodule &&
    !file.binary &&
    !file.tooLarge &&
    (!file.generated || forceLoad) &&
    hunks.length > 0 &&
    (patchLines <= LARGE_DIFF_LINES || forceLoad)
  useEffect(() => {
    if (visible && renders) ensureContents(file)
  }, [visible, renders, file, ensureContents])

  let body: ReactNode = null
  const lineHeight = settings.compact ? 20 : 24
  if (collapsed) body = null
  else if (file.submodule) body = <Placeholder>Submodule {file.path} updated.</Placeholder>
  else if (file.binary) body = <Placeholder>Binary file not shown.</Placeholder>
  else if (file.tooLarge) body = <Placeholder>Large diffs are not rendered by default.</Placeholder>
  else if (file.generated && !forceLoad)
    body = <LoadDiff note="Some generated files are not rendered by default." onLoad={() => setForceLoad(true)} />
  else if (!hunks.length)
    body = (
      <Placeholder>
        {file.status === 'renamed'
          ? 'File renamed without changes.'
          : modeChanged
            ? 'File mode changed.'
            : ws && file.patch
              ? 'Whitespace-only changes.'
              : file.status === 'added'
                ? 'Empty file.'
                : 'File without changes.'}
      </Placeholder>
    )
  else if (patchLines > LARGE_DIFF_LINES && !forceLoad)
    body = <LoadDiff note="Large diffs are not rendered by default." onLoad={() => setForceLoad(true)} />
  else if (!visible) body = <div style={{ height: (patchLines + hunks.length) * lineHeight }} />
  else
    body = (
      <DiffTable
        file={file}
        view={settings.diffView}
        compact={settings.compact}
        hunks={hunks}
        gaps={gaps}
        gapState={gapState}
        newLines={newLines}
        oldLines={oldLines}
        hlOld={hlOld}
        hlNew={hlNew}
        tabSize={tabSize}
        onExpand={(g, e) => setGaps(file.path, { ...gapState, [g.index]: applyExpander(g, gapState[g.index], e) }, ws)}
      />
    )

  const renamed = file.oldPath && file.oldPath !== file.path
  const commentOnFile = () => {
    toggleCollapsed(file.path, false)
    compose({ path: file.path, side: 'RIGHT', line: 0 })
  }
  return (
    <div ref={ref} className="DiffEntry" id={anchorFor(file.path)} data-path={file.path}>
      <div className="DiffEntry-headerWrapper">
        <div className={`DiffFileHeader ${collapsed ? 'collapsed' : ''}`}>
          <div className="DiffFileHeader-toggle">
            <IconButton
              size="small"
              variant="invisible"
              icon={collapsed ? ChevronRightIcon : ChevronDownIcon}
              aria-label={collapsed ? 'Expand file' : 'Collapse file'}
              onClick={() => toggleCollapsed(file.path, !collapsed)}
            />
          </div>
          {owners && (
            <Tooltip text={ownersLabel(owners)} direction="s">
              <button type="button" className="DiffFileHeader-owner" aria-label={ownersLabel(owners)}>
                <ShieldLockIcon size={16} />
              </button>
            </Tooltip>
          )}
          <div className="DiffFileHeader-pathSection">
            <h3 className="DiffFileHeader-name" title={renamed ? `${file.oldPath} → ${file.path}` : file.path}>
              <a className="Link--primary" href={`#${anchorFor(file.path)}`}>
                <code>
                  {'‎'}
                  {renamed ? `${file.oldPath} → ${file.path}` : file.path}
                </code>
              </a>
            </h3>
            <CopyButton text={file.path} label="Copy file name to clipboard" className="DiffFileHeader-copy" />
            {expandable && loaded && !collapsed && (
              <IconButton
                size="small"
                variant="invisible"
                className="DiffFileHeader-expandAll"
                icon={anyExpanded ? FoldIcon : UnfoldIcon}
                aria-label={anyExpanded ? `Collapse expanded lines: ${file.path}` : `Expand all lines: ${file.path}`}
                onClick={toggleExpandAll}
              />
            )}
            {modeChanged && (
              <span className="DiffFileHeader-mode">
                {file.oldMode} → {file.newMode}
              </span>
            )}
          </div>
          <div className="DiffFileHeader-end">
            <div className="DiffFileHeader-stat">
              {file.binary ? (
                <span className="DiffFileHeader-binary">BIN</span>
              ) : (
                <>
                  <span className="DiffStat-add">+{add}</span>
                  <span className="DiffStat-del">-{del}</span>
                </>
              )}
              <span className="sr-only">
                Lines changed: {add} additions &amp; {del} deletions
              </span>
              <DiffSquares add={add} del={del} />
            </div>
            <div className="DiffFileHeader-actions">
              <Button
                size="small"
                className={`DiffFileHeader-viewed ${viewed ? 'is-viewed' : ''}`}
                leadingVisual={() => <ViewedBox checked={viewed} />}
                aria-label={viewed ? 'Viewed' : 'Not Viewed'}
                aria-pressed={viewed}
                onClick={() => toggleViewed(file)}
              >
                Viewed
              </Button>
              <IconButton
                size="small"
                variant="invisible"
                icon={CommentIcon}
                aria-label="Comment on this file"
                className="DiffFileHeader-comment"
                onClick={commentOnFile}
              />
              <FileMenu
                file={file}
                owners={owners ? ownersLabel(owners) : null}
                onComment={commentOnFile}
                expand={
                  expandable && loaded && !collapsed
                    ? { label: anyExpanded ? 'Collapse expanded lines' : 'Expand all lines', run: toggleExpandAll }
                    : null
                }
              />
            </div>
          </div>
        </div>
      </div>
      {!collapsed && (
        <div className="DiffEntry-body">
          <FileComments file={file} composing={fileComposing} />
          {body}
        </div>
      )}
    </div>
  )
})

function Placeholder({ children }: { children: ReactNode }) {
  return <div className="DiffPlaceholder">{children}</div>
}

function LoadDiff({ note, onLoad }: { note: string; onLoad: () => void }) {
  return (
    <Placeholder>
      <Button variant="link" onClick={onLoad}>
        Load diff
      </Button>
      <div className="DiffPlaceholder-note">{note}</div>
    </Placeholder>
  )
}

type FileMenuProps = {
  file: FileDiff
  owners: string | null
  onComment: () => void
  expand: { label: string; run: () => void } | null
}

/**
 * File kebab menu. Below 768px github.com hides the header's comment, copy and expand buttons,
 * stats and CODEOWNERS shield, and offers them here instead.
 */
function FileMenu(props: FileMenuProps) {
  return (
    <ActionMenu>
      <ActionMenu.Anchor>
        <IconButton size="small" variant="invisible" icon={KebabHorizontalIcon} aria-label="More options" />
      </ActionMenu.Anchor>
      <ActionMenu.Overlay align="end">
        <FileMenuItems {...props} />
      </ActionMenu.Overlay>
    </ActionMenu>
  )
}

/** Mounted only while the menu is open, so files do not each watch the window width. */
function FileMenuItems({ file, owners, onComment, expand }: FileMenuProps) {
  const transport = useStore((st) => st.transport)
  const native = transport?.kind === 'native'
  const narrow = useMediaQuery(MEDIA.narrow)
  return (
    <ActionList>
      {narrow && (
        <>
          <ActionList.Item onSelect={onComment}>Comment on this file</ActionList.Item>
          <ActionList.Divider />
          <ActionList.Item onSelect={() => void copyText(file.path)}>Copy file name</ActionList.Item>
          {expand && <ActionList.Item onSelect={expand.run}>{expand.label}</ActionList.Item>}
        </>
      )}
      <ActionList.Item disabled={!native || file.status === 'deleted'} onSelect={() => void transport?.openInEditor(file.path)}>
        Open in editor
      </ActionList.Item>
      {!narrow && <ActionList.Item onSelect={() => void copyText(file.path)}>Copy file path</ActionList.Item>}
      {narrow && owners && (
        <ActionList.Item className="FileMenu-owners">
          <ActionList.LeadingVisual>
            <ShieldLockIcon />
          </ActionList.LeadingVisual>
          {owners}
        </ActionList.Item>
      )}
    </ActionList>
  )
}

/* ------------------------------------------------------------------ */

function nest(text: string, cls: string, x?: string): ReactNode {
  let node: ReactNode = x ? <span className={x}>{text}</span> : text
  if (!cls) return node
  const levels = cls.split('|')
  for (let i = levels.length - 1; i >= 0; i--) node = <span className={levels[i]}>{node}</span>
  return node
}

const LineContent = memo(function LineContent({ text, runs, words }: { text: string; runs?: Run[]; words?: Range[] | null }) {
  if (text === '') return <br />
  const base: Run[] = runs && runs.reduce((a, r) => a + r[0], '') === text ? runs : [[text, '']]
  if (!words?.length) return <>{base.map(([t, c], i) => <span key={i}>{nest(t, c)}</span>)}</>
  const out: ReactNode[] = []
  let pos = 0
  let k = 0
  for (const [t, cls] of base) {
    let start = 0
    while (start < t.length) {
      const abs = pos + start
      const r = words.find(([a, b]) => abs >= a && abs < b)
      let end: number
      if (r) end = Math.min(t.length, r[1] - pos)
      else {
        const next = words.find(([a]) => a > abs)
        end = next ? Math.min(t.length, next[0] - pos) : t.length
      }
      const x = r ? `x${abs === r[0] ? ' x-first' : ''}${pos + end === r[1] ? ' x-last' : ''}` : undefined
      out.push(<span key={k++}>{nest(t.slice(start, end), cls, x)}</span>)
      start = end
    }
    pos += t.length
  }
  return <>{out}</>
})

interface TableProps {
  file: FileDiff
  view: 'split' | 'unified'
  compact: boolean
  hunks: ReturnType<typeof parseHunks>
  gaps: Gap[]
  gapState: Record<number, GapState>
  newLines: string[] | null
  oldLines: string[] | null
  hlOld: HlLines | null | undefined
  hlNew: HlLines | null | undefined
  tabSize: number
  onExpand: (g: Gap, e: Expander) => void
}

function runsFor(line: DiffLine, side: Side | 'auto', hlOld: HlLines | null | undefined, hlNew: HlLines | null | undefined) {
  if (side === 'LEFT' || (side === 'auto' && line.type === 'del')) return line.oldNo ? hlOld?.[line.oldNo - 1] : undefined
  return line.newNo ? hlNew?.[line.newNo - 1] : undefined
}

function snippetFrom(rows: Array<UnifiedRow | SplitViewRow>, side: Side, start: number, end: number): string[] {
  const out: string[] = []
  const seen = new Set<number>()
  const take = (l: DiffLine | null | undefined) => {
    if (!l) return
    const no = side === 'LEFT' ? l.oldNo : l.newNo
    if (no == null || no < start || no > end || seen.has(no)) return
    if (side === 'LEFT' && l.type === 'add') return
    if (side === 'RIGHT' && l.type === 'del') return
    seen.add(no)
    out.push(markerOf(l.type) + l.text)
  }
  for (const r of rows) {
    if (r.kind === 'line') take(r.line)
    else if (r.kind === 'split') take(side === 'LEFT' ? r.left : r.right)
  }
  return out.slice(0, 40)
}

function expanderLabel(e: Expander, r: HunkRow) {
  if (e === 'up') return `Expand file up from line ${r.nextStart}`
  if (e === 'down') return `Expand file down from line ${r.prevEnd}`
  return `Expand file from line ${r.prevEnd} to line ${r.nextStart}`
}

function DiffTable(p: TableProps) {
  const path = p.file.path
  const view = useStore((st) => viewKey(st.range))
  const minimize = useStore((st) => st.settings.minimizeComments)
  const comments = useStore(
    useShallow((st) => st.drafts.filter((d) => d.path === path && d.line > 0 && (d.view ?? '') === view)),
  )
  const composing = useStore((st) => (st.composing?.path === path && st.composing.line > 0 ? st.composing : null))
  const sel = useStore((st) => (st.selection?.path === path ? st.selection : null))
  const { select, compose } = useStore.getState()
  const rows = useMemo(
    () =>
      p.view === 'split'
        ? buildSplit(p.hunks, p.gaps, p.gapState, p.newLines, p.oldLines)
        : buildUnified(p.hunks, p.gaps, p.gapState, p.newLines, p.oldLines),
    [p.view, p.hunks, p.gaps, p.gapState, p.newLines, p.oldLines],
  )
  const isSelected = (side: Side, no: number | null) => !!sel && no != null && sel.side === side && no >= sel.start && no <= sel.end
  const split = p.view === 'split'

  const onNum = (side: Side, no: number | null, e: MouseEvent) => {
    if (no == null) return
    if (e.shiftKey && sel && sel.side === side) select({ path, side, start: Math.min(sel.start, no), end: Math.max(sel.end, no) })
    else if (sel && sel.side === side && sel.start === no && sel.end === no) select(null)
    else select({ path, side, start: no, end: no })
  }
  const startComment = (line: DiffLine, side: Side) => {
    for (const s of ['LEFT', 'RIGHT'] as const) {
      const n = s === 'LEFT' ? line.oldNo : line.newNo
      if (sel && sel.side === s && n != null && n >= sel.start && n <= sel.end && sel.start !== sel.end) {
        compose({ path, side: s, line: sel.end, startLine: sel.start })
        return
      }
    }
    const no = side === 'LEFT' ? line.oldNo : line.newNo
    if (no != null) compose({ path, side, line: no })
  }

  const threadsAt = (side: Side, no: number | null) => (no == null ? [] : comments.filter((c) => c.side === side && c.line === no))
  const composingAt = (side: Side, no: number | null) =>
    !!composing && no != null && composing.side === side && composing.line === no

  const commentContent = (side: Side, no: number | null): ReactNode => {
    const t = threadsAt(side, no)
    const form = composingAt(side, no)
    if (!t.length && !form) return null
    return (
      <div className="DiffComments">
        {minimize && t.length > 0 ? <MinimizedThreads comments={t} /> : t.map((c) => <Thread key={c.id} c={c} />)}
        {form && <InlineCommentForm target={composing!} rows={rows} />}
      </div>
    )
  }

  /** A line number cell showing `no`; a click selects line `target` (unified rows select across sides). */
  const numCell = (kind: LineKind, no: number | null, selected: boolean, target: [Side, number | null], extra = '') => (
    <td
      className={`new-diff-line-number ${kind === 'context' ? 'diff-line-number-neutral' : ''} ${no == null ? 'empty-diff-line' : ''} ${extra}`}
      data-line-number={no ?? undefined}
      data-selected={selected}
      style={{ backgroundColor: NUM_BG[kind] }}
      onClick={(e) => onNum(target[0], target[1], e)}
    >
      {no}
    </td>
  )

  const codeCell = (line: DiffLine, side: Side, words: Range[] | null | undefined, sideClass: string) => {
    const no = side === 'LEFT' ? line.oldNo : line.newNo
    const kind = kindOf(line.type)
    const runs = runsFor(line, side, p.hlOld, p.hlNew)
    const selected = split ? isSelected(side, no) : isSelected('LEFT', line.oldNo) || isSelected('RIGHT', line.newNo)
    return (
      <td
        className={`diff-text-cell ${sideClass}`}
        data-selected={selected}
        style={{ backgroundColor: LINE_BG[kind] }}
      >
        <code className={`diff-text syntax-highlighted-line ${kind === 'context' ? '' : kind}`}>
          {kind !== 'context' && <span className="diff-text-marker">{markerOf(line.type)}</span>}
          <div className="diff-text-inner">
            <LineContent text={line.text} runs={runs} words={words} />
            {line.noNewline && (
              <span className="no-newline" title="No newline at end of file" aria-label="No newline at end of file">
                <NoEntryIcon size={16} />
              </span>
            )}
          </div>
        </code>
        {no != null && (
          <div className="addCommentButton">
            <button
              type="button"
              className="addCommentButton-button"
              aria-label="Add comment"
              onClick={() => startComment(line, side)}
            >
              <PlusIcon size={16} />
            </button>
          </div>
        )}
      </td>
    )
  }

  const hunkCell = (r: HunkRow, colSpan: number) => (
    <td colSpan={colSpan} className="diff-hunk-cell" style={{ backgroundColor: 'var(--bgColor-accent-muted)' }}>
      <div className="diff-hunk-row">
        {r.expanders.length === 0 ? (
          <div className={`hunk-kebab-icon ${split ? '' : 'hunk-kebab-icon-unified'}`}>
            <KebabHorizontalIcon size={16} />
          </div>
        ) : r.expanders.length === 1 ? (
          <ExpandButton e={r.expanders[0]} r={r} unified={!split} onClick={() => p.onExpand(p.gaps[r.gap], r.expanders[0])} />
        ) : (
          <div className="expand-up-and-down-group">
            {r.expanders.map((e) => (
              <ExpandButton key={e} e={e} r={r} unified={!split} twin onClick={() => p.onExpand(p.gaps[r.gap], e)} />
            ))}
          </div>
        )}
        {r.text && (
          <code className="diff-text-cell hunk">
            <div className="diff-text-inner fgColor-muted">{r.text}</div>
          </code>
        )}
      </div>
    </td>
  )

  const tableClass = `DiffTable ${p.compact ? 'compact' : ''}`
  if (!split) {
    return (
      <table className={tableClass} aria-label={`Diff for: ${path}`} style={{ tabSize: p.tabSize }}>
        <colgroup>
          <col width="44" />
          <col width="44" />
          <col />
        </colgroup>
        <tbody>
          {(rows as UnifiedRow[]).map((r) => {
            if (r.kind === 'hunk')
              return (
                <tr key={r.key} className="diff-line-row">
                  {hunkCell(r, 3)}
                </tr>
              )
            const l = r.line
            const kind = kindOf(l.type)
            const side: Side = l.type === 'del' ? 'LEFT' : 'RIGHT'
            const leftTarget: [Side, number | null] = l.oldNo != null && l.type !== 'add' ? ['LEFT', l.oldNo] : ['RIGHT', l.newNo]
            const rightTarget: [Side, number | null] = l.newNo != null && l.type !== 'del' ? ['RIGHT', l.newNo] : ['LEFT', l.oldNo]
            const cl = l.type !== 'add' ? commentContent('LEFT', l.oldNo) : null
            const cr = l.type !== 'del' ? commentContent('RIGHT', l.newNo) : null
            const selected = isSelected('LEFT', l.oldNo) || isSelected('RIGHT', l.newNo)
            return (
              <Fragment key={r.key}>
                <tr className="diff-line-row">
                  {numCell(kind, l.type === 'add' ? null : l.oldNo, selected, leftTarget)}
                  {numCell(kind, l.type === 'del' ? null : l.newNo, selected, rightTarget)}
                  {codeCell(l, side, r.words, 'left-side')}
                </tr>
                {(cl || cr) && (
                  <tr className="diff-comment-row">
                    <td colSpan={2} className="new-diff-line-number" style={{ backgroundColor: NUM_BG[kind] }} />
                    <td className="diff-comment-cell" style={{ backgroundColor: LINE_BG[kind] }}>
                      {cl}
                      {cr}
                    </td>
                  </tr>
                )}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    )
  }

  return (
    <table className={tableClass} aria-label={`Diff for: ${path}`} style={{ tabSize: p.tabSize }}>
      <colgroup>
        <col width="44" />
        <col />
        <col width="44" />
        <col />
      </colgroup>
      <tbody>
        {(rows as SplitViewRow[]).map((r) => {
          if (r.kind === 'hunk')
            return (
              <tr key={r.key} className="diff-line-row">
                {hunkCell(r, 4)}
              </tr>
            )
          const L = r.left
          const R = r.right
          const cl = L ? commentContent('LEFT', L.oldNo) : null
          const cr = R ? commentContent('RIGHT', R.newNo) : null
          const lk = L ? kindOf(L.type) : 'context'
          const rk = R ? kindOf(R.type) : 'context'
          return (
            <Fragment key={r.key}>
              <tr className="diff-line-row">
                {L ? (
                  <>
                    {numCell(lk, L.oldNo, isSelected('LEFT', L.oldNo), ['LEFT', L.oldNo], 'left-side')}
                    {codeCell(L, 'LEFT', r.leftWords, 'left-side-diff-cell')}
                  </>
                ) : (
                  <>
                    <td className="empty-diff-line left-side" />
                    <td className="empty-diff-line left-side" />
                  </>
                )}
                {R ? (
                  <>
                    {numCell(rk, R.newNo, isSelected('RIGHT', R.newNo), ['RIGHT', R.newNo], 'right-side')}
                    {codeCell(R, 'RIGHT', r.rightWords, 'right-side-diff-cell')}
                  </>
                ) : (
                  <>
                    <td className="empty-diff-line" />
                    <td className="empty-diff-line" />
                  </>
                )}
              </tr>
              {(cl || cr) && (
                <tr className="diff-comment-row">
                  {cl ? (
                    <>
                      <td className="new-diff-line-number" style={{ backgroundColor: NUM_BG[lk] }} />
                      <td className="diff-comment-cell" style={{ backgroundColor: LINE_BG[lk] }}>
                        {cl}
                      </td>
                    </>
                  ) : (
                    <td colSpan={2} className="empty-diff-line" />
                  )}
                  {cr ? (
                    <>
                      <td className="new-diff-line-number" style={{ backgroundColor: NUM_BG[rk] }} />
                      <td className="diff-comment-cell" style={{ backgroundColor: LINE_BG[rk] }}>
                        {cr}
                      </td>
                    </>
                  ) : (
                    <td colSpan={2} className="empty-diff-line" />
                  )}
                </tr>
              )}
            </Fragment>
          )
        })}
      </tbody>
    </table>
  )
}

function ExpandButton({ e, r, unified, twin, onClick }: { e: Expander; r: HunkRow; unified: boolean; twin?: boolean; onClick: () => void }) {
  const label = expanderLabel(e, r)
  return (
    <button
      type="button"
      className={`expand-button-line ${unified ? 'expand-button-unified' : ''} ${twin ? 'expand-up-and-down' : ''}`}
      aria-label={label}
      title={label}
      data-direction={e}
      onClick={onClick}
    >
      {e === 'up' ? <FoldUpIcon size={16} /> : e === 'down' ? <FoldDownIcon size={16} /> : <UnfoldIcon size={16} />}
    </button>
  )
}

/* ---------------- Comments ---------------- */

function lineRef(t: { side: Side; line: number; startLine?: number | null }) {
  const p = t.side === 'LEFT' ? 'L' : 'R'
  if (t.line === 0) return null
  return t.startLine && t.startLine !== t.line ? `lines ${p}${t.startLine} to ${p}${t.line}` : `line ${p}${t.line}`
}

function FileComments({ file, composing }: { file: FileDiff; composing: boolean }) {
  const view = useStore((st) => viewKey(st.range))
  const comments = useStore(useShallow((st) => st.drafts.filter((d) => d.path === file.path && d.line === 0 && (d.view ?? '') === view)))
  const target = useStore((st) => st.composing)
  if (!comments.length && !composing) return null
  return (
    <div className="DiffFileComments">
      {comments.map((c) => (
        <Thread key={c.id} c={c} />
      ))}
      {composing && target && <InlineCommentForm target={target} rows={[]} />}
    </div>
  )
}

function InlineCommentForm({ target, rows }: { target: CommentTarget; rows: Array<UnifiedRow | SplitViewRow> }) {
  const [body, setBody] = useState('')
  const author = useStore((st) => st.snapshot?.author ?? 'you')
  const first = useStore((st) => st.drafts.length === 0)
  const { compose, addComment } = useStore.getState()
  const snippet = useMemo(
    () => (target.line > 0 ? snippetFrom(rows, target.side, target.startLine ?? target.line, target.line) : []),
    [rows, target],
  )
  const submit = () => {
    if (!body.trim()) return
    addComment({
      path: target.path,
      side: target.side,
      line: target.line,
      startLine: target.startLine ?? null,
      body,
      snippet,
    })
  }
  const where = lineRef(target)
  return (
    <div className="InlineComment">
      <div className="InlineComment-header">
        <Avatar name={author} size={24} />
        <span className="InlineComment-title">{where ? `Add a comment on ${where}` : 'Add a comment on this file'}</span>
      </div>
      <MarkdownEditor
        value={body}
        onChange={setBody}
        autoFocus
        onSubmit={submit}
        label="Add diff comment"
        suggestion={target.side === 'RIGHT' && snippet.length ? snippet.map((l) => l.slice(1)) : undefined}
      />
      <div className="InlineComment-footer">
        <Button onClick={() => compose(null)}>Cancel</Button>
        {first ? (
          <>
            <Button leadingVisual={CommentIcon} disabled={!body.trim()} onClick={submit}>
              Comment
            </Button>
            <Button variant="primary" leadingVisual={CodeReviewIcon} disabled={!body.trim()} onClick={submit}>
              Start a review
            </Button>
          </>
        ) : (
          <Button variant="primary" disabled={!body.trim()} onClick={submit}>
            Add review comment
          </Button>
        )}
      </div>
    </div>
  )
}

function MinimizedThreads({ comments }: { comments: ReviewComment[] }) {
  const author = useStore((st) => st.snapshot?.author ?? 'you')
  const [open, setOpen] = useState(false)
  if (open) return <>{comments.map((c) => <Thread key={c.id} c={c} />)}</>
  return (
    <button type="button" className="MinimizedThread" onClick={() => setOpen(true)}>
      <Avatar name={author} size={16} />
      <span className="MinimizedThread-text">{comments[0].body.split('\n')[0]}</span>
      {comments.length > 1 && <span className="MinimizedThread-more">+{comments.length - 1}</span>}
    </button>
  )
}

function Thread({ c }: { c: ReviewComment }) {
  const author = useStore((st) => st.snapshot?.author ?? 'you')
  const { updateComment, deleteComment } = useStore.getState()
  const [editing, setEditing] = useState(false)
  const [body, setBody] = useState(c.body)
  return (
    <div className="ReviewThread" id={`comment-${c.id}`}>
      <div className="ReviewComment">
        <div className="ReviewComment-header">
          <Avatar name={author} size={24} />
          <strong className="ReviewComment-author">{author}</strong>
          <Label variant="attention">Pending</Label>
          {lineRef(c) && <span className="ReviewComment-meta">{lineRef(c)}</span>}
          <span className="ReviewComment-actions">
            <ActionMenu>
              <ActionMenu.Anchor>
                <IconButton size="small" variant="invisible" icon={KebabHorizontalIcon} aria-label="Comment actions" />
              </ActionMenu.Anchor>
              <ActionMenu.Overlay align="end">
                <ActionList>
                  <ActionList.Item
                    onSelect={() => {
                      setBody(c.body)
                      setEditing(true)
                    }}
                  >
                    Edit
                  </ActionList.Item>
                  <ActionList.Item onSelect={() => void copyText(c.body)}>Copy text</ActionList.Item>
                  <ActionList.Divider />
                  <ActionList.Item variant="danger" onSelect={() => deleteComment(c.id)}>
                    Delete
                  </ActionList.Item>
                </ActionList>
              </ActionMenu.Overlay>
            </ActionMenu>
          </span>
        </div>
        {editing ? (
          <EditForm
            className="ReviewComment-edit"
            value={body}
            onChange={setBody}
            label="Edit comment"
            saveLabel="Update comment"
            disabled={!body.trim()}
            onCancel={() => {
              setBody(c.body)
              setEditing(false)
            }}
            onSave={() => {
              updateComment(c.id, body.trim())
              setEditing(false)
            }}
          />
        ) : (
          <Markdown source={c.body} className="ReviewComment-body" />
        )}
      </div>
    </div>
  )
}
