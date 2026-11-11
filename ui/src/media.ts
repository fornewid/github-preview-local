// Width thresholds of github.com's "Files changed" page, measured signed-in (see docs/reference.md,
// "Widths and zoom"); prv.css uses the same values. No imports, so the store can use them too.

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
 * Evaluated fresh each time: after the native window zooms, WebKit leaves an existing
 * MediaQueryList's `matches` stale (and sends no `change`), while a new one is correct.
 */
export function mediaMatches(query: string): boolean {
  return window.matchMedia(query).matches
}
