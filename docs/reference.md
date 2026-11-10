# Reference measurements (github.com, November 2026)

prv reproduces the **new "Files changed" experience** that github.com shows signed-in users
(on by default since 2026-01-22, URL `/pull/N/changes`). Signed-out visitors still get the classic
page, so the reference is captured with a signed-in Chrome profile (see
[design-sync.md](design-sync.md)): Chrome 1440×900, DPR 2, on
`https://github.com/webtoon/ReadMoreTextView/pull/127/changes`.

## Building blocks

| Part | github.com | prv |
|---|---|---|
| Components (buttons, menus, dialogs, tree, page layout, header) | `@primer/react` CSS modules (`prc-*`), release matched by class hash: 38.42–38.45 | `@primer/react` **38.45.0** |
| Color tokens | Primer primitives light/dark themes | `@primer/primitives` **11.10.0** (0 differing tokens) |
| Diff table, file header, toolbar, comment box | GitHub's own CSS modules | `ui/src/styles/prv.css`, rewritten from the values below |
| Syntax highlighting | `pl-*` classes | starry-night with GitHub's grammars (`pl-*`) |
| UI font | `"Mona Sans VF", -apple-system, system-ui, "Segoe UI", …` — Mona Sans is **not loaded** signed in, so the system font renders | same stack, nothing bundled |
| Code font | `--fontStack-monospace` (`ui-monospace, SFMono-Regular, SF Mono, Menlo, …`) | same |

## Page

| Element | Value |
|---|---|
| Page padding | 32px (≥1012px), 24px (≥768px), 16px |
| PR header | Primer `PageHeader`: title 32px/40px weight 400, number weight 300 muted, edit `IconButton` 32px; actions (*Merge status*) margin-top 8px; description padding-top 8px (`StateLabel` 32px tall, summary muted, `BranchName` accent); navigation padding-top 16px |
| Tabs | 14px / 22.96px, padding 8px 12px, selected: `--bgColor-default`, 1px border, radius 6px 6px 0 0; `CounterLabel` margin-left 8px; diffstat right, padding-top 12px |
| Conversation / Commits | centered `container-xl` (1280px including 32px padding) |
| Side panel (Overview, Comments, Merge status) | `PageLayout.Sidebar`, 484px, sticky top 0, full height; header 49px (padding 8px); actions move above the title while open |

## Files changed

| Element | Value |
|---|---|
| Toolbar | sticky top 0, height 60px, padding 16px 0, gap 8px, border-bottom 1px; small (28px) buttons: tree toggle, *All commits*, viewed progress (12px/18px), divider 28px, *Submit review* (primary), gear, divider, overview, comments (with counter) |
| File tree | `PageLayout.Pane` start, 296px, resizable, sticky below the toolbar, divider 1px + 16px gap; filter `TextInput` 32px + filter `IconButton`; `TreeView` rows 32px; status icons `file-diff` (muted), `file-added` (success), `file-removed` (danger), `file-moved` |
| Diff list | gap 16px, content padding 16px 0 40px |
| File header | sticky top 58px, padding 6px 8px, min-height 42px, `--bgColor-muted`, radius 6px 6px 0 0; chevron, CODEOWNERS `shield-lock`, path (`code` 12px/18px, truncated at the start), copy, expand all; right: `+N -N` (12px semibold) + five 8px squares, *Viewed* button, comment, kebab |
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

## Not reproduced on purpose

- github.com's global header and repository navigation (Code, Issues, …): prv shows a small
  repository bar instead; the GitHub logo is not used.
- *Code*, *Preview* (feature preview), Copilot and *Paste, drop, or click to add files*: they act
  on github.com and have no local meaning.
- File menu items *View file / Edit file / Delete file*: replaced by *Open in editor* and
  *Copy file path*.
