//! "Confirm": push the head branch and open (or update) the pull request with
//! the GitHub CLI. Works with github.com and GitHub Enterprise Server hosts.

use crate::git::Git;
use crate::model::{PublishRequest, PublishResult, Snapshot};
use std::io::Write;
use std::process::{Command, Stdio};

fn gh_repo(s: &Snapshot) -> Option<String> {
    let owner = s.repo.owner.as_deref()?;
    let host = s.repo.host.as_deref().unwrap_or("github.com");
    Some(format!("{host}/{owner}/{}", s.repo.name))
}

fn run(cmd: &mut Command, log: &mut String, stdin: Option<&str>) -> Result<String, String> {
    let shown = format!("{:?}", cmd).replace('"', "");
    log.push_str(&format!("$ {shown}\n"));
    let mut child = cmd
        .stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GH_PROMPT_DISABLED", "1")
        .spawn()
        .map_err(|e| format!("{shown}: {e}"))?;
    if let (Some(input), Some(mut pipe)) = (stdin, child.stdin.take()) {
        let _ = pipe.write_all(input.as_bytes());
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
    log.push_str(&stdout);
    log.push_str(&stderr);
    if out.status.success() {
        Ok(stdout)
    } else {
        Err(format!("{shown} failed:\n{}{}", stdout, stderr))
    }
}

pub fn publish(git: &Git, remote: Option<&str>, s: &Snapshot, req: &PublishRequest) -> Result<PublishResult, String> {
    let mut log = String::new();
    let remote = remote.ok_or("this repository has no remote to push to")?;
    let branch = &s.head.name;
    // Only the checked-out branch is pushed; a detached HEAD or another ref is rejected.
    if git.line(&["symbolic-ref", "--short", "-q", "HEAD"]).as_deref() != Some(branch.as_str()) {
        return Err(format!("`{branch}` is not the checked-out branch; check it out to publish it"));
    }
    if s.head.name == s.base.name {
        return Err(format!("the head branch `{branch}` is the base branch; create a feature branch first"));
    }
    let repo = gh_repo(s).ok_or("could not determine the GitHub repository from the remote URL")?;

    let mut push = git.cmd();
    push.args(["push", "--set-upstream", remote, &format!("{branch}:refs/heads/{branch}")]);
    run(&mut push, &mut log, None)?;

    // Reuse an open pull request for this branch if there is one.
    let mut view = Command::new("gh");
    view.current_dir(&git.root)
        .args(["pr", "view", branch, "-R", &repo, "--json", "number,url,state"]);
    if let Ok(out) = run(&mut view, &mut log, None) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&out) {
            if v.get("state").and_then(|s| s.as_str()) == Some("OPEN") {
                let url = v.get("url").and_then(|u| u.as_str()).unwrap_or_default().to_string();
                return Ok(PublishResult { url, created: false, draft: false, log });
            }
        }
    }

    let mut create = Command::new("gh");
    create.current_dir(&git.root).args([
        "pr",
        "create",
        "-R",
        &repo,
        "--base",
        &s.base.name,
        "--head",
        branch,
        "--title",
        &req.title,
        "--body-file",
        "-",
    ]);
    if req.draft {
        create.arg("--draft");
    }
    let out = run(&mut create, &mut log, Some(&req.body)).map_err(|e| {
        if e.contains("No such file") || e.contains("not found") && e.contains("gh") {
            format!("The GitHub CLI (`gh`) is required to open pull requests: https://cli.github.com\n\n{e}")
        } else {
            e
        }
    })?;
    let url = out
        .lines()
        .rev()
        .find(|l| l.trim_start().starts_with("http"))
        .unwrap_or("")
        .trim()
        .to_string();
    Ok(PublishResult { url, created: true, draft: req.draft, log })
}
