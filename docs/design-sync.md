# Following github.com design changes

prv copies the look of github.com's pull request page. When GitHub ships a change, re-measure
the page, compare it with prv side by side and update prv. Everything below runs locally with
the installed Google Chrome; the tools live in `tools/reference` (`npm install` there once).

## 1. Sign in once

```bash
node tools/reference/login.mjs
```

This opens a plain Chrome window with a dedicated profile in `~/.cache/prv-reference/chrome-profile`.
Sign in to GitHub there (2FA and passkeys work). The window closes by itself. The capture tools
reuse this profile headlessly. Delete the folder to sign out for good.

The tools only read pages. They never submit, mark files viewed or change settings that GitHub
stores; anything they open (menus, panels, file tree) is closed again.

## 2. Capture github.com

```bash
cd tools/reference
PR=https://github.com/webtoon/ReadMoreTextView/pull/127     # any PR you can read
node snapshot.mjs  $PR ../../.ref/gh          # pages, full screenshots, structure + styles JSON
node states.mjs    $PR ../../.ref/gh-states   # menus, dialogs, panels, hover, expanded hunk
node states2.mjs   $PR ../../.ref/gh-states   # submenus, inline comment form, tree filter, merge panel
node dump.mjs "$PR/changes" '.DiffFileHeader, [class*="diff-file-header"]'   # exact values of one area
```

`.ref/` is ignored by git; captures contain your signed-in page.

## 3. Check the building blocks

```bash
node primer-version.mjs ../../.ref/gh/changes-split.html
```

It finds the `@primer/react` release whose CSS-module hashes match every `prc-*` class on the page,
and diffs github.com's theme tokens with the installed `@primer/primitives`. If the release moved,
update `ui/package.json` (`npm install --save-exact @primer/react@<version>`); if tokens differ,
update `@primer/primitives`.

## 4. Compare with prv

```bash
prv -C <repo of the same PR> --no-fetch export -o ../../.ref/prv.html
node local-states.mjs ../../.ref/prv.html ../../.ref/prv-states
python3 compare.py ../../.ref/gh-states ../../.ref/prv-states ../../.ref/out --align-gh 261.5 --align-prv 226
```

`breakpoints.mjs` checks the other dimension, window width: it finds every width at which the
page changes layout (tree and panels turning into dialogs, shortened labels, overflow menu, compact
file headers, …) on github.com and on the export, and prints both columns; any `✗` row needs a
change in `ui/src/styles/prv.css` (the "Widths and zoom" section) or `ui/src/layout.ts`:

```bash
node breakpoints.mjs $PR ../../.ref/prv.html --from 2560 --to 320
node breakpoints.mjs $PR ../../.ref/prv.html --from 1600 --to 1012 --panel   # side panel open
```

`typography.mjs` compares text, tab by tab: it pairs the texts both pages show (labels, commit
titles, file names, code lines) and prints each pair whose font differs — the font Chrome really
draws with, size, weight, line height, letter spacing, color, smoothing, text rendering — and the
icons whose color differs. Pairs of different elements that happen to share a text (the pull
request title and a commit title, for example) show up too; skip those:

```bash
node typography.mjs $PR ../../.ref/prv.html --width 1440
node typography.mjs $PR ../../.ref/prv.html --width 375
```

`compare.py` aligns both captures at the pull request toolbar (pass its top in CSS px for each
side: github.com has a taller global header) and writes side-by-side (`sbs-*.png`) and difference
(`diff-*.png`) images with the share of differing pixels. Text that is different by nature (title,
author, avatars) always shows up; look for shifted boxes, colors and missing controls.

## 5. Update prv

- Primer components (`ui/src/components/**`) pick up most changes through the version bump.
- GitHub's own parts are in `ui/src/styles/prv.css`; the values come from `dump.mjs`.
- Record new values in [reference.md](reference.md).
- Run `node tools/reference/ui-test.mjs <export.html>` (end-to-end checks of comments, settings,
  expanders, viewed, panels and review submission) and `PRV_SELFTEST=1 prv --no-fetch` (native
  window) before committing.
