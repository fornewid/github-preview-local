// Responsive behaviour of github.com's "Files changed" page, measured signed-in (see
// docs/reference.md, "Widths and zoom"). CSS handles everything it can (`prv.css`, media and
// container queries with the same thresholds); these are for the parts that change what is
// rendered. All values are CSS pixels, so browser zoom and the native window's zoom behave alike.
import { useCallback, useLayoutEffect, useState, useSyncExternalStore, type RefObject } from 'react'
import { create } from 'zustand'
import { useStore } from './store'

export const MEDIA = {
  /** Primer's narrow range: fullscreen dialogs, compact file headers. */
  narrow: '(max-width: calc(48rem - 0.02px))',
  /** The side panel is docked beside the page; below this it opens as a dialog. */
  dockedPanel: '(min-width: 1012px)',
  /**
   * The file tree sits beside the diffs while the page container is at least 1012px wide; below
   * that it opens as a dialog. The container has 32px padding on each side (1076px window) and
   * none on the right while the side panel is docked (1044px window).
   */
  treePane: '(min-width: 1076px)',
  treePaneWithPanel: '(min-width: 1044px)',
  /** Primer's --pane-max-width-diff steps from 511px to 959px here. */
  wide: '(min-width: 1280px)',
}

/**
 * The toolbar's overflow menu, by the toolbar's own width (its container query size): at 544px
 * and below "All commits" moves into the menu; under 544px settings and comments follow.
 * 0 = no menu, 1 = commits only, 2 = commits, comments and settings.
 */
export function toolbarOverflow(width: number): 0 | 1 | 2 {
  return width > 544 ? 0 : width === 544 ? 1 : 2
}

const lists = new Map<string, MediaQueryList>()
const mql = (query: string) => {
  let m = lists.get(query)
  if (!m) lists.set(query, (m = window.matchMedia(query)))
  return m
}

/**
 * Evaluated fresh each time: after the native window zooms, WebKit leaves an existing
 * MediaQueryList's `matches` stale (and sends no `change`), while a new one is correct.
 */
export function mediaMatches(query: string): boolean {
  return window.matchMedia(query).matches
}

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (cb: () => void) => {
      const m = mql(query)
      m.addEventListener('change', cb)
      // WebKit (the macOS window) applies zoom to CSS media queries without a `change` event.
      window.addEventListener('resize', cb)
      return () => {
        m.removeEventListener('change', cb)
        window.removeEventListener('resize', cb)
      }
    },
    [query],
  )
  return useSyncExternalStore(
    subscribe,
    () => mediaMatches(query),
    () => false,
  )
}

/** The side panel the user sees (a docked one hidden by a narrow window counts as closed). */
export function useVisiblePanel() {
  const panel = useStore((st) => st.panel)
  const dialog = useStore((st) => st.panelDialog)
  const wide = useMediaQuery(MEDIA.dockedPanel)
  return panel && (dialog || wide) ? panel : null
}

/** Whether the file tree belongs beside the diffs now (see MEDIA.treePane). */
export function useTreeBeside(): boolean {
  const panelDocked = useStore((st) => !!st.panel && st.tab === 'files' && !st.panelDialog)
  const wide = useMediaQuery(MEDIA.dockedPanel)
  return useMediaQuery(panelDocked && wide ? MEDIA.treePaneWithPanel : MEDIA.treePane)
}

export function treeBesideNow(): boolean {
  const st = useStore.getState()
  const docked = !!st.panel && st.tab === 'files' && !st.panelDialog && mediaMatches(MEDIA.dockedPanel)
  return mediaMatches(docked ? MEDIA.treePaneWithPanel : MEDIA.treePane)
}

/**
 * A class of an element's content-box width (the size its CSS container queries see). Only a
 * change of class re-renders, not every pixel of a window resize.
 */
export function useContentWidthClass<T>(ref: RefObject<HTMLElement | null>, classify: (width: number) => T): T | null {
  const [value, setValue] = useState<T | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setValue(classify(e.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref])
  return value
}

/* ---------------- Side panel width (Primer PageLayout.Sidebar, as configured on github.com) ---------------- */

export const SIDE_PANEL = { min: 450, default: 544, max: 768, storageKey: 'prv:side-panel-width' }

/** Largest width at this viewport: `min(768, max(450, viewport - diff))`, diff 959px from 1280px, else 511px. */
export function sidePanelMax(viewport = window.innerWidth) {
  // The same media query as the CSS, so fractional (zoomed) widths agree.
  const diff = mediaMatches(MEDIA.wide) ? 959 : 511
  return Math.min(SIDE_PANEL.max, Math.max(SIDE_PANEL.min, viewport - diff))
}

export function clampSidePanel(width: number, viewport = window.innerWidth) {
  return Math.max(SIDE_PANEL.min, Math.min(width, sidePanelMax(viewport)))
}

function storedSidePanelWidth(): number {
  try {
    const v = Number(localStorage.getItem(SIDE_PANEL.storageKey))
    if (Number.isFinite(v) && v > 0) return v
  } catch {
    /* storage may be unavailable for file:// pages */
  }
  return SIDE_PANEL.default
}

/** The side panel's current width (CSS clamps what is shown). */
export const useSidePanelWidth = create<{ width: number }>(() => ({ width: storedSidePanelWidth() }))

/** Drag end, arrow keys, double-click: kept across sessions (github.com keeps it per user). */
export function setSidePanelWidth(width: number) {
  useSidePanelWidth.setState({ width })
  try {
    localStorage.setItem(SIDE_PANEL.storageKey, String(Math.round(width)))
  } catch {
    /* storage may be unavailable for file:// pages */
  }
}

// Primer (usePaneWidth) lowers the current width to the new maximum on every window resize and
// does not raise it again when the window grows; github.com keeps the panel mounted, so this
// happens even while it is closed. Not saved: a reload starts from the saved width again.
if (typeof window !== 'undefined') {
  window.addEventListener('resize', () => {
    const max = sidePanelMax()
    if (useSidePanelWidth.getState().width > max) useSidePanelWidth.setState({ width: max })
  })
}

/* ---------------- Native window zoom (browsers zoom by themselves) ---------------- */

/** Chrome's zoom levels. */
export const ZOOM_LEVELS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5]

export function nextZoom(current: number, dir: 1 | -1) {
  if (dir > 0) return ZOOM_LEVELS.find((z) => z > current + 1e-6) ?? ZOOM_LEVELS[ZOOM_LEVELS.length - 1]
  return [...ZOOM_LEVELS].reverse().find((z) => z < current - 1e-6) ?? ZOOM_LEVELS[0]
}
