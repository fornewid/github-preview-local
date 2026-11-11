//! Git plumbing: computes the same comparison GitHub shows on a pull request's
//! "Files changed" tab — a three-dot diff between the merge base of the base
//! branch and the head.

use crate::model::*;
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// The empty tree id for this repository's hash algorithm (SHA-1 or SHA-256).
pub fn empty_tree(git: &Git) -> String {
    git.line(&["hash-object", "-t", "tree", "--stdin"])
        .unwrap_or_else(|| "4b825dc642cb6eb9a060e54bf8d69288fbee4904".into())
}
const MAX_PATCH_BYTES: usize = 3 * 1024 * 1024;
const MAX_BLOB_BYTES: usize = 5 * 1024 * 1024;

#[derive(Clone, Debug)]
pub struct Git {
    pub root: PathBuf,
    /// A partial clone whose missing objects would come from a remote other than `origin`:
    /// git may not fetch them on demand (gh-prv-local talks to `origin` only).
    no_lazy_fetch: bool,
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
        let mut git = Git { root: PathBuf::from(String::from_utf8_lossy(&out.stdout).trim()), no_lazy_fetch: false };
        git.no_lazy_fetch = foreign_promisor(&git);
        Ok(git)
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
                // No gpg runs for signed commits (a keyserver lookup would leave the machine).
                "-c", "log.showSignature=false",
            ])
            .stdin(Stdio::null());
        if self.no_lazy_fetch {
            c.env("GIT_NO_LAZY_FETCH", "1");
        }
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

    /// Runs git with a timeout; returns stderr on failure.
    pub fn run_timeout(&self, args: &[&str], timeout: Duration) -> Result<String, String> {
        let mut cmd = self.cmd();
        cmd.args(args).env("GIT_TERMINAL_PROMPT", "0");
        let out = crate::proc::run(cmd, None, timeout).map_err(|e| e.to_string())?;
        if out.timed_out {
            return Err(format!("timed out after {}s", timeout.as_secs()));
        }
        if out.success() { Ok(out.stdout) } else { Err(out.stderr.trim().to_string()) }
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

/// The only remote gh-prv-local talks to (fetching the base, pushing, the pull request on its GitHub host):
/// `origin`. Without one, the base is compared as it is locally and Confirm is unavailable.
pub fn pick_remote(git: &Git) -> Option<String> {
    let remotes = git.run(&["remote"]).ok()?;
    remotes.lines().map(str::trim).any(|r| r == "origin").then(|| "origin".to_string())
}

/// Whether a partial clone would fetch missing objects from a remote other than `origin`.
fn foreign_promisor(git: &Git) -> bool {
    // --type=bool normalizes yes/on/1/TRUE and a key without a value to "true".
    let promisors = git.run(&["config", "--type=bool", "--get-regexp", r"^remote\..*\.promisor$"]).unwrap_or_default();
    let named = promisors.lines().filter_map(|l| {
        let (key, value) = l.split_once(' ')?;
        let name = key.strip_prefix("remote.")?.strip_suffix(".promisor")?;
        (value.trim() == "true").then_some(name)
    });
    let partial = git.line(&["config", "extensions.partialClone"]);
    named.chain(partial.as_deref()).any(|r| r != "origin")
}

/// The GitHub host of an SSH remote, for `gh`. The host in the URL wins when gh is logged in to it
/// (`Host github.com` + `HostName ssh.github.com` is GitHub's SSH-over-443 setup); otherwise it
/// may be an alias from ~/.ssh/config (`git@github-work:me/repo`), resolved by `ssh -G` without
/// connecting anywhere.
fn ssh_github_host(host: String) -> String {
    let gh_knows = |h: &str| {
        Command::new("gh")
            .args(["auth", "token", "--hostname", h])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
    };
    if gh_knows(&host) {
        return host;
    }
    match ssh_hostname(&host).map(|h| if h == "ssh.github.com" { "github.com".to_string() } else { h }) {
        Some(real) if real != host => real,
        _ => host,
    }
}

/// `git version` is at least major.minor.
fn git_at_least(git: &Git, major: u32, minor: u32) -> bool {
    let v = git.line(&["version"]).unwrap_or_default();
    let mut nums = v.split_whitespace().nth(2).unwrap_or_default().split('.').map(|n| n.parse::<u32>().unwrap_or(0));
    (nums.next().unwrap_or(0), nums.next().unwrap_or(0)) >= (major, minor)
}

fn ssh_hostname(alias: &str) -> Option<String> {
    if alias.starts_with('-') {
        return None;
    }
    let out = Command::new("ssh").args(["-G", alias]).stdin(Stdio::null()).stderr(Stdio::null()).output().ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .find_map(|l| l.strip_prefix("hostname ").map(|h| h.trim().to_string()))
        .filter(|h| !h.is_empty())
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
    Err(match remote {
        Some(_) => "could not determine the base branch; pass --base <branch>".into(),
        None => "could not determine the base branch: there is no `origin` remote (the only remote gh-prv-local uses) and no local main/master branch; pass --base <branch>".into(),
    })
}

/// Snapshot of the working tree (tracked + untracked, honoring .gitignore) as a tree object,
/// built in a temporary index so the user's staging area is untouched.
fn worktree_tree(git: &Git) -> Result<String, String> {
    let index = git.git_path("index");
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0);
    let tmp = git.git_path(&format!("gh-prv-local-index-{}-{nanos}.tmp", std::process::id()));
    if let Some(dir) = tmp.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::remove_file(&tmp);
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
            // Do not trim: git does not quote trailing spaces in file names.
            out.push((line.strip_suffix('\n').unwrap_or(line).to_string(), String::new()));
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

/// Git's `quote_c_style` (with core.quotepath=false): quote only when needed.
fn quote_path(prefix: &str, p: &str) -> String {
    let needs = p.chars().any(|c| c == '"' || c == '\\' || (c as u32) < 0x20 || c as u32 == 0x7f);
    if !needs {
        return format!("{prefix}{p}");
    }
    let mut s = String::from("\"");
    s.push_str(prefix);
    for c in p.chars() {
        match c {
            '"' => s.push_str("\\\""),
            '\\' => s.push_str("\\\\"),
            '\x07' => s.push_str("\\a"),
            '\x08' => s.push_str("\\b"),
            '\t' => s.push_str("\\t"),
            '\n' => s.push_str("\\n"),
            '\x0b' => s.push_str("\\v"),
            '\x0c' => s.push_str("\\f"),
            '\r' => s.push_str("\\r"),
            c if (c as u32) < 0x20 || c as u32 == 0x7f => s.push_str(&format!("\\{:03o}", c as u32)),
            c => s.push(c),
        }
    }
    s.push('"');
    s
}

fn expected_header(e: &RawEntry) -> String {
    let old = e.old_path.as_deref().unwrap_or(&e.path);
    format!("diff --git {} {}", quote_path("a/", old), quote_path("b/", &e.path))
}

/// Assigns patch chunks to raw entries. Chunks are an ordered subset of the
/// entries (`--ignore-all-space` drops whitespace-only files; a typechange
/// yields two chunks for one entry), so headers are matched exactly while
/// scanning forward. Returns (full chunk text, hunks text) per entry.
fn assign(entries: &[RawEntry], chunks: Vec<(String, String)>) -> Vec<(String, String)> {
    let expected: Vec<String> = entries.iter().map(expected_header).collect();
    let mut out = vec![(String::new(), String::new()); entries.len()];
    let mut next = 0usize;
    let mut last: Option<usize> = None;
    for (header, chunk) in chunks {
        if let Some(l) = last {
            if expected[l] == header {
                out[l].0.push_str(&chunk);
                out[l].1.push_str(hunks_of(&chunk));
                continue;
            }
        }
        if let Some(j) = (next..entries.len()).find(|&j| expected[j] == header) {
            out[j] = (chunk.clone(), hunks_of(&chunk).to_string());
            last = Some(j);
            next = j + 1;
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
        std::thread::spawn(move || {
            let _ = stdin.write_all(input.as_bytes());
        });
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

/// PR template from the base branch (like GitHub), read from git objects so
/// symlinks in the working tree cannot point outside the repository.
fn pr_template(git: &Git, base_sha: &str) -> Option<String> {
    for p in [
        ".github/pull_request_template.md",
        ".github/PULL_REQUEST_TEMPLATE.md",
        "pull_request_template.md",
        "PULL_REQUEST_TEMPLATE.md",
        "docs/pull_request_template.md",
        "docs/PULL_REQUEST_TEMPLATE.md",
    ] {
        if let Some(s) = blob_text(git, base_sha, p) {
            return Some(s);
        }
    }
    let list = git.run(&["ls-tree", "--name-only", &format!("{base_sha}:.github/PULL_REQUEST_TEMPLATE")]).ok()?;
    let mut names: Vec<&str> = list.lines().filter(|n| n.ends_with(".md")).collect();
    names.sort();
    names.first().and_then(|n| blob_text(git, base_sha, &format!(".github/PULL_REQUEST_TEMPLATE/{n}")))
}

/// A regular file (not a symlink) at `<treeish>:<path>`, as text.
fn blob_text(git: &Git, treeish: &str, path: &str) -> Option<String> {
    let entry = git.run(&["ls-tree", treeish, "--", path]).ok()?;
    let mode = entry.split_whitespace().next()?;
    if mode != "100644" && mode != "100755" {
        return None;
    }
    let bytes = git.bytes(&["cat-file", "blob", &format!("{treeish}:{path}")]).ok()?;
    if bytes.len() > 256 * 1024 {
        return None;
    }
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/// Removes `user:password@` from https remote URLs.
fn strip_userinfo(url: &str) -> String {
    if let Some((scheme, rest)) = url.split_once("://") {
        if let Some((auth, host)) = rest.split_once('@') {
            if !auth.contains('/') && (scheme == "https" || scheme == "http") {
                return format!("{scheme}://{host}");
            }
        }
    }
    url.to_string()
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
    if git.no_lazy_fetch && !git_at_least(git, 2, 44) {
        warnings.push(
            "This partial clone gets missing objects from a remote other than `origin`; git before 2.44 cannot be kept from fetching them while gh-prv-local reads the diff.".into(),
        );
    }
    let remote = pick_remote(git);
    let remote_url = remote.as_deref().and_then(|r| git.line(&["remote", "get-url", r])).map(|u| strip_userinfo(&u));
    let (host, owner, name) = remote_url.as_deref().map(parse_remote).unwrap_or((None, None, None));
    let ssh = remote_url.as_deref().is_some_and(|u| !u.contains("://") || u.starts_with("ssh://") || u.starts_with("git+ssh://"));
    let host = match host {
        Some(h) if ssh => Some(ssh_github_host(h)),
        h => h,
    };
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
                // The base branch from origin only: no submodules (their hosts), no bundle URIs.
                let fetch = [
                    "-c", "transfer.bundleURI=false", "-c", "fetch.bundleURI=", "fetch", "--quiet", "--no-tags",
                    "--no-recurse-submodules", rm, spec.as_str(),
                ];
                if let Err(e) = git.run_timeout(&fetch, Duration::from_secs(30)) {
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
        "--format=%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%cn%x1f%cI%x1f%(trailers:key=Co-authored-by,valueonly,separator=%x1d)%x1f%s%x1f%b%x1e",
        &format!("{merge_base}..{head_sha}"),
    ])?;
    let commits: Vec<Commit> = log
        .split('\x1e')
        .map(|r| r.trim_start_matches('\n'))
        .filter(|r| !r.trim().is_empty())
        .filter_map(|r| {
            let f: Vec<&str> = r.split('\x1f').collect();
            (f.len() >= 10).then(|| Commit {
                sha: f[0].into(),
                short: f[1].into(),
                author: f[2].into(),
                email: f[3].into(),
                date: f[4].into(),
                committer: f[5].into(),
                committer_date: f[6].into(),
                co_authors: co_authors(f[7]),
                subject: f[8].into(),
                body: f[9].trim().into(),
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
            .unwrap_or_else(|| empty_tree(git));
        DiffEnds { a, b: range.to.clone().unwrap_or_else(|| from.to_string()) }
    } else if opts.uncommitted {
        mode = "worktree";
        DiffEnds { a: merge_base.clone(), b: worktree_tree(git)? }
    } else {
        DiffEnds { a: merge_base.clone(), b: head_sha.clone() }
    };
    if dirty && mode == "committed" && range.from.is_none() {
        warnings.push("You have uncommitted changes that are not shown. Run `gh-prv-local --uncommitted` to include them.".into());
    }

    let files = diff_files(git, &ends).map_err(|e| {
        if git.no_lazy_fetch {
            format!("{e}\n\nThis partial clone gets missing objects from a remote other than `origin`, which gh-prv-local does not contact. Fetch them first (for example `git fetch` from that remote), then reopen gh-prv-local.")
        } else {
            e
        }
    })?;

    let author = git
        .line(&["config", "user.name"])
        .or_else(|| commits.last().map(|c| c.author.clone()))
        .unwrap_or_else(|| "you".into());
    let title = if commits.len() == 1 { commits[0].subject.clone() } else { humanize_branch(&head_name) };
    let body = pr_template(git, &base_sha)
        .or_else(|| (commits.len() == 1).then(|| commits[0].body.clone()))
        .unwrap_or_default();

    let editorconfig = blob_text(git, &head_sha, ".editorconfig");
    // GitHub reads CODEOWNERS from the base branch.
    let codeowners = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"]
        .iter()
        .find_map(|p| blob_text(git, &base_sha, p).map(|t| (p.to_string(), t)));
    // Committed changes only: uncommitted work is not part of the merge.
    let conflicts = if range.from.is_none() && !opts.uncommitted { merge_conflicts(git, &base_sha, &head_sha) } else { None };
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
        editorconfig,
        codeowners,
        conflicts,
        existing_pr: None,
        generated_at: now_rfc3339(),
    };
    Ok(Resolved { snapshot, ends, remote })
}

/// Names from `Co-authored-by: Name <email>` trailer values (separated by \x1d), one per email
/// address, like GitHub shows one avatar per account.
fn co_authors(trailers: &str) -> Vec<String> {
    let mut out: Vec<(String, String)> = Vec::new();
    for t in trailers.split('\x1d') {
        let mut it = t.splitn(2, '<');
        let name = it.next().unwrap_or("").trim();
        let email = it.next().unwrap_or("").trim_end_matches('>').trim().to_lowercase();
        let key = if email.is_empty() { name.to_lowercase() } else { email };
        if !name.is_empty() && !out.iter().any(|(k, _)| *k == key) {
            out.push((key, name.to_string()));
        }
    }
    out.into_iter().map(|(_, n)| n).collect()
}

/// Paths that conflict when merging `head` into `base` (empty when it merges cleanly).
/// Uses `git merge-tree --write-tree` (git 2.38+), which does not touch the work tree or index;
/// the objects it writes go to a throwaway object directory, so the repository stays unchanged.
fn merge_conflicts(git: &Git, base: &str, head: &str) -> Option<Vec<String>> {
    type Cache = std::sync::Mutex<std::collections::HashMap<(String, String), Option<Vec<String>>>>;
    static CACHE: std::sync::OnceLock<Cache> = std::sync::OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    let key = (base.to_string(), head.to_string());
    if let Some(hit) = cache.lock().ok().and_then(|c| c.get(&key).cloned()) {
        return hit;
    }
    let objects = git.line(&["rev-parse", "--path-format=absolute", "--git-path", "objects"])?;
    let scratch = git.line(&["rev-parse", "--path-format=absolute", "--git-path", crate::STATE_DIR])?;
    std::fs::create_dir_all(&scratch).ok()?;
    remove_stale_merge_objects(std::path::Path::new(&scratch));
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    // Private, fresh directory inside the repository's git dir (not a shared temp dir).
    let tmp = std::path::Path::new(&scratch).join(format!("merge-objects-{}-{nanos}", std::process::id()));
    let mut builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(&tmp).ok()?;
    // Alternates are separated by ':' (';' on Windows); a C-quoted entry may contain them.
    let quote = |p: &str| format!("\"{}\"", p.replace('\\', "\\\\").replace('"', "\\\""));
    let sep = if cfg!(windows) { ";" } else { ":" };
    let mut alternates = std::ffi::OsString::from(quote(&objects));
    // Kept as an OsString: an existing value need not be UTF-8.
    if let Some(existing) = std::env::var_os("GIT_ALTERNATE_OBJECT_DIRECTORIES") {
        if !existing.is_empty() {
            alternates.push(sep);
            alternates.push(existing);
        }
    }
    let mut cmd = git.cmd();
    cmd.env("GIT_OBJECT_DIRECTORY", &tmp)
        .env("GIT_ALTERNATE_OBJECT_DIRECTORIES", &alternates)
        .args(["merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", base, head]);
    let out = crate::proc::run(cmd, None, std::time::Duration::from_secs(30));
    let _ = std::fs::remove_dir_all(&tmp);
    let out = out.ok()?;
    if out.timed_out {
        // Not cached: a slow moment should not stick for the whole session.
        return None;
    }
    let result = parse_merge_tree(out.code, &out.stdout);
    // Only answers are cached; "unknown" (an error) is asked again next time.
    if result.is_some() {
        if let Ok(mut c) = cache.lock() {
            c.insert(key, result.clone());
        }
    }
    result
}

/// `git merge-tree --write-tree --name-only -z` output: the tree id, then (exit code 1) the
/// conflicted paths, NUL separated. Anything else is an error, e.g. exit code 1 with no tree id
/// for "not something we can merge": unknown, never "no conflicts".
fn parse_merge_tree(code: Option<i32>, stdout: &str) -> Option<Vec<String>> {
    let mut parts = stdout.split('\0').filter(|p| !p.is_empty());
    let tree = parts.next()?.trim();
    if !matches!(tree.len(), 40 | 64) || !tree.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    match code {
        Some(0) => Some(vec![]),
        Some(1) => {
            let mut paths: Vec<String> = parts.map(|p| p.to_string()).collect();
            paths.dedup();
            Some(paths)
        }
        _ => None,
    }
}

/// Throwaway object directories that an interrupted run left behind (older than an hour, so a
/// merge check running right now in another gh-prv-local is never touched).
fn remove_stale_merge_objects(scratch: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(scratch) else { return };
    for e in entries.flatten() {
        let old = e
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age > std::time::Duration::from_secs(3600));
        if old && e.file_name().to_string_lossy().starts_with("merge-objects-") {
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
}

fn diff_files(git: &Git, ends: &DiffEnds) -> Result<Vec<FileDiff>, String> {
    let (a, b) = (ends.a.as_str(), ends.b.as_str());
    // Like github.com: the stored content, never a local external diff or textconv program.
    let base = ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--find-renames", "--src-prefix=a/", "--dst-prefix=b/"];
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
        let (chunk, hunks) = &chunks[i];
        let (_, hunks_w) = &chunks_w[i];
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
            patch: if binary || too_large { String::new() } else { hunks.clone() },
            patch_w: if binary || too_large { String::new() } else { hunks_w.clone() },
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
            f.status != "added" && f.old_path.as_deref().unwrap_or(&f.path) == path
        } else {
            f.status != "deleted" && f.path == path
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

/// Reads many blobs with one `git cat-file --batch` process (used by `gh-prv-local export`).
/// Returns sha -> text for text blobs under the size limit.
pub fn read_blobs(git: &Git, shas: &[String]) -> HashMap<String, String> {
    use std::io::{BufRead, BufReader, Read as _};
    let mut out = HashMap::new();
    if shas.is_empty() {
        return out;
    }
    let Ok(mut child) = git
        .cmd()
        .args(["cat-file", "--batch"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    else {
        return out;
    };
    if let Some(mut stdin) = child.stdin.take() {
        let input: String = shas.iter().map(|s| format!("{s}\n")).collect();
        std::thread::spawn(move || {
            let _ = stdin.write_all(input.as_bytes());
        });
    }
    let Some(stdout) = child.stdout.take() else { return out };
    let mut r = BufReader::new(stdout);
    for _ in shas {
        let mut header = String::new();
        if r.read_line(&mut header).unwrap_or(0) == 0 {
            break;
        }
        let f: Vec<&str> = header.split_whitespace().collect();
        if f.len() < 3 {
            continue; // "<sha> missing"
        }
        let size: usize = f[2].parse().unwrap_or(0);
        let mut buf = vec![0u8; size + 1]; // content + trailing newline
        if r.read_exact(&mut buf).is_err() {
            break;
        }
        buf.pop();
        if f[1] == "blob" && size <= MAX_BLOB_BYTES && !buf.iter().take(8000).any(|b| *b == 0) {
            out.insert(f[0].to_string(), String::from_utf8_lossy(&buf).into_owned());
        }
    }
    let _ = child.wait();
    out
}

pub fn changed_paths(files: &[FileDiff]) -> String {
    files.iter().filter(|f| f.status != "deleted").map(|f| f.path.as_str()).collect::<Vec<_>>().join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An empty repository in a fresh temporary directory, with these `git config` settings.
    fn scratch_repo(config: &[(&str, &str)]) -> (Git, PathBuf) {
        static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("prv-test-{}-{n}-{nanos}", std::process::id()));
        std::fs::create_dir(&dir).unwrap();
        let ok = Command::new("git").args(["init", "-q", "--template="]).arg(&dir).status().unwrap().success();
        assert!(ok);
        for (key, value) in config {
            let ok = Command::new("git").arg("-C").arg(&dir).args(["config", key, value]).status().unwrap().success();
            assert!(ok);
        }
        (Git::discover(&dir).unwrap(), dir)
    }

    #[test]
    fn origin_is_the_only_remote() {
        let (git, dir) = scratch_repo(&[("remote.upstream.url", "https://example.com/a/b.git")]);
        assert_eq!(pick_remote(&git), None);
        let (git2, dir2) = scratch_repo(&[
            ("remote.upstream.url", "https://example.com/a/b.git"),
            ("remote.origin.url", "https://github.com/me/b.git"),
        ]);
        assert_eq!(pick_remote(&git2).as_deref(), Some("origin"));
        let _ = std::fs::remove_dir_all(dir);
        let _ = std::fs::remove_dir_all(dir2);
    }

    #[test]
    fn lazy_fetch_only_from_origin() {
        let (plain, d1) = scratch_repo(&[]);
        assert!(!plain.no_lazy_fetch);
        let (from_origin, d2) = scratch_repo(&[("remote.origin.promisor", "true"), ("extensions.partialClone", "origin")]);
        assert!(!from_origin.no_lazy_fetch);
        let (other, d3) = scratch_repo(&[("remote.mirror.promisor", "true"), ("extensions.partialClone", "mirror")]);
        assert!(other.no_lazy_fetch);
        // Any spelling git accepts as true.
        let (yes, d4) = scratch_repo(&[("remote.mirror.promisor", "Yes")]);
        assert!(yes.no_lazy_fetch);
        assert!(other.cmd().get_envs().any(|(k, v)| k == "GIT_NO_LAZY_FETCH" && v == Some(std::ffi::OsStr::new("1"))));
        for d in [d1, d2, d3, d4] {
            let _ = std::fs::remove_dir_all(d);
        }
    }

    #[test]
    fn merge_tree_output() {
        let tree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
        assert_eq!(parse_merge_tree(Some(0), &format!("{tree}\0")), Some(vec![]));
        assert_eq!(
            parse_merge_tree(Some(1), &format!("{tree}\0a.txt\0a.txt\0b.txt\0")),
            Some(vec!["a.txt".to_string(), "b.txt".to_string()])
        );
        // git 2.54: exit code 1 and no tree id when an object is missing. Unknown, not "clean".
        assert_eq!(parse_merge_tree(Some(1), ""), None);
        assert_eq!(parse_merge_tree(Some(1), "merge: not something we can merge\n"), None);
        assert_eq!(parse_merge_tree(Some(128), ""), None);
    }

    #[test]
    fn co_author_trailers() {
        let t = "Claude Opus 5.5 <noreply@anthropic.com>\x1dClaude Fable 5.1 <noreply@anthropic.com>\x1dKim <k@x.io>";
        assert_eq!(co_authors(t), vec!["Claude Opus 5.5".to_string(), "Kim".to_string()]);
        assert!(co_authors("").is_empty());
    }

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
    fn quoting_and_assignment() {
        let e = |p: &str, o: Option<&str>| RawEntry {
            old_mode: "100644".into(),
            new_mode: "100644".into(),
            old_sha: "1".into(),
            new_sha: "2".into(),
            status: 'M',
            path: p.into(),
            old_path: o.map(Into::into),
        };
        assert_eq!(quote_path("a/", "dir with space/x.txt"), "a/dir with space/x.txt");
        assert_eq!(quote_path("b/", "q\"uote.txt"), "\"b/q\\\"uote.txt\"");
        // `-w` dropped a.txt: data.txt must not receive a.txt's (missing) chunk or vice versa.
        let entries = vec![e("a.txt", None), e("data.txt", None)];
        let chunks = vec![("diff --git a/data.txt b/data.txt".to_string(), "diff --git a/data.txt b/data.txt\n@@ -1 +1 @@\n-x\n+y\n".to_string())];
        let out = assign(&entries, chunks);
        assert_eq!(out[0].1, "");
        assert!(out[1].1.starts_with("@@ -1 +1 @@"));
    }

    #[test]
    fn userinfo() {
        assert_eq!(strip_userinfo("https://user:tok@ghe.example.com/a/b.git"), "https://ghe.example.com/a/b.git");
        assert_eq!(strip_userinfo("git@ghe.example.com:a/b.git"), "git@ghe.example.com:a/b.git");
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
