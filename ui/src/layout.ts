// Responsive behaviour of github.com's "Files changed" page, measured signed-in (see
// docs/reference.md, "Widths and zoom"). CSS handles everything it can (`prv.css`, media and
// container queries with the same thresholds); these are for the parts that change what is
// rendered. All values are CSS pixels, so browser zoom and the native window's zoom behave alike.
import { useLayoutEffect, useState, useSyncExternalStore, type RefObject } from 'react'
import { create } from 'zustand'
import { panelLayout, useStore } from './store'
import { MEDIA, mediaMatches } from './media'

/**
 * The toolbar's overflow menu, by the toolbar's own width (its container query size): at 544px
 * and below "All commits" moves into the menu; under 544px settings and comments follow.
 * 0 = no menu, 1 = commits only, 2 = commits, comments and settings.
 */
export function toolbarOverflow(width: number): 0 | 1 | 2 {
  return width > 544 ? 0 : width === 544 ? 1 : 2
}

// Width queries change only when the window resizes (or zooms: WebKit sends no event then, so
// useZoom sends one), and WebKit's MediaQueryList `change` events can be stale: re-evaluate on resize.
function onResize(cb: () => void) {
  window.addEventListener('resize', cb)
  return () => window.removeEventListener('resize', cb)
}

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    onResize,
    () => mediaMatches(query),
    () => false,
  )
}

/** The side panel the user sees (a docked one hidden by a narrow window counts as closed). */
export function useVisiblePanel() {
  const wide = useMediaQuery(MEDIA.dockedPanel)
  return useStore((st) => (panelLayout(st, wide).visible ? st.panel : null))
}

/** Whether the file tree belongs beside the diffs now (see MEDIA.treePane). */
export function useTreeBeside(): boolean {
  const wide = useMediaQuery(MEDIA.dockedPanel)
  const docked = useStore((st) => panelLayout(st, wide).docked)
  return useMediaQuery(docked ? MEDIA.treePaneWithPanel : MEDIA.treePane)
}

export function treeBesideNow(): boolean {
  const docked = panelLayout(useStore.getState(), mediaMatches(MEDIA.dockedPanel)).docked
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
export function sidePanelMax() {
  // The same media query as the CSS, so fractional (zoomed) widths agree.
  const diff = mediaMatches(MEDIA.wide) ? 959 : 511
  return Math.min(SIDE_PANEL.max, Math.max(SIDE_PANEL.min, window.innerWidth - diff))
}

export function clampSidePanel(width: number, max = sidePanelMax()) {
  return Math.max(SIDE_PANEL.min, Math.min(width, max))
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

/** The side panel's current width (CSS clamps what is shown) and the largest width this window allows. */
export const useSidePanelWidth = create<{ width: number; max: number }>(() => ({
  width: storedSidePanelWidth(),
  max: sidePanelMax(),
}))

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
window.addEventListener('resize', () => {
  const max = sidePanelMax()
  const { width, max: was } = useSidePanelWidth.getState()
  if (width > max || max !== was) useSidePanelWidth.setState({ width: Math.min(width, max), max })
})

/* ---------------- Native window zoom (browsers zoom by themselves) ---------------- */

/** Chrome's zoom levels. */
export const ZOOM_LEVELS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5]

export function nextZoom(current: number, dir: 1 | -1) {
  if (dir > 0) return ZOOM_LEVELS.find((z) => z > current + 1e-6) ?? ZOOM_LEVELS[ZOOM_LEVELS.length - 1]
  return [...ZOOM_LEVELS].reverse().find((z) => z < current - 1e-6) ?? ZOOM_LEVELS[0]
}
