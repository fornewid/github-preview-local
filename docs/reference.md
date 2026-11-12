# Reference measurements (github.com, November 2026)

gh-prv-local reproduces the **new "Files changed" experience** that github.com shows signed-in users
(on by default since 2026-01-22, URL `/pull/N/changes`). Signed-out visitors still get the classic
page, so the reference is captured with a signed-in Chrome profile (see
[design-sync.md](design-sync.md)): Chrome 1440×900, DPR 2, on
`https://github.com/webtoon/ReadMoreTextView/pull/127/changes`.

## Building blocks

| Part | github.com | gh-prv-local |
|---|---|---|
| Components (buttons, menus, dialogs, tree, page layout, header) | `@primer/react` CSS modules (`prc-*`), release matched by class hash: 38.42–38.45 | `@primer/react` **38.45.0** |
| Color tokens | Primer primitives light/dark themes | `@primer/primitives` **11.10.0** (0 differing tokens) |
| Diff table, file header, toolbar, comment box | GitHub's own CSS modules | `ui/src/styles/prv.css`, rewritten from the values below |
| Syntax highlighting | `pl-*` classes | starry-night with GitHub's grammars (`pl-*`) |
| UI font | `--fontStack-sansSerif` (`"Mona Sans VF", -apple-system, BlinkMacSystemFont, …`) — Mona Sans is **not loaded** signed in, so the system font renders | same stack, nothing bundled |
| Code font | `"Monaspace Neon", ui-monospace, SFMono-Regular, SF Mono, Menlo, …` (newer than primitives 11.10) — not loaded either; Chrome, Edge and Firefox skip `ui-monospace`, so code is **Menlo** on a Mac | same stack; the native window (WebKit, where `ui-monospace` is SF Mono) drops `ui-monospace` so it also draws Menlo |
| Text rendering | `body.text-rendering-optimize-speed` → `text-rendering: optimizeSpeed` (no kerning, no ligatures); `-webkit-font-smoothing` left at `auto` | same (`antialiased` drew thinner text than github.com on macOS) |

## Page

| Element | Value |
|---|---|
| Page padding | 32px (≥1012px), 24px (≥768px), 16px |
| PR header | Primer `PageHeader`: title 32px/40px weight 400, number weight 300 muted, edit `IconButton` 32px (no actions: *Merge status* is left out); description padding-top 8px (`StateLabel` 32px tall, summary muted, `BranchName` accent); navigation padding-top 16px |
| Tabs | 14px / 22.96px, padding 8px 12px, selected: `--bgColor-default`, 1px border, radius 6px 6px 0 0; `CounterLabel` margin-left 8px; diffstat right, padding-top 12px |
| Conversation / Commits | content as wide as `container-xl` (1216px inside its 32px padding) but left-aligned like the other tabs, so the header and tabs do not move between tabs (github.com centers it); conversation sidebar 320px (256px under 1012px) |
| Checks | check list a third of the width, details beside it |
| Side panel (Comments; github.com also has Overview and Merge status) | `PageLayout.Sidebar`, resizable (*Draggable pane splitter*: drag, arrow keys 3px, double-click resets): `clamp(450px, width, min(768px, max(450px, 100vw − d)))` with width 544px by default, d = 959px from 1280px, else 511px; plus 1px border, 1px divider, 1px → 484px at 1440, 547px from 1503px, 453px at 1280–1409. Like Primer, every window resize lowers the current width to the new maximum and widening does not raise it again (until a reload, drag or double-click). Sticky top 0, full height; header 49px (padding 8px). The page header runs up to it, the toolbar and diffs stop 16px before it |

## Files changed

| Element | Value |
|---|---|
| Toolbar | sticky top 0, height 60px, padding 16px 0, gap 8px, border-bottom 1px; small (28px) buttons: tree toggle, *All commits*, viewed progress (12px/18px), divider 28px, *Submit review* (primary), gear, divider, comments (with counter; github.com also has overview) |
| File tree | `PageLayout.Pane` start, 296px, resizable, sticky below the toolbar, divider 1px + 16px gap; filter `TextInput` 32px + filter `IconButton`; `TreeView` rows 32px; status icons `file-diff` (muted), `file-added` (success), `file-removed` (danger), `file-moved` |
| Diff list | gap 16px, content padding 16px 0 40px |
| File header | sticky top 58px, padding 6px 8px, min-height 42px, `--bgColor-muted`, radius 6px 6px 0 0; chevron, CODEOWNERS `shield-lock`, path (`code` 12px/18px, truncated at the start), copy, expand all; right: `+N -N` (12px semibold) + five 8px squares, *Viewed* button, comment, kebab |
| Binary file header | instead of the line counts, the change in size: `code` 12px/18px, padding 0 8px, `--fgColor-success` (or `--fgColor-danger` when smaller); 3 significant digits in steps of 1024 (`87.8 KB`, `-78 Bytes`, `-1.58 KB`) |
| Image file | github.com's image view (an iframe there): `--bgColor-muted`, padding 30px. Added or deleted: the image alone in a 1px `--borderColor-muted` box. Changed: *2-up* — two columns of at most 418px, 4px apart, *Deleted* / *Added* (12px bold, danger / success) 8px above 1px frames (`--borderColor-danger-emphasis` / `--borderColor-success-emphasis`), the smaller image centered, `W: 1594px \| H: 744px` (12px muted, labels bold) below; *Swipe* — both on one scale (at most 846px), the added image right of a handle (17px `--fgColor-muted` circles 14px above and 16px below); *Onion Skin* — the added image over the deleted one, opacity from a 272px slider (2px track, 12px thumb) 13px below. Mode bar: 36px, `--bgColor-muted`, border-top 1px, 12px labels with 5px padding and 1px separators, the current one bold with a 4px triangle on the bar's edge |
| Body | 1px border, radius 0 0 6px 6px; `table-layout: fixed` |

## Diff table

| Element | Value |
|---|---|
| Line height | 20px with *Compact line height* (default here), otherwise 24px; hunk rows min 24px |
| Columns | split: 44px · code · 44px · code; unified: 44px · 44px · code |
| Line number | mono 12px, centered; context lines `--fgColor-muted`, changed lines `--fgColor-default`; backgrounds `--diffBlob-{addition,deletion}Num-bgColor` |
| Code cell | padding 0 24px 0 20px (line height), mono 12px, `white-space: pre-wrap`; marker `+`/`-` absolute at 8px; backgrounds `--diffBlob-{addition,deletion}Line-bgColor`; empty side `--diffBlob-emptyLine-bgColor` |
| Word highlights | `.x` with `--diffBlob-{addition,deletion}Word-*`, rounded ends (`x-first`, `x-last`) |
| Hunk row | `--bgColor-accent-muted`; expander 44px (88px unified) × 24px on `--diffBlob-hunkNum-bgColor-rest`, hover `--bgColor-accent-emphasis`; labels *Expand file up from line N*, *Expand file down from line N*, *Expand file from line A to line B*; a first hunk without expander shows a kebab |
| Expanding | 20 lines per click; gaps ≤ 20 lines get one *expand all* button, larger ones down + up; the first hunk header stays, recomputed (`@@ -1,38 +1,45 @@`) |
| Add comment | blue 22px button over the start of the code cell on hover |

## Comments and review

| Element | Value |
|---|---|
| Comment box | 1px border, radius 6px; header 38px `--bgColor-muted` with *Write / Preview* tabs (padding 9px 16px) and the formatting `ActionBar` (heading, bold, italic, quote, code, link · lists, task list · mention, reference, suggestion); textarea 5 rows (121px) |
| Inline form | box with avatar + *Add a comment on line L18*, buttons *Cancel*, *Comment*, *Start a review* (*Add review comment* once a review is pending) |
| Finish your review | `AnchoredOverlay` 640px, title 14px semibold, body padding 16px, radio options 14px semibold + 12px captions (47px apart), footer *Cancel* / *Submit review* with ⌘⏎ hint |
| Settings menu | *Layout* (Unified / Split) · *Whitespace changes* submenu (Always show / Always hide / Hide for this diff only) · *Minimize comments* (`i`) · *Compact line height* |
| Commit picker | `Dialog` 480 × 640: *All commits*, *Changes since your last review*, *Select a range of commits* (checkbox list) |

## Widths and zoom

Measured with `tools/reference/breakpoints.mjs` (it finds each threshold to the pixel on
github.com and on a gh-prv-local export and prints them side by side; they are identical from 2560px to
320px, and with `--panel` from 1600px to 1012px with the side panel open). Widths are CSS pixels: browser zoom divides the window width (a 1440px window at 150% is
960px), and so does the native window's zoom (Cmd/Ctrl + `=` / `-` / `0`, Chrome's levels 25–500%).

| Window | github.com (and gh-prv-local) |
|---|---|
| ≥ 1076px | File tree beside the diffs (page container ≥ 1012px plus 2 × 32px padding; with the side panel docked the container has no right padding, so ≥ 1044px) |
| < 1076px | Tree hidden; the toggle opens a *Files* `Dialog` from the left (640px; fullscreen under 768px), closed by choosing a file. (github.com also moves its header actions, *Merge status*, above the title: `@container (width <= 1011px)`) |
| < 1012px | Page padding 24px; *viewed* word hidden (`0 / 2`); conversation sidebar 256px; checks title truncated at 150px. A side panel opened now is a `Dialog` from the right (640px; fullscreen under 768px) and stays a dialog if the window widens; a docked panel hides while the window is this narrow and comes back docked |
| < 816px | Toolbar container under 768px: *Submit review* → *Review*; tab diffstat hidden (container ≤ 768px) |
| ≤ 768px | Checks: list above the details |
| < 768px | Page padding 16px; toolbar dividers hidden; file header: chevron, path, icon-only *Viewed*, kebab — comment, copy, expand-all, stats and CODEOWNERS shield move into the kebab menu (*Comment on this file*, *Copy file name*, *Expand all lines*, *Owned by …*); *Finish your review* fullscreen; conversation: no avatar column (24px avatar in the comment header), sidebar and merge box below the timeline, merge icon hidden; Primer stacks the layout content |
| toolbar ≤ 544px (window ≤ 576px) | *All commits* moves into the toolbar's *More options* menu (*Comments*, *All commits*, *Settings* ›); settings and comments buttons follow under 544px |
| ≤ 544px | Commits: no timeline line, the list uses the full width |
| < 544px | Tab icons hidden; state label above the summary line; commits: SHA and its buttons fold into a kebab (*Copy full SHA for …*) |
| toolbar ≤ 500px (window ≤ 532px) | Viewed progress hidden |
| ≤ 335px | github.com's own header overflows horizontally; gh-prv-local does not |
| any | Branch names at most 35vw, truncated; title inline so the number and edit button follow its last line; long hunk headers wrap |

The JS side of these thresholds (dialogs, menus) is in `ui/src/layout.ts`; WebKit applies zoom to
media queries without a `change` event, so gh-prv-local also re-checks on `resize` and after zooming.

## Not reproduced on purpose

- github.com's global header and repository navigation (Code, Issues, …): gh-prv-local shows a small
  repository bar instead; the GitHub logo is not used.
- *Code*, *Preview* (feature preview), Copilot and *Paste, drop, or click to add files*: they act
  on github.com and have no local meaning.
- File menu items *View file / Edit file / Delete file*: replaced by *Open in editor* and
  *Copy file path*. The narrow commit menu has only *Copy full SHA* (no *View commit details* /
  *Browse repository at this point*).
- The pull request description (Overview panel, first comment of Conversation) and *Merge status*
  (header button and panel): a local review is about the changes and the comments. The description
  is written in *Confirm*; checks are in the Checks tab and with conflicts on Conversation.
- Conversation and Commits keep github.com's `container-xl` width but start at the same left edge
  as Files changed, so the title and the tabs do not move between tabs (github.com centers them).
- Find (Cmd/Ctrl + F): github.com leaves it to the browser; here the diffs are not all on the page
  and the native window has no find bar, so gh-prv-local has its own (a browser's colors).
