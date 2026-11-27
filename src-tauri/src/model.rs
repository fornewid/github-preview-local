//! Data model shared with the UI (see `ui/src/types.ts`).

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RefInfo {
    #[serde(rename = "ref")]
    pub reference: String,
    pub name: String,
    pub sha: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub sha: String,
    pub short: String,
    pub author: String,
    /// Author date (ISO-8601).
    pub date: String,
    /// Committer date (ISO-8601); GitHub shows and groups commits by it.
    pub committer_date: String,
    /// Names from `Co-authored-by:` trailers.
    pub co_authors: Vec<String>,
    pub subject: String,
    pub body: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    pub old_path: Option<String>,
    pub status: String,
    pub additions: u64,
    pub deletions: u64,
    pub binary: bool,
    pub generated: bool,
    pub submodule: bool,
    pub old_mode: Option<String>,
    pub new_mode: Option<String>,
    pub old_sha: Option<String>,
    pub new_sha: Option<String>,
    pub patch: String,
    pub patch_w: String,
    pub additions_w: u64,
    pub deletions_w: u64,
    pub too_large: bool,
    /// Blob sizes in bytes of a binary file (github.com shows the change in size instead of lines).
    pub old_size: Option<u64>,
    pub new_size: Option<u64>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    pub name: String,
    pub owner: Option<String>,
    pub root: String,
    pub host: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct RangeInfo {
    pub from: Option<String>,
    pub to: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExistingPr {
    pub number: u64,
    pub url: String,
    pub state: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub repo: RepoInfo,
    pub base: RefInfo,
    pub head: RefInfo,
    pub merge_base: String,
    pub range: RangeInfo,
    pub author: String,
    pub title: String,
    pub body: String,
    pub commits: Vec<Commit>,
    pub files: Vec<FileDiff>,
    pub mode: String,
    pub dirty: bool,
    pub warnings: Vec<String>,
    pub editorconfig: Option<String>,
    /// CODEOWNERS file of the base branch (path, contents), for the file header shield.
    pub codeowners: Option<(String, String)>,
    /// Files that conflict when merging head into base; None when unknown.
    pub conflicts: Option<Vec<String>>,
    pub existing_pr: Option<ExistingPr>,
    /// Confirm pushes the branch and opens the pull request (`--publish`); otherwise it only
    /// returns the approval.
    pub publish: bool,
    /// The base was not given (--base) but taken as the branch head was started from.
    pub guessed_base: bool,
    /// Head has nothing to review against base (no commits, no changes): why, and where to look.
    pub nothing: Option<NothingToReview>,
}

/// No commits and no changes: head is the base branch, or has nothing that is not on it.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NothingToReview {
    /// Head is the base branch itself (otherwise it is only up to date with it).
    pub on_base: bool,
    /// There are uncommitted changes, not part of this review (no `--uncommitted`).
    pub uncommitted: bool,
    /// Other worktrees of the repository whose branch has commits to review, most recent first.
    pub worktrees: Vec<WorktreeAhead>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeAhead {
    pub path: String,
    pub branch: String,
    /// Commits not on the base branch.
    pub ahead: usize,
}

impl NothingToReview {
    /// What happened and what to do, for the terminal and the agent.
    pub fn text(&self, head: &str, base: &str) -> String {
        let mut s = if self.on_base {
            format!("`{head}` is the base branch, so there is nothing to review.")
        } else {
            format!("`{head}` has no commits that are not on `{base}`, so there is nothing to review.")
        };
        if self.uncommitted {
            s.push_str(" There are uncommitted changes: `gh-prv-local --uncommitted` reviews them.");
        }
        s.push_str(" Run gh-prv-local in the folder of the branch to review (`gh-prv-local -C <path>`), or pass `--head <branch>`.");
        if !self.worktrees.is_empty() {
            s.push_str(" Worktrees with commits to review:");
            for w in &self.worktrees {
                let n = if w.ahead == 1 { "1 commit".to_string() } else { format!("{} commits", w.ahead) };
                s.push_str(&format!("\n  gh-prv-local -C '{}'   ({}, {n})", w.path.replace('\'', "'\\''"), w.branch));
            }
        }
        s
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CheckDef {
    pub name: String,
    pub run: String,
    pub source: String,
    pub timeout: Option<u64>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PublishRequest {
    pub title: String,
    pub body: String,
    pub draft: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PublishResult {
    pub url: String,
    pub created: bool,
    pub draft: bool,
    pub log: String,
}
