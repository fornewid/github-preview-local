import { memo, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FoldDownIcon,
  FoldIcon,
  FoldUpIcon,
  KebabHorizontalIcon,
  NoEntryIcon,
  PencilIcon,
  PlusIcon,
  TrashIcon,
  UnfoldIcon,
  CheckIcon,
} from '@primer/octicons-react'
import { useStore, type CommentTarget } from '../store'
import { parseHunks, splitLines, type DiffLine } from '../diff/parse'
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
} from '../diff/model'
import type { HlLines, Run } from '../diff/highlight'
import type { Range } from '../diff/word'
import { anchorFor, tabSizeFor, truncatePath, viewedKey } from '../diff/util'
import type { FileDiff, ReviewComment, Side } from '../types'
import { Avatar, CommentBox, CopyButton, DiffStatBlocks, Markdown, Menu, copyText } from './common'

const LARGE_DIFF_LINES = 1500

export function FileList({ files }: { files: FileDiff[] }) {
  if (!files.length)
    return (
      <div className="Box blankslate">
        <h3>No files to show</h3>
        <p>No changed files match the current filters.</p>
      </div>
    )
  return (
    <>
      {files.map((f) => (
        <FileView key={f.path} file={f} />
      ))}
    </>
  )
}

function lineType(t: DiffLine['type']) {
  return t === 'add' ? 'addition' : t === 'del' ? 'deletion' : 'context'
}

function marker(t: DiffLine['type']) {
  return t === 'add' ? '+' : t === 'del' ? '-' : ' '
}

const FileView = memo(function FileView({ file }: { file: FileDiff }) {
  const ref = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)
  const [forceLoad, setForceLoad] = useState(false)
  const settings = useStore((st) => st.settings)
  const ui = useStore((st) => st.fileUI[file.path])
  const isViewed = useStore((st) => st.viewed[file.path] === viewedKey(file))
  const editorconfig = useStore((st) => st.snapshot?.editorconfig)
  const oldKey = `old:${file.oldPath ?? file.path}`
  const newKey = `new:${file.path}`
  const oldText = useStore((st) => st.contents[oldKey])
  const newText = useStore((st) => st.contents[newKey])
  const hlOld = useStore((st) => st.hl[oldKey])
  const hlNew = useStore((st) => st.hl[newKey])
  const { toggleCollapsed, toggleViewed, ensureContents, setGaps } = useStore.getState()
  const collapsed = ui?.collapsed ?? isViewed

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

  useEffect(() => {
    if (visible && !collapsed) ensureContents(file)
  }, [visible, collapsed, file, ensureContents])

  const patch = settings.hideWhitespace ? file.patchW : file.patch
  const add = settings.hideWhitespace ? file.additionsW : file.additions
  const del = settings.hideWhitespace ? file.deletionsW : file.deletions
  const hunks = useMemo(() => parseHunks(patch), [patch])
  const newLines = useMemo(() => (newText != null ? splitLines(newText) : null), [newText])
  const oldLines = useMemo(() => (oldText != null ? splitLines(oldText) : null), [oldText])
  const newTotal = file.status === 'deleted' ? 0 : newLines ? newLines.length : null
  const gaps = useMemo(() => computeGaps(hunks, newTotal), [hunks, newTotal])
  const gapState = ui?.gaps ?? {}
  const expandable = gaps.some((g) => g.size > 0)
  const anyExpanded = Object.values(gapState).some((g) => g.top + g.bottom > 0)
  const patchLines = useMemo(() => hunks.reduce((a, h) => a + h.lines.length, 0), [hunks])
  const tabSize = tabSizeFor(editorconfig, file.path)
  const modeChanged = file.oldMode && file.newMode && file.oldMode !== file.newMode && file.status !== 'added' && file.status !== 'deleted'

  let body: ReactNode = null
  if (collapsed) body = null
  else if (file.submodule) body = <Placeholder>Submodule {file.path} updated.</Placeholder>
  else if (file.binary) body = <Placeholder>Binary file not shown.</Placeholder>
  else if (file.tooLarge) body = <Placeholder>Large diffs are not rendered by default.</Placeholder>
  else if (file.generated && !forceLoad)
    body = (
      <Placeholder>
        <button type="button" onClick={() => setForceLoad(true)}>
          Load diff
        </button>
        <div className="note">Some generated files are not rendered by default.</div>
      </Placeholder>
    )
  else if (!hunks.length)
    body = (
      <Placeholder>
        {file.status === 'renamed'
          ? 'File renamed without changes.'
          : modeChanged
            ? 'File mode changed.'
            : settings.hideWhitespace && file.patch
              ? 'Whitespace-only changes.'
              : file.status === 'added'
                ? 'Empty file.'
                : 'File without changes.'}
      </Placeholder>
    )
  else if (patchLines > LARGE_DIFF_LINES && !forceLoad)
    body = (
      <Placeholder>
        <button type="button" onClick={() => setForceLoad(true)}>
          Load diff
        </button>
        <div className="note">Large diffs are not rendered by default.</div>
      </Placeholder>
    )
  else if (!visible) body = <div style={{ height: (patchLines + hunks.length) * 20 }} />
  else
    body = (
      <DiffTable
        file={file}
        view={settings.diffView}
        hunks={hunks}
        gaps={gaps}
        gapState={gapState}
        newLines={newLines}
        oldLines={oldLines}
        hlOld={hlOld}
        hlNew={hlNew}
        tabSize={tabSize}
        onExpand={(g, e) => setGaps(file.path, { ...gapState, [g.index]: applyExpander(g, gapState[g.index], e) })}
      />
    )

  return (
    <div ref={ref} className={`file ${collapsed ? 'collapsed' : ''}`} id={anchorFor(file.path)} data-path={file.path}>
      <div className="file-header">
        <div className="file-info">
          <button
            type="button"
            className="btn-octicon toggle"
            aria-label="Toggle diff contents"
            aria-expanded={!collapsed}
            onClick={() => toggleCollapsed(file.path, !collapsed)}
          >
            {collapsed ? <ChevronRightIcon size={16} /> : <ChevronDownIcon size={16} />}
          </button>
          {expandable && !collapsed && (
            <button
              type="button"
              className="btn-octicon expand-full"
              aria-label={anyExpanded ? 'Collapse expanded lines' : 'Expand all'}
              title={anyExpanded ? 'Collapse expanded lines' : 'Expand all'}
              onClick={() => setGaps(file.path, anyExpanded ? undefined : expandAll(gaps))}
            >
              {anyExpanded ? <FoldIcon size={16} /> : <UnfoldIcon size={16} />}
            </button>
          )}
          <span className="sr-only">
            {add + del} changes: {add} additions &amp; {del} deletions
          </span>
          <span className="diffstat" aria-hidden title={`${add + del} changes: ${add} additions & ${del} deletions`}>
            {file.binary ? 'BIN' : add + del} <DiffStatBlocks add={add} del={del} />
          </span>
          <span className="Truncate">
            <a
              className="Truncate-text"
              title={file.oldPath && file.oldPath !== file.path ? `${file.oldPath} → ${file.path}` : file.path}
              href={`#${anchorFor(file.path)}`}
            >
              {file.oldPath && file.oldPath !== file.path ? (
                <>
                  {truncatePath(file.oldPath, 60)}
                  <span className="rename-arrow">→</span>
                  {truncatePath(file.path, 60)}
                </>
              ) : (
                truncatePath(file.path)
              )}
            </a>
            <CopyButton text={file.path} />
          </span>
          {modeChanged && (
            <span className="file-mode">
              {file.oldMode} → {file.newMode}
            </span>
          )}
        </div>
        <div className="file-actions">
          <label className={`js-reviewed-toggle ${isViewed ? 'is-viewed' : ''}`}>
            <input type="checkbox" checked={isViewed} onChange={() => toggleViewed(file)} />
            Viewed
          </label>
          <FileKebab file={file} />
        </div>
      </div>
      {body}
    </div>
  )
})

function Placeholder({ children }: { children: ReactNode }) {
  return <div className="file-placeholder">{children}</div>
}

function FileKebab({ file }: { file: FileDiff }) {
  const transport = useStore((st) => st.transport)
  return (
    <Menu className="file-kebab" label="Show options" summary={<KebabHorizontalIcon size={16} />}>
      {(close) => (
        <div className="dropdown-menu" role="menu">
          <button type="button" className="dropdown-item" role="menuitemradio" aria-checked onClick={close}>
            <span className="check">
              <CheckIcon size={16} />
            </span>
            Show comments
          </button>
          <div className="dropdown-divider" />
          <button
            type="button"
            className="dropdown-item"
            onClick={() => {
              void copyText(file.path)
              close()
            }}
          >
            Copy file path
          </button>
          <button
            type="button"
            className="dropdown-item"
            disabled={transport?.kind !== 'native' || file.status === 'deleted'}
            onClick={() => {
              void transport?.openInEditor(file.path)
              close()
            }}
          >
            Open in editor
          </button>
        </div>
      )}
    </Menu>
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

function LineContent({ text, runs, words }: { text: string; runs?: Run[]; words?: Range[] | null }) {
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
}

interface TableProps {
  file: FileDiff
  view: 'split' | 'unified'
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
    out.push(marker(l.type) + l.text)
  }
  for (const r of rows) {
    if (r.kind === 'line') take(r.line)
    else if (r.kind === 'split') take(side === 'LEFT' ? r.left : r.right)
  }
  return out.slice(0, 40)
}

function DiffTable(p: TableProps) {
  const drafts = useStore((st) => st.drafts)
  const composing = useStore((st) => st.composing)
  const selection = useStore((st) => st.selection)
  const { select, compose } = useStore.getState()
  const path = p.file.path
  const rows = useMemo(
    () =>
      p.view === 'split'
        ? buildSplit(p.hunks, p.gaps, p.gapState, p.newLines, p.oldLines)
        : buildUnified(p.hunks, p.gaps, p.gapState, p.newLines, p.oldLines),
    [p.view, p.hunks, p.gaps, p.gapState, p.newLines, p.oldLines],
  )
  const comments = useMemo(() => drafts.filter((d) => d.path === path), [drafts, path])
  const sel = selection?.path === path ? selection : null
  const isSelected = (side: Side, no: number | null) => !!sel && no != null && sel.side === side && no >= sel.start && no <= sel.end

  const onNum = (side: Side, no: number | null, e: MouseEvent) => {
    if (no == null) return
    if (e.shiftKey && sel && sel.side === side) select({ path, side, start: Math.min(sel.start, no), end: Math.max(sel.end, no) })
    else if (sel && sel.side === side && sel.start === no && sel.end === no) select(null)
    else select({ path, side, start: no, end: no })
  }
  const startComment = (side: Side, no: number) => {
    if (sel && sel.side === side && no >= sel.start && no <= sel.end && sel.start !== sel.end)
      compose({ path, side, line: sel.end, startLine: sel.start })
    else compose({ path, side, line: no })
  }

  const threadsAt = (side: Side, no: number | null) =>
    no == null ? [] : comments.filter((c) => c.side === side && c.line === no)
  const composingAt = (side: Side, no: number | null) =>
    !!composing && no != null && composing.path === path && composing.side === side && composing.line === no

  const commentCell = (side: Side, no: number | null): ReactNode => {
    const t = threadsAt(side, no)
    const form = composingAt(side, no)
    if (!t.length && !form) return null
    return (
      <>
        {t.map((c) => (
          <Thread key={c.id} c={c} />
        ))}
        {form && <InlineCommentForm target={composing!} rows={rows} />}
      </>
    )
  }

  const plusButton = (side: Side, no: number | null, any: boolean) =>
    no == null ? null : (
      <button
        type="button"
        className={`add-line-comment ${any ? 'side-any' : ''}`}
        aria-label="Add line comment"
        title="Add a comment to this line"
        onClick={() => startComment(side, no)}
      >
        <PlusIcon size={16} />
      </button>
    )

  const codeCell = (line: DiffLine, side: Side, words: Range[] | null | undefined, any: boolean, extraClass = '') => {
    const no = side === 'LEFT' ? line.oldNo : line.newNo
    const runs = runsFor(line, side, p.hlOld, p.hlNew)
    return (
      <td
        className={`blob-code blob-code-${lineType(line.type)} ${isSelected(side, no) ? 'selected-line' : ''} ${extraClass}`}
        data-split-side={p.view === 'split' ? (side === 'LEFT' ? 'left' : 'right') : undefined}
      >
        {plusButton(side, no, any)}
        <span className="blob-code-inner blob-code-marker" data-code-marker={marker(line.type)}>
          <LineContent text={line.text} runs={runs} words={words} />
          {line.noNewline && (
            <span className="no-nl-marker" title="No newline at end of file" aria-label="No newline at end of file">
              <NoEntryIcon size={16} />
            </span>
          )}
        </span>
      </td>
    )
  }

  const hunkCells = (r: HunkRow, colSpanNum: number, colSpanCode: number) => (
    <>
      <td className="blob-num blob-num-expandable" colSpan={colSpanNum}>
        {r.dots ? (
          <span className="dots">...</span>
        ) : (
          r.expanders.map((e) => (
            <a
              key={e}
              className="directional-expander"
              role="button"
              tabIndex={0}
              aria-label={e === 'up' ? 'Expand Up' : e === 'down' ? 'Expand Down' : 'Expand All'}
              title={e === 'up' ? 'Expand Up' : e === 'down' ? 'Expand Down' : 'Expand All'}
              onClick={() => p.onExpand(p.gaps[r.gap], e)}
              onKeyDown={(ev) => ev.key === 'Enter' && p.onExpand(p.gaps[r.gap], e)}
            >
              {e === 'up' ? <FoldUpIcon size={16} /> : e === 'down' ? <FoldDownIcon size={16} /> : <UnfoldIcon size={16} />}
            </a>
          ))
        )}
      </td>
      <td className="blob-code blob-code-inner blob-code-hunk" colSpan={colSpanCode}>
        {r.text}
      </td>
    </>
  )

  if (p.view === 'unified') {
    return (
      <table className="diff-table" style={{ ['--tab-size' as string]: p.tabSize }}>
        <tbody>
          {(rows as UnifiedRow[]).map((r) => {
            if (r.kind === 'hunk') return <tr key={r.key}>{hunkCells(r, 2, 1)}</tr>
            const l = r.line
            const side: Side = l.type === 'del' ? 'LEFT' : 'RIGHT'
            const no = side === 'LEFT' ? l.oldNo : l.newNo
            const t = lineType(l.type)
            const commentsRight = l.type !== 'del' ? commentCell('RIGHT', l.newNo) : null
            const commentsLeft = l.type !== 'add' ? commentCell('LEFT', l.oldNo) : null
            return (
              <FragmentRows key={r.key}>
                <tr>
                  <td
                    className={`blob-num blob-num-${t} ${isSelected(side, no) ? 'selected-line' : ''}`}
                    data-line-number={l.oldNo ?? undefined}
                    onClick={(e) => onNum(side, no, e)}
                  />
                  <td
                    className={`blob-num blob-num-${t} ${isSelected(side, no) ? 'selected-line' : ''}`}
                    data-line-number={l.newNo ?? undefined}
                    onClick={(e) => onNum(side, no, e)}
                  />
                  {codeCell(l, side, r.words, true)}
                </tr>
                {(commentsLeft || commentsRight) && (
                  <tr className="inline-comments">
                    <td colSpan={3} className="line-comments">
                      {commentsLeft}
                      {commentsRight}
                    </td>
                  </tr>
                )}
              </FragmentRows>
            )
          })}
        </tbody>
      </table>
    )
  }

  return (
    <table className="diff-table file-diff-split" style={{ ['--tab-size' as string]: p.tabSize }}>
      <colgroup>
        <col width="44" />
        <col />
        <col width="44" />
        <col />
      </colgroup>
      <tbody>
        {(rows as SplitViewRow[]).map((r) => {
          if (r.kind === 'hunk') return <tr key={r.key}>{hunkCells(r, 1, 3)}</tr>
          const L = r.left
          const R = r.right
          const cl = L ? commentCell('LEFT', L.oldNo) : null
          const cr = R ? commentCell('RIGHT', R.newNo) : null
          return (
            <FragmentRows key={r.key}>
              <tr>
                {L ? (
                  <>
                    <td
                      className={`blob-num blob-num-${lineType(L.type)} ${isSelected('LEFT', L.oldNo) ? 'selected-line' : ''}`}
                      data-line-number={L.oldNo ?? undefined}
                      onClick={(e) => onNum('LEFT', L.oldNo, e)}
                    />
                    {codeCell(L, 'LEFT', r.leftWords, false)}
                  </>
                ) : (
                  <>
                    <td className="blob-num blob-num-empty empty-cell" />
                    <td className="blob-code blob-code-empty empty-cell" data-split-side="left" />
                  </>
                )}
                {R ? (
                  <>
                    <td
                      className={`blob-num blob-num-${lineType(R.type)} blob-num-split-right ${isSelected('RIGHT', R.newNo) ? 'selected-line' : ''}`}
                      data-line-number={R.newNo ?? undefined}
                      onClick={(e) => onNum('RIGHT', R.newNo, e)}
                    />
                    {codeCell(R, 'RIGHT', r.rightWords, false)}
                  </>
                ) : (
                  <>
                    <td className="blob-num blob-num-empty empty-cell blob-num-split-right" />
                    <td className="blob-code blob-code-empty empty-cell" data-split-side="right" />
                  </>
                )}
              </tr>
              {(cl || cr) && (
                <tr className="inline-comments">
                  {cl ? (
                    <td colSpan={2} className="line-comments">
                      {cl}
                    </td>
                  ) : (
                    <td colSpan={2} className="empty-cell" />
                  )}
                  {cr ? (
                    <td colSpan={2} className="line-comments">
                      {cr}
                    </td>
                  ) : (
                    <td colSpan={2} className="empty-cell" />
                  )}
                </tr>
              )}
            </FragmentRows>
          )
        })}
      </tbody>
    </table>
  )
}

function FragmentRows({ children }: { children: ReactNode }) {
  return <>{children}</>
}

function linesLabel(c: { line: number; startLine?: number | null }) {
  return c.startLine && c.startLine !== c.line ? `Comment on lines ${c.startLine} to ${c.line}` : `Comment on line ${c.line}`
}

function InlineCommentForm({ target, rows }: { target: CommentTarget; rows: Array<UnifiedRow | SplitViewRow> }) {
  const [body, setBody] = useState('')
  const first = useStore((st) => st.drafts.length === 0)
  const { compose, addComment } = useStore.getState()
  const submit = () => {
    if (!body.trim()) return
    addComment({
      path: target.path,
      side: target.side,
      line: target.line,
      startLine: target.startLine ?? null,
      body,
      snippet: snippetFrom(rows, target.side, target.startLine ?? target.line, target.line),
    })
  }
  return (
    <div className="review-thread">
      <div className="comment-form">
        <CommentBox value={body} onChange={setBody} autoFocus onSubmitShortcut={submit} />
        <div className="comment-form-actions">
          <span className="comment-form-hint">
            {linesLabel(target)} ({target.side === 'LEFT' ? 'deleted side' : 'new side'}) · Markdown is supported
          </span>
          <button type="button" className="btn btn-sm" onClick={() => compose(null)}>
            Cancel
          </button>
          <button type="button" className="btn btn-sm btn-primary" disabled={!body.trim()} onClick={submit}>
            {first ? 'Start a review' : 'Add review comment'}
          </button>
        </div>
      </div>
    </div>
  )
}

function Thread({ c }: { c: ReviewComment }) {
  const author = useStore((st) => st.snapshot?.author ?? 'you')
  const { updateComment, deleteComment } = useStore.getState()
  const [editing, setEditing] = useState(false)
  const [body, setBody] = useState(c.body)
  return (
    <div className="review-thread" id={`comment-${c.id}`}>
      <div className="review-comment">
        <Avatar name={author} size={24} />
        <div className="review-comment-body">
          <div className="review-comment-header">
            <strong>{author}</strong>
            <span className="Label Label--attention">Pending</span>
            <span style={{ fontSize: 12 }}>{linesLabel(c)}</span>
            <span className="actions">
              <button type="button" className="btn btn-sm btn-invisible" aria-label="Edit comment" onClick={() => setEditing(true)}>
                <PencilIcon size={16} />
              </button>
              <button type="button" className="btn btn-sm btn-invisible" aria-label="Delete comment" onClick={() => deleteComment(c.id)}>
                <TrashIcon size={16} />
              </button>
            </span>
          </div>
          {editing ? (
            <div className="comment-form" style={{ padding: '8px 0 0' }}>
              <CommentBox value={body} onChange={setBody} autoFocus />
              <div className="comment-form-actions">
                <button type="button" className="btn btn-sm" onClick={() => setEditing(false)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  onClick={() => {
                    updateComment(c.id, body)
                    setEditing(false)
                  }}
                >
                  Update comment
                </button>
              </div>
            </div>
          ) : (
            <Markdown source={c.body} className="mt-1" />
          )}
        </div>
      </div>
    </div>
  )
}
