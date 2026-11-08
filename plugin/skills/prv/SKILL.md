---
name: prv
description: Open a GitHub-style "Files changed" preview of the current branch (merge-base...HEAD, exactly like a pull request) in a native window, let the user review it with line comments, and get the review back as text. Use when the user wants to review changes before pushing or opening a PR, asks to "preview the PR", "review my branch", or wants to avoid slow remote CI/review round-trips. "Confirm" in the window pushes the branch and opens the PR.
---

# prv — local pull request preview

`prv` shows the current branch compared with its base branch the way GitHub's pull request
"Files changed" tab does (three-dot diff from the merge base, split/unified view, hide whitespace,
file tree, viewed files, expandable context). The user reviews it in a native window; nothing is
served over HTTP and nothing is sent to GitHub unless they press **Confirm**.

## Run it

The window stays open until the user submits a review, which can take longer than a foreground
command timeout. Run it **in the background** and wait for it to finish:

```bash
prv                      # compare HEAD with the remote default branch (fetches the base first)
prv --base develop       # compare with another base branch
prv --uncommitted        # include uncommitted and untracked changes (great right after editing)
prv --no-fetch           # skip `git fetch` of the base branch
prv --format json        # machine-readable result
```

When it exits, its stdout is the review:

- `# Pull request preview: Changes requested` / `Review comments` — every comment with
  `path`, line(s), side, the code snippet and the reviewer's text. Address each one, then offer
  another round (`prv` again).
- `# Pull request preview: Confirmed` — the branch was pushed and the pull request opened (URL
  included). Do not push again.
- `# Pull request preview: closed` — no feedback; do nothing.

## Other commands

```bash
prv checks [--json] [name...]   # run local checks headless (exit 1 on failure)
prv list-checks                 # show configured / auto-detected checks
prv export [--open] [-o file]   # self-contained HTML preview (no server); for SSH / remote sessions
```

Checks come from `.prv.toml` in the repository root:

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
Makefile targets and pre-commit are detected. Check commands receive `PRV_BASE`, `PRV_HEAD`,
`PRV_MERGE_BASE` and `PRV_CHANGED_FILES` (newline-separated) in their environment.

Checks execute commands defined by the repository. Only run `prv checks` when the user asks for it or
the repository is trusted (e.g. the user's own project), never on an unfamiliar clone.

If the machine has no display (SSH, containers), use `prv export` and give the user the file path.
