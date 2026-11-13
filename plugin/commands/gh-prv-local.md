---
description: Preview this branch as a GitHub pull request, review it, and act on the feedback
argument-hint: "[--base <branch>] [--uncommitted] [--no-fetch] [--window | --browser=<name>] [--publish]"
allowed-tools: Bash(gh-prv-local:*)
---

## Pull request preview review

!`gh-prv-local $ARGUMENTS`

## Your task

The block above is the result of the user's review in the pull request preview (browser tab or
window). Review rounds repeat until the user confirms or stops:

- **Changes requested / Review comments**: address every comment (each lists the file, line and
  code it refers to). Make the code changes, commit them if the branch was committed before, then
  briefly summarize what you changed per comment. Then open the next round yourself, without
  asking: run exactly `gh-prv-local $ARGUMENTS` again **in the background** (it waits for the
  user's review), wait for it to finish, and handle its result by these same rules. Ask the user
  instead of opening the next round when a comment cannot be addressed without their decision, or
  when a round brings back a comment you already addressed.
- **Confirmed**: the user approved the branch; nothing was pushed. Open the pull request the way
  this repository does it (its own pull request procedure: title rules, description, labels,
  milestone, assignees, …; without one, push the branch and run `gh pr create`), taking the review
  summary into account.
  - If the result says the branch was pushed and shows the pull request URL (`--publish`): report
    it. Do not push again.
- **Closed without a review**: the user stopped; acknowledge and continue; do not change anything.
- **Not opened**: no page opened the review within 10 minutes; the rounds end. Tell the user; offer
  to run it again.
- **`gh-prv-local: command not found`**: the CLI is not installed. Point the user to the install
  steps: https://github.com/fornewid/github-preview-local#install

With `--format json` the outcome is the `event` field: `REQUEST_CHANGES`, `COMMENT`, `CONFIRM`
(`publish` set when it pushed), `CLOSED` or `NOT_OPENED`.
