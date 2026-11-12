---
description: Preview this branch as a GitHub pull request, review it, and act on the feedback
argument-hint: "[--base <branch>] [--uncommitted] [--no-fetch] [--window | --browser=<name>]"
allowed-tools: Bash(gh-prv-local:*)
---

## Pull request preview review

!`gh-prv-local $ARGUMENTS`

## Your task

The block above is the result of the user's review in the pull request preview (browser tab or window).

- **Changes requested / Review comments**: address every comment (each lists the file, line and code it refers to). Make the code changes, commit them if the branch was committed before, then briefly summarize what you changed per comment. Offer to run `/gh-prv-local` again for another review round.
- **Confirmed**: the branch was pushed and the pull request URL is shown. Report it to the user. Do not push again.
- **Closed without a review**: acknowledge and continue; do not change anything.
- **Not opened**: no page opened the review within 10 minutes. Tell the user; offer to run it again.
- **`gh-prv-local: command not found`**: the CLI is not installed. Point the user to the install
  steps: https://github.com/fornewid/github-preview-local#install
