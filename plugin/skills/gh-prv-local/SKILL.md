---
name: gh-prv-local
description: Open a GitHub-style "Files changed" preview of the current branch (merge-base...HEAD, exactly like a pull request) in a native window, let the user review it with line comments, and get the review back as text. Use when the user wants to review changes before pushing or opening a PR, asks to "preview the PR", "review my branch", or wants to avoid slow remote CI/review round-trips. "Confirm" in the window pushes the branch and opens the PR.
---

# gh-prv-local — local pull request preview

`gh-prv-local` shows the current branch compared with its base branch the way GitHub's pull request
"Files changed" tab does (three-dot diff from the merge base, split/unified view, hide whitespace,
file tree, viewed files, expandable context). The user reviews it in a native window; nothing is
served over HTTP, and gh-prv-local talks to the repository's `origin` only: it fetches the base branch, looks
up an open pull request on origin's GitHub host, and pushes only when the user presses **Confirm**.

If the command is not found, the CLI is not installed: point the user to the install steps,
https://github.com/fornewid/github-preview-local#install

## Run it

The window stays open until the user submits a review, which can take longer than a foreground
command timeout. Run it **in the background** and wait for it to finish:

```bash
gh-prv-local                 # compare HEAD with the remote default branch (fetches the base first)
gh-prv-local --base develop  # compare with another base branch
gh-prv-local --uncommitted   # include uncommitted and untracked changes (great right after editing)
gh-prv-local --no-fetch      # skip `git fetch` of the base branch
gh-prv-local --format json   # machine-readable result
```

When it exits, its stdout is the review:

- `# Pull request preview: Changes requested` / `Review comments` — every comment with
  `path`, line(s), side, the code snippet and the reviewer's text. Address each one, then offer
  another round (`gh-prv-local` again).
- `# Pull request preview: Confirmed` — the branch was pushed and the pull request opened (URL
  included). Do not push again.
- `# Pull request preview: closed` — no feedback; do nothing.

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

If the machine has no display (SSH, containers), use `gh-prv-local export` and give the user the file path.
