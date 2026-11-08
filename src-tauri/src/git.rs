//! Git plumbing: computes the same comparison GitHub shows on a pull request's
//! "Files changed" tab — a three-dot diff between the merge base of the base
//! branch and the head.

use crate::model::*;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const MAX_PATCH_BYTES: usize = 3 * 1024 * 1024;
const MAX_BLOB_BYTES: usize = 5 * 1024 * 1024;

#[derive(Clone, Debug)]
pub struct Git {
    pub root: PathBuf,
}

impl Git {
    pub fn discover(cwd: &Path) -> Result<Git, String> {
        let out = Command::new("git")
            .arg("-C")
            .arg(cwd)
            .args(["rev-parse", "--show-toplevel"])
            .stdin(Stdio::null())
            .output()
            .map_err(|e| format!("failed to run git: {e}"))?;
        if !out.status.success() {
            return Err(format!(
                "not a git repository: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        Ok(Git { root: PathBuf::from(String::from_utf8_lossy(&out.stdout).trim()) })
    }

    pub fn cmd(&self) -> Command {
        let mut c = Command::new("git");
        c.arg("-C")
            .arg(&self.root)
            // Neutralize user diff settings so the output matches GitHub's defaults.
            .args([
                "-c", "core.quotepath=false",
                "-c", "color.ui=false",
                "-c", "diff.noprefix=false",
                "-c", "diff.mnemonicPrefix=false",
                "-c", "diff.algorithm=default",
                "-c", "diff.interHunkContext=0",
                "-c", "diff.relative=false",
            ])
            .stdin(Stdio::null());
        c
    }

    pub fn bytes(&self, args: &[&str]) -> Result<Vec<u8>, String> {
        let out = self.cmd().args(args).output().map_err(|e| format!("git {}: {e}", args.join(" ")))?;
        if !out.status.success() {
            return Err(format!(
                "git {} failed: {}",
                args.join(" "),
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        Ok(out.stdout)
    }

    pub fn run(&self, args: &[&str]) -> Result<String, String> {
        Ok(String::from_utf8_lossy(&self.bytes(args)?).into_owned())
    }

    pub fn line(&self, args: &[&str]) -> Option<String> {
        self.run(args).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
    }

    pub fn ok(&self, args: &[&str]) -> bool {
        self.cmd()
            .args(args)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }

    /// Runs git with a timeout; returns combined stderr on failure.
    pub fn run_timeout(&self, args: &[&str], timeout: Duration) -> Result<String, String> {
        let mut child = self
            .cmd()
            .args(args)
            .env("GIT_TERMINAL_PROMPT", "0")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| e.to_string())?;
        let start = Instant::now();
        loop {
            if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
                let mut out = String::new();
                let mut err = String::new();
                if let Some(mut o) = child.stdout.take() {
                    let _ = o.read_to_string(&mut out);
                }
                if let Some(mut e) = child.stderr.take() {
                    let _ = e.read_to_string(&mut err);
                }
                return if status.success() { Ok(out) } else { Err(err.trim().to_string()) };
            }
            if start.elapsed() > timeout {
                let _ = child.kill();
                return Err(format!("timed out after {}s", timeout.as_secs()));
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    pub fn git_path(&self, name: &str) -> PathBuf {
        let p = self.line(&["rev-parse", "--git-path", name]).unwrap_or_else(|| format!(".git/{name}"));
        let p = PathBuf::from(p);
        if p.is_absolute() { p } else { self.root.join(p) }
    }
}

#[derive(Clone, Debug, Default)]
pub struct Options {
    pub base: Option<String>,
    pub head: Option<String>,
    pub fetch: bool,
    pub uncommitted: bool,
}

/// The two tree-ish endpoints used for the diff and for file contents.
#[derive(Clone, Debug)]
pub struct DiffEnds {
    pub a: String,
    pub b: String,
}

pub fn pick_remote(git: &Git) -> Option<String> {
    let remotes = git.run(&["remote"]).ok()?;
    let list: Vec<&str> = remotes.lines().map(str::trim).filter(|s| !s.is_empty()).collect();
    if list.contains(&"origin") {
        Some("origin".into())
    } else {
        list.first().map(|s| s.to_string())
    }
}

/// Parses `https://host/owner/repo(.git)`, `git@host:owner/repo.git` and `ssh://git@host/owner/repo`.
pub fn parse_remote(url: &str) -> (Option<String>, Option<String>, Option<String>) {
    let u = url.trim().trim_end_matches('/').trim_end_matches(".git");
    let (host, path) = if let Some(rest) = u.split_once("://").map(|(_, r)| r) {
        let rest = rest.rsplit_once('@').map(|(_, r)| r).unwrap_or(rest);
        match rest.split_once('/') {
            Some((h, p)) => (h.split(':').next().unwrap_or(h).to_string(), p.to_string()),
            None => return (None, None, None),
        }
    } else if let Some((left, p)) = u.split_once(':') {
        let h = left.rsplit_once('@').map(|(_, h)| h).unwrap_or(left);
        (h.to_string(), p.to_string())
    } else {
        return (None, None, None);
    };
    let mut parts = path.rsplitn(2, '/');
    let name = parts.next().map(|s| s.to_string());
    let owner = parts.next().map(|s| s.to_string());
    (Some(host), owner, name)
}

fn resolve_base(git: &Git, remote: Option<&str>, arg: Option<&str>) -> Result<(String, String), String> {
    let strip = |r: &str| -> String {
        match remote {
            Some(rm) => r.strip_prefix(&format!("{rm}/")).unwrap_or(r).to_string(),
            None => r.to_string(),
        }
    };
    if let Some(a) = arg {
        if let Some(rm) = remote {
            if !a.starts_with(&format!("{rm}/")) && git.ok(&["rev-parse", "--verify", "-q", &format!("refs/remotes/{rm}/{a}")]) {
                return Ok((format!("{rm}/{a}"), a.to_string()));
            }
        }
        if !git.ok(&["rev-parse", "--verify", "-q", &format!("{a}^{{commit}}")]) {
            return Err(format!("base ref `{a}` not found"));
        }
        return Ok((a.to_string(), strip(a)));
    }
    if let Some(rm) = remote {
        if let Some(s) = git.line(&["symbolic-ref", "--short", "-q", &format!("refs/remotes/{rm}/HEAD")]) {
            return Ok((s.clone(), strip(&s)));
        }
        for b in ["main", "master", "develop", "trunk"] {
            if git.ok(&["rev-parse", "--verify", "-q", &format!("refs/remotes/{rm}/{b}")]) {
                return Ok((format!("{rm}/{b}"), b.to_string()));
            }
        }
    }
    for b in ["main", "master", "develop", "trunk"] {
        if git.ok(&["rev-parse", "--verify", "-q", &format!("refs/heads/{b}")]) {
            return Ok((b.to_string(), b.to_string()));
        }
    }
    Err("could not determine the base branch; pass --base <branch>".into())
}

/// Snapshot of the working tree (tracked + untracked, honoring .gitignore) as a tree object,
/// built in a temporary index so the user's staging area is untouched.
fn worktree_tree(git: &Git) -> Result<String, String> {
    let index = git.git_path("index");
    let tmp = git.git_path("prv-index.tmp");
    if let Some(dir) = tmp.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if index.exists() {
        std::fs::copy(&index, &tmp).map_err(|e| e.to_string())?;
    }
    let run = |args: &[&str]| -> Result<String, String> {
        let out = git
            .cmd()
            .args(args)
            .env("GIT_INDEX_FILE", &tmp)
            .output()
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    };
    let r = run(&["add", "-A"]).and_then(|_| run(&["write-tree"]));
    let _ = std::fs::remove_file(&tmp);
    r
}

struct RawEntry {
    old_mode: String,
    new_mode: String,
    old_sha: String,
    new_sha: String,
    status: char,
    path: String,
    old_path: Option<String>,
}

fn parse_raw(bytes: &[u8]) -> Vec<RawEntry> {
    let text = String::from_utf8_lossy(bytes);
    let mut toks = text.split('\0').filter(|t| !t.is_empty());
    let mut out = vec![];
    while let Some(meta) = toks.next() {
        let meta = meta.trim_start_matches(':');
        let f: Vec<&str> = meta.split(' ').collect();
        if f.len() < 5 {
            continue;
        }
        let status = f[4].chars().next().unwrap_or('M');
        let (old_path, path) = if status == 'R' || status == 'C' {
            let o = toks.next().unwrap_or_default().to_string();
            let n = toks.next().unwrap_or_default().to_string();
            (Some(o), n)
        } else {
            (None, toks.next().unwrap_or_default().to_string())
        };
        out.push(RawEntry {
            old_mode: f[0].into(),
            new_mode: f[1].into(),
            old_sha: f[2].into(),
            new_sha: f[3].into(),
            status,
            path,
            old_path,
        });
    }
    out
}

/// `--numstat -z` → path -> (additions, deletions, binary)
fn parse_numstat(bytes: &[u8]) -> HashMap<String, (u64, u64, bool)> {
    let text = String::from_utf8_lossy(bytes);
    let mut toks = text.split('\0');
    let mut out = HashMap::new();
    while let Some(t) = toks.next() {
        if t.is_empty() {
            continue;
        }
        let mut f = t.splitn(3, '\t');
        let a = f.next().unwrap_or("");
        let d = f.next().unwrap_or("");
        let p = f.next().unwrap_or("");
        let path = if p.is_empty() {
            let _old = toks.next();
            toks.next().unwrap_or("").to_string()
        } else {
            p.to_string()
        };
        let binary = a == "-" && d == "-";
        out.insert(path, (a.parse().unwrap_or(0), d.parse().unwrap_or(0), binary));
    }
    out
}

/// Splits `git diff` output into per-file chunks: (header line, full chunk text).
fn split_patch(text: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = vec![];
    for line in text.split_inclusive('\n') {
        if line.starts_with("diff --git ") {
            out.push((line.trim_end().to_string(), String::new()));
        }
        if let Some(last) = out.last_mut() {
            last.1.push_str(line);
        }
    }
    out
}

fn hunks_of(chunk: &str) -> &str {
    if chunk.starts_with("@@") {
        return chunk;
    }
    match chunk.find("\n@@") {
        Some(i) => &chunk[i + 1..],
        None => "",
    }
}

fn matches_header(header: &str, e: &RawEntry) -> bool {
    let old = e.old_path.as_deref().unwrap_or(&e.path);
    header == format!("diff --git a/{} b/{}", old, e.path) || (header.contains(&e.path) && header.contains(old))
}

/// Assigns patch chunks to raw entries (both are in the same order; with
/// `--ignore-all-space` some chunks may be missing).
fn assign(entries: &[RawEntry], chunks: Vec<(String, String)>) -> Vec<Option<String>> {
    let mut out = vec![None; entries.len()];
    let mut ci = 0;
    for (i, e) in entries.iter().enumerate() {
        let mut j = ci;
        while j < chunks.len() && j < ci + 8 {
            if matches_header(&chunks[j].0, e) {
                out[i] = Some(chunks[j].1.clone());
                ci = j + 1;
                break;
            }
            j += 1;
        }
    }
    out
}

fn is_generated_name(path: &str) -> bool {
    let base = path.rsplit('/').next().unwrap_or(path);
    const NAMES: &[&str] = &[
        "package-lock.json",
        "npm-shrinkwrap.json",
        "yarn.lock",
        "pnpm-lock.yaml",
        "bun.lockb",
        "bun.lock",
        "Cargo.lock",
        "composer.lock",
        "poetry.lock",
        "Pipfile.lock",
        "uv.lock",
        "go.sum",
        "Gemfile.lock",
        "Podfile.lock",
        "Package.resolved",
        "gradle.lockfile",
    ];
    NAMES.contains(&base)
        || base.ends_with(".min.js")
        || base.ends_with(".min.css")
        || base.ends_with(".js.map")
        || base.ends_with(".css.map")
        || base.ends_with(".pb.go")
        || base.ends_with("_pb2.py")
        || base.ends_with(".pb.swift")
        || base.ends_with(".g.dart")
        || base.ends_with(".freezed.dart")
        || base.ends_with(".designer.cs")
}

/// `linguist-generated` / `linguist-vendored` from .gitattributes (explicit `false` wins).
fn generated_attrs(git: &Git, paths: &[String]) -> HashMap<String, Option<bool>> {
    let mut out = HashMap::new();
    if paths.is_empty() {
        return out;
    }
    let child = git
        .cmd()
        .args(["check-attr", "-z", "--stdin", "linguist-generated"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn();
    let Ok(mut child) = child else { return out };
    if let Some(mut stdin) = child.stdin.take() {
        let input = paths.join("\0") + "\0";
        let _ = stdin.write_all(input.as_bytes());
    }
    let Ok(res) = child.wait_with_output() else { return out };
    let text = String::from_utf8_lossy(&res.stdout);
    let toks: Vec<&str> = text.split('\0').collect();
    for t in toks.chunks(3) {
        if t.len() < 3 {
            continue;
        }
        let v = match t[2] {
            "set" | "true" => Some(true),
            "unset" | "false" => Some(false),
            _ => None,
        };
        out.insert(t[0].to_string(), v);
    }
    out
}

fn humanize_branch(b: &str) -> String {
    let s = b.replace(['-', '_'], " ");
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => s,
    }
}

fn pr_template(root: &Path) -> Option<String> {
    for p in [
        ".github/pull_request_template.md",
        ".github/PULL_REQUEST_TEMPLATE.md",
        "pull_request_template.md",
        "PULL_REQUEST_TEMPLATE.md",
        "docs/pull_request_template.md",
        "docs/PULL_REQUEST_TEMPLATE.md",
    ] {
        if let Ok(s) = std::fs::read_to_string(root.join(p)) {
            return Some(s);
        }
    }
    let dir = root.join(".github/PULL_REQUEST_TEMPLATE");
    let mut entries: Vec<_> = std::fs::read_dir(dir).ok()?.flatten().map(|e| e.path()).collect();
    entries.sort();
    entries
        .into_iter()
        .find(|p| p.extension().map(|e| e == "md").unwrap_or(false))
        .and_then(|p| std::fs::read_to_string(p).ok())
}

pub fn now_rfc3339() -> String {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) as i64;
    let days = secs.div_euclid(86400);
    let rem = secs.rem_euclid(86400);
    // civil_from_days (Howard Hinnant)
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

pub struct Resolved {
    pub snapshot: Snapshot,
    pub ends: DiffEnds,
    pub remote: Option<String>,
}

pub fn snapshot(git: &Git, opts: &Options, range: &RangeInfo) -> Result<Resolved, String> {
    let mut warnings = vec![];
    let remote = pick_remote(git);
    let remote_url = remote.as_deref().and_then(|r| git.line(&["remote", "get-url", r]));
    let (host, owner, name) = remote_url.as_deref().map(parse_remote).unwrap_or((None, None, None));
    let repo_name = name.unwrap_or_else(|| {
        git.root.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "repository".into())
    });

    // Head
    let head_ref = opts.head.clone().unwrap_or_else(|| "HEAD".into());
    let head_sha = git
        .line(&["rev-parse", "--verify", &format!("{head_ref}^{{commit}}")])
        .ok_or_else(|| format!("head ref `{head_ref}` not found"))?;
    let head_name = if head_ref == "HEAD" {
        git.line(&["symbolic-ref", "--short", "-q", "HEAD"]).unwrap_or_else(|| head_sha[..7].to_string())
    } else {
        head_ref.clone()
    };

    // Base (+ fetch so the comparison matches what GitHub would show)
    let (base_ref, base_name) = resolve_base(git, remote.as_deref(), opts.base.as_deref())?;
    if opts.fetch {
        if let Some(rm) = remote.as_deref() {
            if base_ref.starts_with(&format!("{rm}/")) {
                let spec = format!("+refs/heads/{base_name}:refs/remotes/{rm}/{base_name}");
                if let Err(e) = git.run_timeout(&["fetch", "--quiet", "--no-tags", rm, &spec], Duration::from_secs(30)) {
                    warnings.push(format!(
                        "Could not fetch `{base_ref}` ({e}); comparing against the last fetched state. Use --no-fetch to skip fetching."
                    ));
                }
            }
        }
    }
    let base_sha = git
        .line(&["rev-parse", "--verify", &format!("{base_ref}^{{commit}}")])
        .ok_or_else(|| format!("base ref `{base_ref}` not found"))?;
    let merge_base = git
        .line(&["merge-base", &base_sha, &head_sha])
        .ok_or_else(|| format!("`{base_ref}` and `{head_name}` have no common history"))?;

    // Commits
    let log = git.run(&[
        "log",
        "--reverse",
        "--format=%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b%x1e",
        &format!("{merge_base}..{head_sha}"),
    ])?;
    let commits: Vec<Commit> = log
        .split('\x1e')
        .map(|r| r.trim_start_matches('\n'))
        .filter(|r| !r.trim().is_empty())
        .filter_map(|r| {
            let f: Vec<&str> = r.split('\x1f').collect();
            (f.len() >= 7).then(|| Commit {
                sha: f[0].into(),
                short: f[1].into(),
                author: f[2].into(),
                email: f[3].into(),
                date: f[4].into(),
                subject: f[5].into(),
                body: f[6].trim().into(),
            })
        })
        .collect();

    let dirty = git
        .run(&["status", "--porcelain", "--untracked-files=no"])
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);

    // Diff endpoints
    let mut mode = "committed";
    let ends = if let Some(from) = range.from.as_deref() {
        let a = git
            .line(&["rev-parse", "--verify", "-q", &format!("{from}^")])
            .unwrap_or_else(|| EMPTY_TREE.to_string());
        DiffEnds { a, b: range.to.clone().unwrap_or_else(|| from.to_string()) }
    } else if opts.uncommitted {
        mode = "worktree";
        DiffEnds { a: merge_base.clone(), b: worktree_tree(git)? }
    } else {
        DiffEnds { a: merge_base.clone(), b: head_sha.clone() }
    };
    if dirty && mode == "committed" && range.from.is_none() {
        warnings.push("You have uncommitted changes that are not shown. Run `prv --uncommitted` to include them.".into());
    }

    let files = diff_files(git, &ends)?;

    let author = git
        .line(&["config", "user.name"])
        .or_else(|| commits.last().map(|c| c.author.clone()))
        .unwrap_or_else(|| "you".into());
    let title = if commits.len() == 1 { commits[0].subject.clone() } else { humanize_branch(&head_name) };
    let body = pr_template(&git.root)
        .or_else(|| (commits.len() == 1).then(|| commits[0].body.clone()))
        .unwrap_or_default();

    let snapshot = Snapshot {
        repo: RepoInfo {
            name: repo_name,
            owner,
            root: git.root.to_string_lossy().into_owned(),
            remote_url,
            host,
        },
        base: RefInfo { reference: base_ref, name: base_name, sha: base_sha },
        head: RefInfo { reference: head_ref, name: head_name, sha: head_sha },
        merge_base,
        range: range.clone(),
        author,
        title,
        body,
        commits,
        files,
        mode: mode.into(),
        dirty,
        warnings,
        editorconfig: std::fs::read_to_string(git.root.join(".editorconfig")).ok(),
        existing_pr: None,
        generated_at: now_rfc3339(),
    };
    Ok(Resolved { snapshot, ends, remote })
}

fn diff_files(git: &Git, ends: &DiffEnds) -> Result<Vec<FileDiff>, String> {
    let (a, b) = (ends.a.as_str(), ends.b.as_str());
    let base = ["diff", "--no-color", "--no-ext-diff", "--find-renames"];
    let raw = git.bytes(&[&base[..], &["--raw", "-z", "--no-abbrev", a, b]].concat())?;
    let entries = parse_raw(&raw);
    let num = parse_numstat(&git.bytes(&[&base[..], &["--numstat", "-z", a, b]].concat())?);
    let num_w = parse_numstat(&git.bytes(&[&base[..], &["--numstat", "-z", "--ignore-all-space", a, b]].concat())?);
    let patch = String::from_utf8_lossy(&git.bytes(&[&base[..], &["--unified=3", a, b]].concat())?).into_owned();
    let patch_w =
        String::from_utf8_lossy(&git.bytes(&[&base[..], &["--unified=3", "--ignore-all-space", a, b]].concat())?)
            .into_owned();
    let chunks = assign(&entries, split_patch(&patch));
    let chunks_w = assign(&entries, split_patch(&patch_w));
    let attrs = generated_attrs(git, &entries.iter().map(|e| e.path.clone()).collect::<Vec<_>>());

    let mut files = vec![];
    for (i, e) in entries.iter().enumerate() {
        let (add, del, bin) = num.get(&e.path).cloned().unwrap_or((0, 0, false));
        let (add_w, del_w, _) = num_w.get(&e.path).cloned().unwrap_or((0, 0, false));
        let chunk = chunks[i].clone().unwrap_or_default();
        let chunk_w = chunks_w[i].clone().unwrap_or_default();
        let binary = bin || chunk.contains("\nBinary files ") || chunk.contains("\nGIT binary patch");
        let too_large = chunk.len() > MAX_PATCH_BYTES;
        let status = match e.status {
            'A' => "added",
            'D' => "deleted",
            'R' => "renamed",
            'C' => "copied",
            'T' => "typechange",
            _ => "modified",
        };
        let generated = match attrs.get(&e.path).cloned().flatten() {
            Some(v) => v,
            None => is_generated_name(&e.path),
        };
        let zero = |s: &str| s.chars().all(|c| c == '0');
        files.push(FileDiff {
            path: e.path.clone(),
            old_path: e.old_path.clone(),
            status: status.into(),
            additions: add,
            deletions: del,
            binary,
            generated,
            submodule: e.old_mode == "160000" || e.new_mode == "160000",
            old_mode: (!zero(&e.old_mode)).then(|| e.old_mode.clone()),
            new_mode: (!zero(&e.new_mode)).then(|| e.new_mode.clone()),
            old_sha: (!zero(&e.old_sha)).then(|| e.old_sha.clone()),
            new_sha: (!zero(&e.new_sha)).then(|| e.new_sha.clone()),
            patch: if binary || too_large { String::new() } else { hunks_of(&chunk).to_string() },
            patch_w: if binary || too_large { String::new() } else { hunks_of(&chunk_w).to_string() },
            additions_w: add_w,
            deletions_w: del_w,
            too_large,
        });
    }
    Ok(files)
}

/// Full file contents for highlighting and context expansion.
pub fn contents(git: &Git, ends: &DiffEnds, files: &[FileDiff], path: &str, side: &str) -> Option<String> {
    let f = files.iter().find(|f| {
        if side == "old" {
            f.old_path.as_deref().unwrap_or(&f.path) == path
        } else {
            f.path == path
        }
    })?;
    if f.binary || f.submodule {
        return None;
    }
    let sha = if side == "old" { f.old_sha.clone() } else { f.new_sha.clone() };
    let bytes = match sha {
        Some(s) => git.bytes(&["cat-file", "blob", &s]).ok()?,
        None => {
            let treeish = if side == "old" { &ends.a } else { &ends.b };
            git.bytes(&["show", &format!("{treeish}:{path}")]).ok()?
        }
    };
    if bytes.len() > MAX_BLOB_BYTES || bytes.iter().take(8000).any(|b| *b == 0) {
        return None;
    }
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

pub fn changed_paths(files: &[FileDiff]) -> String {
    files.iter().filter(|f| f.status != "deleted").map(|f| f.path.as_str()).collect::<Vec<_>>().join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_urls() {
        assert_eq!(
            parse_remote("https://github.com/webtoon/ReadMoreTextView.git"),
            (Some("github.com".into()), Some("webtoon".into()), Some("ReadMoreTextView".into()))
        );
        assert_eq!(
            parse_remote("git@ghe.example.com:team/app.git"),
            (Some("ghe.example.com".into()), Some("team".into()), Some("app".into()))
        );
        assert_eq!(
            parse_remote("ssh://git@ghe.example.com:2222/team/app"),
            (Some("ghe.example.com".into()), Some("team".into()), Some("app".into()))
        );
    }

    #[test]
    fn humanize() {
        assert_eq!(humanize_branch("fix/126-intrinsic-measurements"), "Fix/126 intrinsic measurements");
    }

    #[test]
    fn numstat_rename() {
        let m = parse_numstat(b"1\t2\t\0old.txt\0new.txt\0-\t-\timg.png\0");
        assert_eq!(m.get("new.txt"), Some(&(1, 2, false)));
        assert_eq!(m.get("img.png"), Some(&(0, 0, true)));
    }
}
