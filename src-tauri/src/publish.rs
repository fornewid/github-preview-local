//! "Confirm": push the head branch and open (or update) the pull request with
//! the GitHub CLI. Works with github.com and GitHub Enterprise Server hosts.

use crate::git::Git;
use crate::model::{ExistingPr, PublishRequest, PublishResult, Snapshot};
use std::process::Command;
use std::time::Duration;

const PUSH_TIMEOUT: Duration = Duration::from_secs(300);
const GH_TIMEOUT: Duration = Duration::from_secs(120);

fn gh_repo(s: &Snapshot) -> Option<String> {
    let owner = s.repo.owner.as_deref()?;
    let host = s.repo.host.as_deref().unwrap_or("github.com");
    Some(format!("{host}/{owner}/{}", s.repo.name))
}

fn run(mut cmd: Command, log: &mut String, stdin: Option<&str>, timeout: Duration) -> Result<String, String> {
    let shown = format!("{:?}", cmd).replace('"', "");
    log.push_str(&format!("$ {shown}\n"));
    cmd.env("GIT_TERMINAL_PROMPT", "0").env("GH_PROMPT_DISABLED", "1");
    let out = crate::proc::run(cmd, stdin, timeout).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            format!("{shown}: command not found")
        } else {
            format!("{shown}: {e}")
        }
    })?;
    log.push_str(&out.stdout);
    log.push_str(&out.stderr);
    if out.timed_out {
        return Err(format!("{shown} timed out after {}s", timeout.as_secs()));
    }
    if out.success() {
        Ok(out.stdout)
    } else {
        Err(format!("{shown} failed:\n{}{}", out.stdout, out.stderr))
    }
}

fn gh(git: &Git) -> Command {
    let mut c = Command::new("gh");
    c.current_dir(&git.root);
    c
}

/// Open pull requests from this repository's head branch (one API call).
/// Returns (PR into the previewed base, PR into another base). Pull requests
/// from forks that happen to use the same branch name are ignored.
fn find_prs(git: &Git, s: &Snapshot) -> Result<(Option<ExistingPr>, Option<(ExistingPr, String)>), String> {
    let repo = gh_repo(s).ok_or("could not determine the GitHub repository from the URL of `origin` (the only remote prv uses)")?;
    let mut log = String::new();
    let mut list = gh(git);
    list.args([
        "pr", "list", "-R", &repo, "--head", &s.head.name, "--state", "open", "--limit", "100", "--json",
        "number,url,isDraft,isCrossRepository,baseRefName",
    ]);
    let out = run(list, &mut log, None, GH_TIMEOUT)?;
    let v: serde_json::Value = serde_json::from_str(&out).map_err(|e| e.to_string())?;
    let mine: Vec<&serde_json::Value> = v
        .as_array()
        .into_iter()
        .flatten()
        .filter(|p| p.get("isCrossRepository").and_then(|b| b.as_bool()) == Some(false))
        .collect();
    let to_pr = |p: &serde_json::Value| ExistingPr {
        number: p.get("number").and_then(|n| n.as_u64()).unwrap_or(0),
        url: p.get("url").and_then(|u| u.as_str()).unwrap_or_default().to_string(),
        state: if p.get("isDraft").and_then(|d| d.as_bool()).unwrap_or(false) { "DRAFT".into() } else { "OPEN".into() },
    };
    let base_of = |p: &serde_json::Value| p.get("baseRefName").and_then(|b| b.as_str()).unwrap_or_default().to_string();
    let same = mine.iter().find(|p| base_of(p) == s.base.name).map(|p| to_pr(p));
    let other = mine.iter().find(|p| base_of(p) != s.base.name).map(|p| (to_pr(p), base_of(p)));
    Ok((same, other))
}

/// The open pull request from this branch into the previewed base, if any.
pub fn find_pr(git: &Git, s: &Snapshot) -> Result<Option<ExistingPr>, String> {
    let (same, other) = find_prs(git, s)?;
    if same.is_none() {
        if let Some((pr, base)) = other {
            return Err(format!(
                "pull request #{} from this branch targets `{base}`, not `{}`. Reopen with `prv --base {base}` to update it.",
                pr.number, s.base.name
            ));
        }
    }
    Ok(same)
}

pub fn publish(git: &Git, remote: Option<&str>, s: &Snapshot, req: &PublishRequest) -> Result<PublishResult, String> {
    let mut log = String::new();
    let remote = remote.ok_or("prv pushes to the `origin` remote only, and this repository has no `origin`")?;
    let branch = &s.head.name;
    // Only the checked-out branch is pushed; a detached HEAD or another ref is rejected.
    if git.line(&["symbolic-ref", "--short", "-q", "HEAD"]).as_deref() != Some(branch.as_str()) {
        return Err(format!("`{branch}` is not the checked-out branch; check it out to publish it"));
    }
    // Push exactly what was reviewed.
    if git.line(&["rev-parse", "HEAD"]).as_deref() != Some(s.head.sha.as_str()) {
        return Err("the branch has new commits since this preview was opened; reopen `prv` to review them".into());
    }
    if s.head.name == s.base.name {
        return Err(format!("the head branch `{branch}` is the base branch; create a feature branch first"));
    }
    if s.range.from.is_some() {
        return Err("switch back to “Show all changes” before confirming".into());
    }
    if s.mode == "worktree" {
        let status = git.run(&["status", "--porcelain"]).unwrap_or_default();
        if !status.trim().is_empty() {
            return Err(
                "this preview includes uncommitted changes (--uncommitted). Commit them first: only commits are pushed.".into(),
            );
        }
    }
    let repo = gh_repo(s).ok_or("could not determine the GitHub repository from the URL of `origin` (the only remote prv uses)")?;
    let host = s.repo.host.clone().unwrap_or_else(|| "github.com".into());

    // Fail before pushing when gh is missing or not logged in to this host.
    let mut auth = gh(git);
    auth.args(["auth", "status", "--hostname", &host]);
    run(auth, &mut log, None, GH_TIMEOUT).map_err(|e| {
        format!("The GitHub CLI (`gh`) must be installed and logged in to {host} (`gh auth login --hostname {host}`).\n\n{e}")
    })?;

    let existing = find_pr(git, s)?;

    // Push exactly the reviewed commit, even if the branch moved meanwhile.
    let mut push = git.cmd();
    push.args(["push", "--recurse-submodules=no", remote, &format!("{}:refs/heads/{branch}", s.head.sha)]);
    run(push, &mut log, None, PUSH_TIMEOUT)?;
    // What `push -u` would do; works without a remote-tracking ref (single-branch / shallow clones).
    for (key, value) in [("remote", remote.to_string()), ("merge", format!("refs/heads/{branch}"))] {
        let mut cfg = git.cmd();
        cfg.args(["config", &format!("branch.{branch}.{key}"), &value]);
        let _ = run(cfg, &mut log, None, GH_TIMEOUT);
    }

    if let Some(pr) = existing {
        let draft = pr.state == "DRAFT";
        log.push_str(&format!("Pushed to the existing pull request #{} (title and description unchanged).\n", pr.number));
        return Ok(PublishResult { url: pr.url, created: false, draft, log });
    }

    let mut create = gh(git);
    create.args([
        "pr", "create", "-R", &repo, "--base", &s.base.name, "--head", branch, "--title", &req.title, "--body-file", "-",
    ]);
    if req.draft {
        create.arg("--draft");
    }
    let out = run(create, &mut log, Some(&req.body), GH_TIMEOUT)?;
    let url = out
        .lines()
        .rev()
        .find(|l| l.trim_start().starts_with("http"))
        .unwrap_or("")
        .trim()
        .to_string();
    Ok(PublishResult { url, created: true, draft: req.draft, log })
}
