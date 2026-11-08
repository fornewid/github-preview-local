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
    pub email: String,
    pub date: String,
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
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    pub name: String,
    pub owner: Option<String>,
    pub root: String,
    pub remote_url: Option<String>,
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
    pub existing_pr: Option<ExistingPr>,
    pub generated_at: String,
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
