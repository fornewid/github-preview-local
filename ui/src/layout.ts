// Responsive behaviour of github.com's "Files changed" page, measured signed-in (see
// docs/reference.md, "Widths and zoom"). CSS handles everything it can (`prv.css`, media and
// container queries with the same thresholds); these are for the parts that change what is
// rendered. All values are CSS pixels, so browser zoom and the native window's zoom behave alike.
import { useCallback, useLayoutEffect, useState, useSyncExternalStore, type RefObject } from 'react'

export const MEDIA = {
  /** Primer's narrow range: fullscreen dialogs, compact file headers. */
  narrow: '(max-width: calc(48rem - 0.02px))',
  /** The side panel is docked beside the page; below this it opens as a dialog. */
  dockedPanel: '(min-width: 1012px)',
  /**
   * The file tree sits beside the diffs while the page container (32px padding on each side at
   * this size) is at least 1012px wide; below it the tree opens as a dialog.
   */
  treePane: '(min-width: 1076px)',
}

/** Toolbar widths (its container query size) at which controls move into its overflow menu. */
export const TOOLBAR = {
  /** "All commits" moves into the overflow menu (and the menu button appears). */
  commits: 544,
  /** Below this, settings and the comments panel toggle move as well. */
  rest: 544,
}

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (cb: () => void) => {
      const m = window.matchMedia(query)
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
    () => window.matchMedia(query).matches,
    () => false,
  )
}

/** Content-box width of an element: the size its CSS container queries see. */
export function useContentWidth(ref: RefObject<HTMLElement | null>): number | null {
  const [width, setWidth] = useState<number | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return width
}

/* ---------------- Side panel width (Primer PageLayout.Sidebar, as configured on github.com) ---------------- */

export const SIDE_PANEL = { min: 450, default: 544, max: 768, storageKey: 'prv:side-panel-width' }

/** Largest width at this viewport: `min(768, max(450, viewport - diff))`, diff 959px from 1280px, else 511px. */
export function sidePanelMax(viewport = window.innerWidth) {
  const diff = viewport >= 1280 ? 959 : 511
  return Math.min(SIDE_PANEL.max, Math.max(SIDE_PANEL.min, viewport - diff))
}

export function clampSidePanel(width: number, viewport = window.innerWidth) {
  return Math.max(SIDE_PANEL.min, Math.min(width, sidePanelMax(viewport)))
}

/* ---------------- Native window zoom (browsers zoom by themselves) ---------------- */

/** Chrome's zoom levels. */
export const ZOOM_LEVELS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5]

export function nextZoom(current: number, dir: 1 | -1) {
  if (dir > 0) return ZOOM_LEVELS.find((z) => z > current + 1e-6) ?? ZOOM_LEVELS[ZOOM_LEVELS.length - 1]
  return [...ZOOM_LEVELS].reverse().find((z) => z < current - 1e-6) ?? ZOOM_LEVELS[0]
}
