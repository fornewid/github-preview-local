//! `gh-prv-local update [VERSION]`: replaces this binary with a release's (the latest, or the one
//! asked for), checked against the release's SHA-256 file and started once (`--version`) before it
//! goes in place, then updates the Claude Code plugin if it is installed. It runs only when asked:
//! gh-prv-local never checks for updates by itself. Releases come from github.com through `gh`
//! when it is signed in there (which also reaches a private repository), else (or when `gh`
//! fails, say with a stale token) `curl`.

use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const REPO: &str = "fornewid/github-preview-local";
const PLUGIN: &str = "gh-prv-local@github-preview-local";
const MARKETPLACE: &str = "github-preview-local";

pub fn run(version: Option<&str>) -> Result<(), String> {
    let asset = asset(std::env::consts::OS, std::env::consts::ARCH)?;
    let current = format!("v{}", env!("CARGO_PKG_VERSION"));
    let gh = gh_signed_in();
    let tag = match version {
        Some(v) => tag(v)?,
        None => latest(gh)?,
    };
    if tag == current {
        println!("gh-prv-local {current} is {}.", if version.is_some() { "already installed" } else { "the latest release" });
    } else if version.is_none() && newer(&current, &tag) {
        // A prerelease installed by name: a plain `update` does not go back to the last release.
        println!("gh-prv-local {current} is newer than the latest release, {tag} (`gh-prv-local update {}` installs it).", &tag[1..]);
    } else {
        let exe = std::env::current_exe()
            .and_then(|p| p.canonicalize())
            .map_err(|e| format!("cannot find this program's file: {e}"))?;
        let tmp = TempDir::new()?;
        println!("Downloading gh-prv-local {tag} ({asset})…");
        download(gh, &tag, asset, &tmp.0).map_err(|e| format!("{e}: cannot download {asset} of gh-prv-local {tag}"))?;
        // Read once: the bytes checked are the bytes installed (nothing reads the download again).
        let bytes = std::fs::read(tmp.0.join(asset)).map_err(|e| format!("cannot read the download: {e}"))?;
        verify(&bytes, &std::fs::read_to_string(tmp.0.join(format!("{asset}.sha256"))).unwrap_or_default())?;
        install(&bytes, &exe, &tag)?;
        println!("Updated {} from {current} to {tag}.", exe.display());
    }
    update_plugin();
    Ok(())
}

/// This machine's release binary, as .github/workflows/release.yml names them.
fn asset(os: &str, arch: &str) -> Result<&'static str, String> {
    Ok(match (os, arch) {
        ("macos", "aarch64") => "gh-prv-local-darwin-arm64",
        ("macos", "x86_64") => "gh-prv-local-darwin-x64",
        ("linux", "x86_64") => "gh-prv-local-linux-x64",
        ("linux", "aarch64") => "gh-prv-local-linux-arm64",
        ("windows", "x86_64") => "gh-prv-local-windows-x64.exe",
        _ => return Err(format!("there is no release binary for {os}/{arch}: build it from source (scripts/install.sh --source)")),
    })
}

/// `0.2.1` or `v0.2.1` → `v0.2.1`: MAJOR.MINOR.PATCH with an optional `-PRERELEASE` (dot-separated
/// letters, digits and hyphens). Only a version: it goes into a URL and a `gh` argument.
fn tag(v: &str) -> Result<String, String> {
    let v = v.trim();
    let bare = v.strip_prefix('v').unwrap_or(v);
    let (core, pre) = bare.split_once('-').map_or((bare, None), |(c, p)| (c, Some(p)));
    let numbers: Vec<&str> = core.split('.').collect();
    let numeric = numbers.len() == 3 && numbers.iter().all(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()));
    let pre_ok = pre.is_none_or(|p| p.split('.').all(|id| !id.is_empty() && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')));
    if !numeric || !pre_ok {
        return Err(format!("not a version: {v} (for example 0.2.1 or v0.2.1)"));
    }
    Ok(format!("v{bare}"))
}

/// Whether tag `a` is a later version than tag `b` (both from `tag`), in semantic versioning's
/// order: the numbers, then a prerelease before its release, prereleases by their dot-separated
/// parts (numbers as numbers, below words; fewer parts first when the rest is equal).
fn newer(a: &str, b: &str) -> bool {
    use std::cmp::Ordering;
    fn split(t: &str) -> (Vec<u64>, Option<&str>) {
        let t = t.trim_start_matches('v');
        let (core, pre) = t.split_once('-').map_or((t, None), |(c, p)| (c, Some(p)));
        (core.split('.').map(|n| n.parse().unwrap_or(0)).collect(), pre)
    }
    fn part(x: &str, y: &str) -> Ordering {
        match (x.parse::<u64>(), y.parse::<u64>()) {
            (Ok(m), Ok(n)) => m.cmp(&n),
            (Ok(_), Err(_)) => Ordering::Less,
            (Err(_), Ok(_)) => Ordering::Greater,
            _ => x.cmp(y),
        }
    }
    let ((na, pa), (nb, pb)) = (split(a), split(b));
    let order = na.cmp(&nb).then_with(|| match (pa, pb) {
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
        (Some(x), Some(y)) => {
            let (xs, ys): (Vec<_>, Vec<_>) = (x.split('.').collect(), y.split('.').collect());
            xs.iter().zip(&ys).map(|(p, q)| part(p, q)).find(|o| o.is_ne()).unwrap_or(xs.len().cmp(&ys.len()))
        }
    });
    order == Ordering::Greater
}

fn gh_signed_in() -> bool {
    Command::new("gh")
        .args(["auth", "token", "--hostname", "github.com"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

/// Runs a download tool; its own messages (errors, a sign-in prompt) go to the terminal.
fn tool(cmd: &mut Command) -> Result<String, String> {
    let name = cmd.get_program().to_string_lossy().into_owned();
    let out = cmd
        .stdin(Stdio::null())
        .stderr(Stdio::inherit())
        .output()
        .map_err(|e| format!("cannot run {name}: {e}"))?;
    if !out.status.success() {
        return Err(format!("{name} failed ({})", out.status));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// `gh` first when it is signed in; `curl` if it fails (a stored token may be stale, and the
/// repository is public).
fn gh_or_curl<T>(gh: bool, with_gh: impl FnOnce() -> Result<T, String>, with_curl: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    if gh {
        match with_gh() {
            Ok(v) => return Ok(v),
            Err(e) => eprintln!("gh-prv-local: {e}; trying curl"),
        }
    }
    with_curl()
}

fn latest(gh: bool) -> Result<String, String> {
    let found = gh_or_curl(
        gh,
        || tool(Command::new("gh").args(["release", "view", "--repo", &format!("github.com/{REPO}"), "--json", "tagName", "--jq", ".tagName"])),
        || {
            // The latest release's page redirects to its tag.
            let url = tool(Command::new("curl").args([
                "-fsSIL",
                "--proto",
                "=https",
                "--proto-redir",
                "=https",
                "-o",
                if cfg!(windows) { "NUL" } else { "/dev/null" },
                "-w",
                "%{url_effective}",
                &format!("https://github.com/{REPO}/releases/latest"),
            ]))?;
            Ok(url.rsplit('/').next().unwrap_or_default().to_string())
        },
    )
    .map_err(|e| format!("{e}: cannot read the latest release of github.com/{REPO} (sign in with `gh auth login` if it is private)"))?;
    tag(&found).map_err(|_| format!("cannot tell the latest release (got {found:?})"))
}

fn download(gh: bool, tag: &str, asset: &str, dir: &Path) -> Result<(), String> {
    let sum = format!("{asset}.sha256");
    gh_or_curl(
        gh,
        || {
            let repo = format!("github.com/{REPO}");
            tool(Command::new("gh").args(["release", "download", tag, "--repo", &repo, "--clobber", "--pattern", asset, "--pattern", &sum]).arg("--dir").arg(dir)).map(drop)
        },
        || {
            for name in [asset, sum.as_str()] {
                tool(
                    Command::new("curl")
                        .args(["-fsSL", "--proto", "=https", "--proto-redir", "=https", "-o"])
                        .arg(dir.join(name))
                        .arg(format!("https://github.com/{REPO}/releases/download/{tag}/{name}")),
                )?;
            }
            Ok(())
        },
    )
}

/// The bytes' SHA-256 against the release's `<asset>.sha256` (`<hex>  <name>`).
fn verify(bytes: &[u8], sum_file: &str) -> Result<(), String> {
    let expected = sum_file.split_whitespace().next().unwrap_or_default().to_ascii_lowercase();
    if expected.len() != 64 || !expected.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("the release has no usable SHA-256 file".into());
    }
    let actual: String = Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect();
    if actual != expected {
        return Err("the download does not match the release's SHA-256: nothing was changed".into());
    }
    Ok(())
}

/// Writes the new binary next to `exe` (a new file only this user can change, on the disk it is
/// installed on), starts it there once (`--version` must name the release), then renames it over
/// `exe` in one step. Windows cannot replace a running program but can rename it, so the old one
/// moves aside to `<exe>.old` (removed by the next update).
fn install(bytes: &[u8], exe: &Path, tag: &str) -> Result<(), String> {
    let dir = exe.parent().ok_or("no folder for this program")?;
    let name = exe.file_name().unwrap_or_default().to_string_lossy().into_owned();
    let staged = dir.join(format!(".{name}.update-{}", random_hex()?));
    write_new(&staged, bytes).map_err(|e| {
        let rights = if e.kind() == std::io::ErrorKind::PermissionDenied {
            ": install again with scripts/install.sh, or run this with the rights to change that folder"
        } else {
            ""
        };
        format!("cannot write to {} ({e}){rights}", dir.display())
    })?;
    let done = check_starts(&staged, tag).and_then(|()| set_executable(&staged)).and_then(|()| swap(&staged, exe));
    if done.is_err() {
        let _ = std::fs::remove_file(&staged);
    }
    done
}

/// A new file (never an existing one) with `bytes`, 0700 on Unix; removed again if writing fails.
fn write_new(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(0o700);
    }
    let mut f = o.open(path)?;
    let written = f.write_all(bytes).and_then(|()| f.sync_all());
    drop(f);
    if written.is_err() {
        let _ = std::fs::remove_file(path);
    }
    written
}

/// The new binary must start and be the version asked for before it replaces this one.
fn check_starts(file: &Path, tag: &str) -> Result<(), String> {
    let out = Command::new(file)
        .arg("--version")
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("cannot start the downloaded {tag} binary ({e}): nothing was changed"))?;
    let said = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if out.status.success() {
        return if said == format!("gh-prv-local {}", &tag[1..]) {
            Ok(())
        } else {
            Err(format!("the downloaded binary says {said:?}, not {tag}: nothing was changed"))
        };
    }
    let err = String::from_utf8_lossy(&out.stderr);
    let first = err.lines().find(|l| !l.trim().is_empty()).unwrap_or_default().trim();
    let webkit = if err.contains("libwebkit2gtk") { " (it needs the WebKitGTK runtime, libwebkit2gtk-4.1)" } else { "" };
    Err(format!("the downloaded {tag} binary does not start ({}{}{first}){webkit}: nothing was changed", out.status, if first.is_empty() { "" } else { ": " }))
}

fn set_executable(file: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o755)).map_err(|e| format!("cannot make {} executable: {e}", file.display()))?;
    }
    #[cfg(not(unix))]
    let _ = file;
    Ok(())
}

#[cfg(not(windows))]
fn swap(staged: &Path, exe: &Path) -> Result<(), String> {
    std::fs::rename(staged, exe).map_err(|e| format!("cannot replace {}: {e}", exe.display()))
}

#[cfg(windows)]
fn swap(staged: &Path, exe: &Path) -> Result<(), String> {
    let old = PathBuf::from(format!("{}.old", exe.display()));
    if old.exists() {
        std::fs::remove_file(&old).map_err(|e| format!("cannot remove {} from the last update ({e}): is an older gh-prv-local still running?", old.display()))?;
    }
    std::fs::rename(exe, &old).map_err(|e| format!("cannot move {} aside: {e}", exe.display()))?;
    std::fs::rename(staged, exe).map_err(|e| {
        let _ = std::fs::rename(&old, exe);
        format!("cannot replace {}: {e}", exe.display())
    })
}

/// `claude`, found the way Rust finds programs (on Windows: a `claude.exe` on PATH, never one in
/// the current folder, which may be a repository you do not trust; an npm install's claude.cmd is
/// left alone, and the plugin is then updated by hand).
fn claude(args: &[&str]) -> Command {
    let mut c = Command::new("claude");
    c.args(args).stdin(Stdio::null());
    c
}

/// The Claude Code plugin (`/gh-prv-local`) comes from this repository's marketplace: when it is
/// installed, it is updated too (Claude Code applies it after a restart).
fn update_plugin() {
    // Run with sudo (to replace a binary in a system folder), claude would see root's setup or
    // leave root-owned files in your ~/.claude: it is not run at all.
    #[cfg(unix)]
    if unsafe { libc::geteuid() } == 0 {
        println!("If you use the Claude Code plugin, update it as yourself (not as root):\n  claude plugin marketplace update {MARKETPLACE}\n  claude plugin update {PLUGIN}");
        return;
    }
    let listed = claude(&["plugin", "list", "--json"]).stderr(Stdio::null()).output();
    let Some(scope) = listed.ok().and_then(|o| installed_scope(&String::from_utf8_lossy(&o.stdout))) else {
        return;
    };
    let by_hand = format!("  claude plugin marketplace update {MARKETPLACE}\n  claude plugin update {PLUGIN} --scope {scope}");
    let ok = |args: &[&str]| claude(args).status().is_ok_and(|s| s.success());
    if ok(&["plugin", "marketplace", "update", MARKETPLACE]) && ok(&["plugin", "update", PLUGIN, "--scope", &scope]) {
        println!("Restart Claude Code to use the updated /gh-prv-local plugin.");
    } else {
        println!("Update the Claude Code plugin with:\n{by_hand}");
    }
}

/// The scope the plugin is installed in (user, project, local, managed), from `claude plugin list
/// --json`.
fn installed_scope(list: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(list).ok()?;
    let p = v.as_array()?.iter().find(|p| p["id"] == PLUGIN)?;
    let scope = p["scope"].as_str().unwrap_or("user");
    ["user", "project", "local", "managed"].contains(&scope).then(|| scope.to_string())
}

fn random_hex() -> Result<String, String> {
    let mut b = [0u8; 8];
    getrandom::fill(&mut b).map_err(|e| format!("no random source: {e}"))?;
    Ok(b.iter().map(|x| format!("{x:02x}")).collect())
}

/// A new folder in the system temp directory, under a random name and private to this user (0700
/// on Unix), removed with everything in it when dropped.
struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Result<Self, String> {
        let p = std::env::temp_dir().join(format!("gh-prv-local-update-{}", random_hex()?));
        let mut b = std::fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            b.mode(0o700);
        }
        b.create(&p).map_err(|e| format!("cannot create {}: {e}", p.display()))?;
        Ok(Self(p))
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn assets_match_the_release_workflow() {
        let workflow = include_str!("../../.github/workflows/release.yml");
        for (os, arch) in [("macos", "aarch64"), ("macos", "x86_64"), ("linux", "x86_64"), ("linux", "aarch64"), ("windows", "x86_64")] {
            let a = asset(os, arch).unwrap();
            assert!(workflow.contains(&format!("asset: {a} ")), "{a} is not built by release.yml");
        }
        assert!(asset("freebsd", "x86_64").is_err());
    }

    #[test]
    fn versions() {
        assert_eq!(tag("0.2.1").unwrap(), "v0.2.1");
        assert_eq!(tag(" v1.10.0 ").unwrap(), "v1.10.0");
        assert_eq!(tag("v1.0.0-rc.1").unwrap(), "v1.0.0-rc.1");
        for bad in ["", "v", "latest", "1.2", "v1..2", "1.2.3/../x", "1.2.3 x", "-1.2.3", "1-2-3", "1.2-3", "0.2.1.", "0.2.1-", "1.2.3-rc..1", "1.2.3.4"] {
            assert!(tag(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn version_order() {
        assert!(newer("v0.2.10", "v0.2.9"));
        assert!(newer("v1.0.0", "v0.99.99"));
        assert!(newer("v1.0.0", "v1.0.0-rc.1"));
        assert!(newer("v1.0.0-rc.1", "v0.9.0"));
        assert!(!newer("v0.2.1", "v0.2.1"));
        assert!(!newer("v0.2.1", "v0.2.2"));
        assert!(!newer("v1.0.0-rc.1", "v1.0.0"));
        assert!(newer("v1.0.0-rc.2", "v1.0.0-rc.1"));
        assert!(newer("v1.0.0-rc.10", "v1.0.0-rc.9"));
        assert!(newer("v1.0.0-rc.1", "v1.0.0-beta.2"));
        assert!(newer("v1.0.0-alpha.1", "v1.0.0-alpha"));
        assert!(newer("v1.0.0-alpha.beta", "v1.0.0-alpha.1"));
        assert!(!newer("v1.0.0-rc.1", "v1.0.0-rc.1"));
    }

    #[test]
    fn checksums() {
        // SHA-256("abc"), FIPS 180-2.
        let sum = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
        verify(b"abc", &format!("{sum}  bin\n")).unwrap();
        verify(b"abc", &sum.to_uppercase()).unwrap();
        assert!(verify(b"abd", sum).is_err());
        assert!(verify(b"abc", &format!("{}0  bin", &sum[1..])).is_err());
        assert!(verify(b"abc", "").is_err());
        assert!(verify(b"abc", "not-a-sum bin").is_err());
    }

    #[test]
    fn private_temp_dir() {
        let a = TempDir::new().unwrap();
        let b = TempDir::new().unwrap();
        assert_ne!(a.0, b.0);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&a.0).unwrap().permissions().mode() & 0o777, 0o700);
        }
        let p = a.0.clone();
        drop(a);
        assert!(!p.exists());
    }

    /// A stand-in release binary: a script answering `--version` like gh-prv-local.
    #[cfg(unix)]
    fn fake_binary(says: &str) -> Vec<u8> {
        format!("#!/bin/sh\necho '{says}'\n").into_bytes()
    }

    #[cfg(unix)]
    fn files(dir: &Path) -> Vec<String> {
        let mut v: Vec<_> = std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        v.sort();
        v
    }

    #[cfg(unix)]
    #[test]
    fn installs_in_place_once_it_starts_as_the_release() {
        use std::os::unix::fs::PermissionsExt;
        let dir = TempDir::new().unwrap();
        let exe = dir.0.join("gh-prv-local");
        std::fs::write(&exe, b"old").unwrap();
        let new = fake_binary("gh-prv-local 9.9.9");
        install(&new, &exe, "v9.9.9").unwrap();
        assert_eq!(std::fs::read(&exe).unwrap(), new);
        assert_eq!(std::fs::metadata(&exe).unwrap().permissions().mode() & 0o777, 0o755);
        assert_eq!(files(&dir.0), ["gh-prv-local"]);
    }

    #[cfg(unix)]
    #[test]
    fn keeps_the_old_binary_when_the_new_one_is_not_the_release() {
        let dir = TempDir::new().unwrap();
        let exe = dir.0.join("gh-prv-local");
        std::fs::write(&exe, b"old").unwrap();
        let e = install(&fake_binary("gh-prv-local 1.0.0"), &exe, "v9.9.9").unwrap_err();
        assert!(e.contains("says") && e.contains("nothing was changed"), "{e}");
        let e = install(b"#!/bin/sh\necho broken >&2\nexit 3\n", &exe, "v9.9.9").unwrap_err();
        assert!(e.contains("does not start") && e.contains("broken"), "{e}");
        assert_eq!(std::fs::read(&exe).unwrap(), b"old");
        assert_eq!(files(&dir.0), ["gh-prv-local"]);
    }

    #[test]
    fn plugin_scope() {
        let list = r#"[{"id":"other@x","scope":"user"},{"id":"gh-prv-local@github-preview-local","scope":"project"}]"#;
        assert_eq!(installed_scope(list).as_deref(), Some("project"));
        assert_eq!(installed_scope(r#"[{"id":"other@x","scope":"user"}]"#), None);
        assert_eq!(installed_scope(r#"[{"id":"gh-prv-local@github-preview-local","scope":"user & calc"}]"#), None);
        assert_eq!(installed_scope("not json"), None);
    }
}
