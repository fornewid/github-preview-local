import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDownIcon, ChevronUpIcon, XIcon } from '@primer/octicons-react'
import { IconButton, TextInput } from '@primer/react'
import { useStore } from '../../store'
import { anchorFor } from '../../diff/util'
import { clearMatches, findMatches, matchCell, MAX_MATCHES, paintMatches, type FindMatch } from '../../find'
import type { FileDiff } from '../../types'

/**
 * Cmd/Ctrl+F: a find bar like a browser's (the window has none of its own, and an export's diffs
 * are not all on the page, so the browser's would miss most of them). Enter / Cmd+G go to the next
 * match, Shift+Enter / Shift+Cmd+G to the previous one, Escape closes.
 */
export function FindBar({ files }: { files: FileDiff[] }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const split = useStore((st) => st.settings.diffView === 'split')
  const whitespace = useStore((st) => st.settings.hideWhitespace)
  const matches = useMemo(() => (open ? findMatches(files, query, split, whitespace) : []), [open, files, query, split, whitespace])
  const current: FindMatch | null = matches[index] ?? null

  const go = useCallback((m: FindMatch | null) => {
    if (!m) return
    const { toggleCollapsed, loadDiff, fileUI } = useStore.getState()
    // Its file may be collapsed (or viewed), or a large or generated diff not loaded yet.
    if (fileUI[m.path]?.collapsed !== false) toggleCollapsed(m.path, false)
    if (!fileUI[m.path]?.load) loadDiff(m.path)
    const cell = matchCell(m)
    if (cell) return cell.scrollIntoView({ block: 'center' })
    // Not rendered yet: bring the file near, then center the line once it is drawn.
    document.getElementById(anchorFor(m.path))?.scrollIntoView()
    const start = performance.now()
    const wait = () => {
      const c = matchCell(m)
      if (c) c.scrollIntoView({ block: 'center' })
      else if (performance.now() - start < 3000) setTimeout(wait, 30)
    }
    setTimeout(wait, 30)
  }, [])

  // A new query starts from the first match at or below the top of the window, like a browser.
  useEffect(() => {
    if (!open || !matches.length) return
    const order = new Map(files.map((f, i) => [f.path, i]))
    const top = files.findIndex((f) => (document.getElementById(anchorFor(f.path))?.getBoundingClientRect().bottom ?? 0) > 80)
    const first = Math.max(0, matches.findIndex((m) => (order.get(m.path) ?? 0) >= top))
    setIndex(first)
    go(matches[first])
    // Only when the query (or what is searched) changes, not on every step.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matches])

  const step = useCallback(
    (by: number) => {
      if (!matches.length) return
      const next = (index + by + matches.length) % matches.length
      setIndex(next)
      go(matches[next])
    },
    [matches, index, go],
  )
  const close = useCallback(() => {
    setOpen(false)
    clearMatches()
  }, [])

  // Paint the matches on screen, again whenever more of the diff is drawn (batched with a timer:
  // WebKit holds animation frames back while the window is hidden).
  useEffect(() => {
    if (!open) return
    let timer = 0
    const paint = () => {
      clearTimeout(timer)
      timer = window.setTimeout(() => paintMatches(query, current), 16)
    }
    paint()
    const list = document.querySelector('.ChangesContent')
    const mo = new MutationObserver(paint)
    if (list) mo.observe(list, { childList: true, subtree: true })
    return () => {
      clearTimeout(timer)
      mo.disconnect()
    }
  }, [open, query, current])
  useEffect(() => clearMatches, [])

  const latest = useRef({ open, step })
  latest.current = { open, step }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return
      const key = e.key.toLowerCase()
      if (key === 'f' && !e.shiftKey) {
        e.preventDefault()
        setOpen(true)
        requestAnimationFrame(() => {
          input.current?.focus()
          input.current?.select()
        })
      } else if (key === 'g' && latest.current.open) {
        e.preventDefault()
        latest.current.step(e.shiftKey ? -1 : 1)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  if (!open) return null
  const count = matches.length >= MAX_MATCHES ? `${MAX_MATCHES}+` : String(matches.length)
  return (
    <div className="FindBar" role="search" aria-label="Find in changes">
      <TextInput
        ref={input}
        size="small"
        className="FindBar-input"
        aria-label="Find in changes"
        placeholder="Find in changes"
        value={query}
        autoFocus
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            step(e.shiftKey ? -1 : 1)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            close()
          }
        }}
        trailingVisual={query ? <span className="FindBar-count">{matches.length ? `${index + 1}/${count}` : '0/0'}</span> : undefined}
      />
      <IconButton size="small" variant="invisible" icon={ChevronUpIcon} aria-label="Previous match" disabled={!matches.length} onClick={() => step(-1)} />
      <IconButton size="small" variant="invisible" icon={ChevronDownIcon} aria-label="Next match" disabled={!matches.length} onClick={() => step(1)} />
      <IconButton size="small" variant="invisible" icon={XIcon} aria-label="Close find" onClick={close} />
    </div>
  )
}
