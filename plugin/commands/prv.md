---
description: Preview this branch as a GitHub pull request, review it, and act on the feedback
argument-hint: "[--base <branch>] [--uncommitted] [--no-fetch]"
allowed-tools: Bash(prv:*)
---

## Pull request preview review

!`prv $ARGUMENTS`

## Your task

The block above is the result of the user's review in the pull request preview window.

- **Changes requested / Review comments**: address every comment (each lists the file, line and code it refers to). Make the code changes, commit them if the branch was committed before, then briefly summarize what you changed per comment. Offer to run `/prv` again for another review round.
- **Confirmed**: the branch was pushed and the pull request URL is shown. Report it to the user. Do not push again.
- **Closed without a review**: acknowledge and continue; do not change anything.
