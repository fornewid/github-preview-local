#!/usr/bin/env bash
# End-to-end test of the native window's native-only features. The window clicks through the
# real UI (PRV_SELFTEST=flows):
#
#   - commit range: pick one commit in the commit picker, then All commits again
#   - local checks: Run all (a passing, a failing and a slow check), cancel the slow one
#   - Confirm: push the branch and open the pull request
#
#   scripts/native-selftest.sh [--prv path/to/prv]
#       Offline. The scratch repository's `origin` looks like github.com (so prv knows the
#       repository) but pushes to a local bare repository, and a stand-in `gh` records what prv
#       asks of the GitHub CLI and answers like it. Nothing leaves this machine.
#
#   scripts/native-selftest.sh --github OWNER/REPO [--prv path/to/prv]
#       Against a real repository you own (e.g. a private scratch one): pushes a new branch
#       `selftest-<time>` and opens a real pull request into `main` with your `gh` login.
#       The pull request is left open for you to look at.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PRV="$ROOT/src-tauri/target/release/prv"
GH_REPO=""
while [ $# -gt 0 ]; do
  case "$1" in
    --github) GH_REPO="$2"; shift 2 ;;
    --prv) PRV="$2"; shift 2 ;;
    *) echo "usage: $0 [--github OWNER/REPO] [--prv path/to/prv]" >&2; exit 2 ;;
  esac
done
[ -x "$PRV" ] || { echo "prv not found at $PRV (build it, or pass --prv)" >&2; exit 1; }
WORK=$(mktemp -d "${TMPDIR:-/tmp}/prv-selftest.XXXXXX")
trap 'cp "$WORK/out.txt" "${PRV_SELFTEST_KEEP:-/dev/null}" 2>/dev/null; rm -rf "$WORK"' EXIT

# --- Scratch repository: main + a branch with two commits, three local checks on main ---
git init -q -b main "$WORK/repo"
cd "$WORK/repo"
git config user.name "prv selftest"
git config user.email "selftest@example.invalid"
git config commit.gpgsign false
initial_commit() {
  printf 'Scratch repository for prv end-to-end tests.\n' > README.md
  cat > .prv.toml <<'TOML'
[[checks]]
name = "lint"
run = "echo lint ok"

[[checks]]
name = "unit"
run = "echo '1 test failed'; exit 1"

[[checks]]
name = "slow"
run = "echo started; sleep 31"
TOML
  git add -A && git commit -q -m "Initial commit"
}

if [ -n "$GH_REPO" ]; then
  REPO_ID="$GH_REPO"
  BRANCH="selftest-$(date +%Y%m%d-%H%M%S)"
  git remote add origin "https://github.com/$GH_REPO.git"
  if git ls-remote --exit-code -q origin refs/heads/main > /dev/null 2>&1; then
    git fetch -q origin main && git reset -q --hard origin/main
  else
    initial_commit && git push -q origin main
  fi
  git fetch -q origin main
  PATH_PREFIX=""
else
  REPO_ID="prv-selftest/sample"
  BRANCH="feature"
  git init -q --bare -b main "$WORK/remote.git"
  initial_commit
  git remote add origin "https://github.com/$REPO_ID.git"
  git config remote.origin.pushurl "$WORK/remote.git" # pushes stay on this machine
  git push -q origin main
  git update-ref refs/remotes/origin/main main
  # Stand-in GitHub CLI.
  mkdir "$WORK/bin"
  cat > "$WORK/bin/gh" <<'SH'
#!/bin/sh
printf '%s\n' "$*" >> "$PRV_GH_LOG"
case "$1 $2" in
  "auth status") echo "github.com: logged in (prv selftest)"; exit 0 ;;
  "pr list") echo "[]"; exit 0 ;;
  "pr create") cat > "$PRV_GH_LOG.body"; echo "https://github.com/prv-selftest/sample/pull/1"; exit 0 ;;
esac
echo "prv selftest gh: unexpected call: $*" >&2
exit 1
SH
  chmod +x "$WORK/bin/gh"
  export PRV_GH_LOG="$WORK/gh.log"
  PATH_PREFIX="$WORK/bin:"
fi
git remote set-head origin main
git checkout -q -b "$BRANCH"
# Code files (syntax highlighting is checked too); the branch name keeps every run's content new.
printf "export const a = '%s' // first\n" "$BRANCH" > a.js && git add a.js && git commit -q -m "Add a.js"
printf 'export function b() {\n  return "%s"\n}\n' "$BRANCH" > b.js && git add b.js && git commit -q -m "Add b.js"

# --- Run the window, collect what happened outside it, verify ---
# round 1: a new pull request; round 2 (GitHub only): one more commit, Confirm updates that one.
run_round() {
  local round=$1 expect_files=$2 expect_url=${3:-}
  local head_sha remote_sha pr_url pr_json leftover code
  head_sha=$(git rev-parse HEAD)
  set +e
  PATH="$PATH_PREFIX$PATH" PRV_SELFTEST=flows perl -e 'alarm 420; exec @ARGV' "$PRV" --no-fetch --base main --format json > "$WORK/out.txt" 2> "$WORK/err.txt"
  code=$?
  set -e
  if [ -n "$GH_REPO" ]; then
    remote_sha=$(git ls-remote origin "refs/heads/$BRANCH" | cut -f1)
    pr_url=$(node -e 'const t=require("fs").readFileSync(process.argv[1],"utf8");const m=/"url":\s*"([^"]+\/pull\/\d+)"/.exec(t);console.log(m?m[1]:"")' "$WORK/out.txt")
    pr_json=$([ -n "$pr_url" ] && gh pr view "$pr_url" --json number,url,state,isDraft,headRefName,baseRefName,title,headRefOid || echo '{}')
  else
    remote_sha=$(git --git-dir="$WORK/remote.git" rev-parse -q --verify "refs/heads/$BRANCH" || true)
    pr_json='{}'
  fi
  leftover=$(pgrep -f "sleep 31" || true)
  echo "== round $round"
  ROUND_URL=$(node - "$WORK" "$code" "$head_sha" "$remote_sha" "$leftover" "$REPO_ID" "$BRANCH" "${GH_REPO:+real}" "$pr_json" "$round" "$expect_files" "$expect_url" <<'JS'
const fs = require('fs')
const [work, code, headSha, remoteSha, leftover, repo, branch, real, prJson, round, expectFiles, expectUrl] = process.argv.slice(2)
const out = fs.readFileSync(`${work}/out.txt`, 'utf8')
const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '')
let failed = 0
const check = (name, ok, detail = '') => {
  if (!ok) failed++
  console.error(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? `: ${detail}` : ''}`)
}
// stdout: progress lines, the flows report (one line each), then the review result (pretty JSON).
const lines = out.split('\n')
let log = {}, result = {}, rest = 0
for (; rest < lines.length && lines[rest].startsWith('{"'); rest++) {
  try {
    const l = JSON.parse(lines[rest])
    if (l.stage || l.ok === false) log = l
  } catch {}
}
try { result = JSON.parse(lines.slice(rest).join('\n')) } catch {}
if (log.ok === false) console.error(`window reported: ${log.error}`)

const r = log.range ?? {}
const expectFile = /Add (\S+)$/.exec(r.subject ?? '')?.[1]
check('commit range: one commit shows only its file', expectFile && JSON.stringify(r.files) === JSON.stringify([expectFile]), JSON.stringify(r))
check('commit range: picker shows the commit', /^[0-9a-f]{7}$/.test(r.label ?? ''), r.label)
check('commit range: Confirm is blocked', r.confirmBlocked === true)
check('commit range: All commits again shows every file', JSON.stringify(r.allFilesAfter) === expectFiles, JSON.stringify(r.allFilesAfter))
check('commit range: picker back to "All commits"', r.labelAfter === 'All commits', r.labelAfter)

const c = log.checks ?? {}
const st = c.statuses ?? {}
check('checks: passing check succeeds', st.lint === 'success' && c.exitCodes?.lint === 0, JSON.stringify(c))
check('checks: failing check fails with its exit code', st.unit === 'failure' && c.exitCodes?.unit === 1, JSON.stringify(c))
check('checks: failing check log shows output and exit code', /1 test failed/.test(c.unitLog ?? '') && /exited with code 1/.test(c.unitLog ?? ''), c.unitLog)
check('checks: Cancel stops the slow check', st.slow === 'cancelled' && c.cancelMs < 5000, `${st.slow} after ${c.cancelMs}ms`)
check('checks: no process left behind', !leftover, `pids ${leftover}`)

check('Confirm: window exited normally', code === '0', `exit ${code}; ${read(`${work}/err.txt`).slice(-400)}`)
const url = result.publish?.url ?? ''
const urlRe = new RegExp(`^https://github\\.com/${repo.replace('/', '\\/')}/pull/\\d+$`)
if (round === 'update')
  check('Confirm: pushed to the open pull request (none created)', result.event === 'CONFIRM' && url === expectUrl && result.publish?.created === false, JSON.stringify(result.publish))
else
  check('Confirm: result says the pull request was created', result.event === 'CONFIRM' && urlRe.test(url) && result.publish?.created === true, JSON.stringify(result.publish))
check('Confirm: reviewed commit pushed to the remote branch', remoteSha === headSha, `${remoteSha} vs ${headSha}`)
if (real) {
  const pr = JSON.parse(prJson || '{}')
  check('GitHub: the pull request exists and is open', pr.url === url && pr.state === 'OPEN' && pr.isDraft === false, prJson)
  check(`GitHub: ${branch} into main`, pr.headRefName === branch && pr.baseRefName === 'main', prJson)
  check('GitHub: it points at the reviewed commit', pr.headRefOid === headSha, prJson)
  console.error(`pull request: ${url}`)
} else {
  const gh = read(`${work}/gh.log`)
  check('Confirm: checked gh login first', /^auth status --hostname github\.com$/m.test(gh), gh)
  check('Confirm: looked for an open pull request', new RegExp(`^pr list -R github\\.com/${repo} --head ${branch} --state open`, 'm').test(gh), gh)
  check('Confirm: gh pr create into main', new RegExp(`^pr create -R github\\.com/${repo} --base main --head ${branch} --title .+ --body-file -$`, 'm').test(gh), gh)
}
console.log(url)
process.exit(failed ? 1 : 0)
JS
  ) || FAILED=1
}

FAILED=0
run_round create '["a.js","b.js"]'
if [ -n "$GH_REPO" ] && [ -n "$ROUND_URL" ]; then
  printf 'export const c = 3\n' > c.js && git add c.js && git commit -q -m "Add c.js"
  run_round update '["a.js","b.js","c.js"]' "$ROUND_URL"
fi
[ "$FAILED" = 0 ] && echo "all passed" || { echo "some checks failed"; exit 1; }
