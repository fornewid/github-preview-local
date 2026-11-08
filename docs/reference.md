# Reference measurements (github.com, November 2026)

Measured with Chrome (headless, 1440×900, DPR 2) on
`https://github.com/webtoon/ReadMoreTextView/pull/127/files?diff=split&w=0`
using `tools/reference/capture.mjs`. Signed-out visitors get the classic
"Files changed" page (`/pull/N/changes` redirects to `/files`), which is what
prv reproduces.

All colors are Primer primitives tokens, so every GitHub theme (light, dark,
dimmed, high contrast, colorblind) works by switching
`<html data-color-mode data-light-theme data-dark-theme>`.

## Typography

| Element | Value |
|---|---|
| UI font | `--fontStack-system` → **Mona Sans VF**, -apple-system, … (bundled, SIL OFL) |
| Code font | `--fontStack-monospace` → ui-monospace, SFMono-Regular, SF Mono, Menlo, … 12px / 20px |
| PR title | 32px / 40px, weight 400; number weight 300, `--fgColor-muted` |
| Tabs | 14px / 23px, padding 8px 16px; selected tab has borders + radius 6px 6px 0 0 |
| Counter | 12px / 18px, weight 500, padding 0 6px, radius 2em, `--bgColor-neutral-muted` |
| Toolbar items | 12px / 18px, `--fgColor-muted`, bold part weight 600 |

## Layout

| Element | Value |
|---|---|
| Page padding | 32px (at ≥1280px) |
| Tab nav | margin 0 -16px 16px, border-bottom 1px `--borderColor-default`, height 40px |
| Toolbar (`.pr-toolbar`) | sticky top 0, height 60px, margin -16px -32px 0, padding 8px 32px |
| Sidebar | 296px, sticky top 60px, grid gap 16px |
| Tree filter input | height 32px, padding 5px 12px 5px 32px, radius 6px |
| Tree item | min-height 32px, padding 6px 8px, radius 6px |
| File box | border 1px `--borderColor-default`, radius 6px, margin-bottom 16px |
| File header | sticky top 60px, padding 4px 8px, `--bgColor-muted`, mono 12px / 32px |

## Diff table

| Element | Value |
|---|---|
| Split columns | `<col width=44><col><col width=44><col>`, `table-layout: fixed` |
| Unified number cells | `width: 1%; min-width: 50px` (auto layout) |
| Number cell | padding 0 10px, mono 12px / 20px, right aligned, `::before { content: attr(data-line-number) }` |
| Code cell | padding 0 10px 0 22px; marker `::before { content: attr(data-code-marker) }` at left 8px |
| Wrapping | `white-space: pre-wrap; overflow-wrap: anywhere` (long lines wrap) |
| Addition line / number / word | `--diffBlob-additionLine-bgColor` #dafbe1 / `-additionNum-` #aceebb / `-additionWord-` #aceebb |
| Deletion line / number / word | #ffebe9 / #ffcecb / #ffcecb |
| Empty cell (split) | `--diffBlob-emptyLine-bgColor` #f6f8fa |
| Hunk row | `--diffBlob-hunkLine-bgColor` #ddf4ff, padding 4px 10px 4px 22px, height 28px |
| Hunk number cell | `--diffBlob-hunkNum-bgColor-rest` #b6e3ff; hover `--bgColor-accent-emphasis` |
| Right split side | `border-left: 1px solid --borderColor-muted` |
| Word highlight | `.x` with `border-radius: .2em` on `x-first`/`x-last` |

## Behaviors

- **Diff**: `git diff merge-base(base, head)..head` (three-dot), rename detection, `-U3`.
- **Hide whitespace**: re-diff with `--ignore-all-space` (`?w=1`).
- **Expanders**: before the first hunk → *Expand Up*; between hunks → *Expand All* when
  the gap ≤ 20 lines, otherwise *Expand Down* + *Expand Up*; after the last hunk →
  *Expand Down*. Each click reveals 20 lines. Size-0 leading gap shows a static `...`.
- **Diffstat**: 5 blocks; `floor(add/total*5)` green, `floor(del/total*5)` red, rest gray
  (each change is one block when total ≤ 5).
- **Path truncation**: longer than 92 chars → `...` + last 89 chars.
- **Settings (gear)**: *Diff view* (Unified / Split, with pictures), *Hide whitespace*,
  *Apply and reload*.
- **Toolbar**: file tree toggle, *Changes from all commits* (commit / shift-click range),
  *File filter* (by extension, *Viewed files*, *Deleted files*), *Conversations*, gear.
- **File menu (…)**: *Show comments*, *View file*, *Edit file*, *Delete file*, *Open in desktop*.
- **Viewed**: collapses the file; resets when the file changes.
