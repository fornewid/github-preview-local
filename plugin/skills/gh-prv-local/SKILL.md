---
name: gh-prv-local
description: Open a GitHub-style "Files changed" preview of the current branch (merge-base...HEAD, exactly like a pull request) in a browser tab (or a native window), let the user review it with line comments, and get the review back as text. Use when the user wants to review changes before pushing or opening a PR, asks to "preview the PR", "review my branch", or wants to avoid slow remote CI/review round-trips. Review rounds repeat until the user presses "Confirm" (an approval: the agent then opens the PR the repository's way; with --publish gh-prv-local pushes and opens it).
---

# gh-prv-local — local pull request preview

`gh-prv-local` shows the current branch compared with its base branch the way GitHub's pull request
"Files changed" tab does (three-dot diff from the merge base, split/unified view, hide whitespace,
file tree, viewed files, expandable context). The user reviews it in a browser tab, served on
127.0.0.1 for this run only (or in a native window with `--window`), and gh-prv-local talks to the
repository's `origin` only: it fetches the base branch, and only with `--publish` looks up an open
pull request on origin's GitHub host and pushes when the user presses **Confirm**.

If the command is not found, the CLI is not installed: point the user to the install steps,
https://github.com/fornewid/github-preview-local#install

## Run it

It runs until the user submits a review (or closes the tab or window), which can take longer than
a foreground command timeout. Run it **in the background** and wait for it to finish. It prints the
page's address on stderr; if no browser opened (e.g. no display), give the user that address:

```bash
gh-prv-local                 # compare HEAD with the remote default branch (fetches the base first)
gh-prv-local --base develop  # compare with another base branch
gh-prv-local --uncommitted   # include uncommitted and untracked changes (great right after editing)
gh-prv-local --no-fetch      # skip `git fetch` of the base branch
gh-prv-local --window        # a native window instead of a browser tab (if the user prefers)
gh-prv-local --browser=chrome  # a given browser instead of the default one
gh-prv-local --publish       # Confirm pushes and opens the PR itself (only when the user asks for it)
gh-prv-local --format json   # machine-readable result
```

When it exits, its stdout is the review:

- `# Pull request preview: Changes requested` / `Review comments` — every comment with
  `path`, line(s), side, the code snippet and the reviewer's text. Address each one (commit if the
  branch was committed before), then open the next round without asking: run `gh-prv-local` again
  with the same options, in the background, and handle its result the same way. Ask the user
  instead only when a comment needs their decision.
- `# Pull request preview: Confirmed` — the user approved the branch and nothing was pushed: open
  the pull request the way the repository does it (its pull request procedure: title rules,
  description, labels, …; without one, push and `gh pr create`). With `--publish` the branch was
  pushed and the pull request opened (URL included): report it and do not push again.
- `# Pull request preview: closed` — no feedback; the rounds end; do nothing.
- `# Pull request preview: not opened` — no page opened the review within 10 minutes (no browser
  came up, e.g. over SSH, or nobody was there); the rounds end. Tell the user and offer to run it
  again (`--browser=none` prints the address to open).

## Other commands

```bash
gh-prv-local checks [--json] [name...]  # run local checks headless (exit 1 on failure)
gh-prv-local list-checks                # show configured / auto-detected checks
gh-prv-local export [--open] [-o file]  # self-contained HTML preview (no server); for SSH / remote sessions
```

Checks come from `.gh-prv-local.toml` in the repository root:

```toml
[[checks]]
name = "lint"
run = "./gradlew ktlintCheck"

[[checks]]
name = "test"
run = "npm test"
timeout = 600
```

Without a config, `package.json` scripts (lint, typecheck, test), `./gradlew check`, Cargo, Go,
Makefile targets and pre-commit are detected. Check commands receive `GH_PRV_LOCAL_BASE`, `GH_PRV_LOCAL_HEAD`,
`GH_PRV_LOCAL_MERGE_BASE` and `GH_PRV_LOCAL_CHANGED_FILES` (newline-separated) in their environment.

Checks execute commands defined by the repository. Only run `gh-prv-local checks` when the user asks for it or
the repository is trusted (e.g. the user's own project), never on an unfamiliar clone.

If the machine has no display (SSH, containers), run `GH_PRV_LOCAL_PORT=19514 gh-prv-local --browser=none` (the
user forwards that port and opens the printed address), or use `gh-prv-local export` and give the
user the file path.
