import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDownIcon, ChevronUpIcon, XIcon } from '@primer/octicons-react'
import { IconButton, TextInput } from '@primer/react'
import { useStore } from '../../store'
import { anchorFor } from '../../diff/util'
import { clearMatches, findMatches, matchCell, MAX_MATCHES, paintMatches, type FindMatch } from '../../find'
import type { FileDiff } from '../../types'

const MAC = /Mac|iPhone|iPad/.test(navigator.platform)
/** Cmd on a Mac (where Ctrl+F / Ctrl+G move the caret in text fields), Ctrl elsewhere. */
const mod = (e: KeyboardEvent) => (MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey) && !e.altKey
/** The letter; its key position only when the layout types no Latin letter there (Cyrillic, …). */
const letter = (e: KeyboardEvent, l: string) => {
  const key = e.key.toLowerCase()
  return key === l || (!/^[a-z]$/.test(key) && e.code === `Key${l.toUpperCase()}`)
}
const same = (a: FindMatch, b: FindMatch) => a.path === b.path && a.cell === b.cell && a.nth === b.nth

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
  const at = Math.min(index, matches.length - 1)
  const current: FindMatch | null = matches[at] ?? null

  // Waiting for a file to be drawn, to center its match; a newer step replaces it.
  const waiting = useRef(0)
  // The match last gone to, to find it again when the matches change for another reason.
  const selected = useRef<FindMatch | null>(null)
  const go = useCallback((m: FindMatch | undefined) => {
    clearTimeout(waiting.current)
    if (!m) return
    selected.current = m
    const { toggleCollapsed, loadDiff, fileUI } = useStore.getState()
    // Its file may be collapsed (or viewed), or a large or generated diff not loaded yet.
    if (fileUI[m.path]?.collapsed !== false) toggleCollapsed(m.path, false)
    if (!fileUI[m.path]?.load) loadDiff(m.path)
    const cell = matchCell(m)
    if (cell) return cell.scrollIntoView({ block: 'center' })
    document.getElementById(anchorFor(m.path))?.scrollIntoView()
    const until = performance.now() + 3000
    const wait = () => {
      const c = matchCell(m)
      if (c) c.scrollIntoView({ block: 'center' })
      else if (performance.now() < until) waiting.current = window.setTimeout(wait, 30)
    }
    waiting.current = window.setTimeout(wait, 30)
  }, [])

  // A new search (query or view) goes to the first match at or below the top of the window, once
  // typing pauses (each match it passes may open a file). Other changes, such as a file marked
  // viewed, keep the current match.
  const searched = useRef('')
  /** The first match at or below the top of the window (inside the file there, by its line). */
  const firstBelowTop = () => {
    const order = new Map(files.map((f, i) => [f.path, i]))
    const top = files.findIndex((f) => (document.getElementById(anchorFor(f.path))?.getBoundingClientRect().bottom ?? 0) > 80)
    const below = (m: FindMatch) => {
      const at = order.get(m.path) ?? 0
      if (at !== top) return at > top
      const cell = matchCell(m)
      return !cell || cell.getBoundingClientRect().top >= 80
    }
    const first = matches.findIndex(below)
    return first >= 0 ? first : 0
  }
  // The pending first jump of a new search; a step (Enter, Cmd+G) cancels it.
  const jump = useRef(0)
  useEffect(() => {
    if (!open) return
    const key = `${query}\n${split}\n${whitespace}`
    if (key === searched.current) {
      const keep = selected.current ? matches.findIndex((m) => same(m, selected.current!)) : -1
      if (keep >= 0) setIndex(keep)
      return
    }
    if (!matches.length) {
      searched.current = key
      return setIndex(0)
    }
    jump.current = window.setTimeout(() => {
      jump.current = 0
      // Done only once it happened, so a search interrupted by other changes is started again.
      searched.current = key
      const first = firstBelowTop()
      setIndex(first)
      go(matches[first])
    }, 250)
    return () => {
      clearTimeout(jump.current)
      jump.current = 0
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, matches])

  const step = useCallback(
    (by: number) => {
      if (!matches.length) return
      if (jump.current) {
        // Typed and stepped at once: that step is the search's first jump.
        clearTimeout(jump.current)
        jump.current = 0
        searched.current = `${query}\n${split}\n${whitespace}`
        const first = firstBelowTop()
        setIndex(first)
        return go(matches[first])
      }
      const next = (at + by + matches.length) % matches.length
      setIndex(next)
      go(matches[next])
    },
    [matches, at, go, query, split, whitespace],
  )
  const close = useCallback(() => {
    clearTimeout(waiting.current)
    searched.current = ''
    selected.current = null
    setOpen(false)
    clearMatches()
  }, [])

  // Paint the matches around the window, again when more of the diff is drawn or it scrolls.
  useEffect(() => {
    if (!open) return
    let timer = 0
    // A timer, not an animation frame: WebKit holds frames back while the window is hidden.
    const paint = () => {
      clearTimeout(timer)
      timer = window.setTimeout(() => paintMatches(query, current), 50)
    }
    paint()
    const list = document.querySelector('.ChangesContent')
    const mo = new MutationObserver(paint)
    if (list) mo.observe(list, { childList: true, subtree: true })
    window.addEventListener('scroll', paint, { passive: true })
    return () => {
      clearTimeout(timer)
      mo.disconnect()
      window.removeEventListener('scroll', paint)
    }
  }, [open, query, current])
  useEffect(
    () => () => {
      clearTimeout(waiting.current)
      clearMatches()
    },
    [],
  )

  const latest = useRef({ open, step })
  latest.current = { open, step }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!mod(e)) return
      if (letter(e, 'f') && !e.shiftKey) {
        // Not behind a modal dialog, which keeps the focus to itself.
        if (document.querySelector('[aria-modal="true"]')) return
        e.preventDefault()
        setOpen(true)
        setTimeout(() => {
          input.current?.focus()
          input.current?.select()
        })
      } else if (letter(e, 'g') && latest.current.open) {
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
        trailingVisual={query ? <span className="FindBar-count">{matches.length ? `${at + 1}/${count}` : '0/0'}</span> : undefined}
      />
      <IconButton size="small" variant="invisible" icon={ChevronUpIcon} aria-label="Previous match" disabled={!matches.length} onClick={() => step(-1)} />
      <IconButton size="small" variant="invisible" icon={ChevronDownIcon} aria-label="Next match" disabled={!matches.length} onClick={() => step(1)} />
      <IconButton size="small" variant="invisible" icon={XIcon} aria-label="Close find" onClick={close} />
    </div>
  )
}
