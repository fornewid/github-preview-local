//! `gh-prv-local update [VERSION]`: replaces this binary with a release's (the latest, or the one
//! asked for), checked against the release's SHA-256 file and started once (`--version`) before it
//! goes in place, then updates the Claude Code plugin if it is installed. It runs only when asked:
//! gh-prv-local never checks for updates by itself. Releases come from github.com through `gh`
//! when it is signed in there (which also reaches a private repository), else `curl`.

use sha2::{Digest, Sha256};
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
    } else {
        let exe = std::env::current_exe()
            .and_then(|p| p.canonicalize())
            .map_err(|e| format!("cannot find this program's file: {e}"))?;
        let tmp = TempDir::new()?;
        println!("Downloading gh-prv-local {tag} ({asset})…");
        download(gh, &tag, asset, &tmp.0).map_err(|e| format!("{e}: cannot download {asset} of gh-prv-local {tag}"))?;
        let file = tmp.0.join(asset);
        verify(&file, &std::fs::read_to_string(tmp.0.join(format!("{asset}.sha256"))).unwrap_or_default())?;
        check_starts(&file, &tag)?;
        replace(&file, &exe)?;
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

/// `0.2.1` or `v0.2.1` → `v0.2.1`. Only a version: it goes into a URL and a `gh` argument.
fn tag(v: &str) -> Result<String, String> {
    let v = v.trim();
    let bare = v.strip_prefix('v').unwrap_or(v);
    let mut parts = bare.split(['.', '-']);
    let numbered = (0..3).all(|_| parts.next().is_some_and(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit())));
    if !numbered || !bare.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-') {
        return Err(format!("not a version: {v} (for example 0.2.1 or v0.2.1)"));
    }
    Ok(format!("v{bare}"))
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

fn latest(gh: bool) -> Result<String, String> {
    let unreachable = |e: String| format!("{e}: cannot read the latest release of github.com/{REPO} (sign in with `gh auth login` if it is private)");
    let found = if gh {
        tool(Command::new("gh").args(["release", "view", "--repo", &format!("github.com/{REPO}"), "--json", "tagName", "--jq", ".tagName"])).map_err(unreachable)?
    } else {
        // The latest release's page redirects to its tag.
        let url = tool(Command::new("curl").args([
            "-fsSIL",
            "--proto",
            "=https",
            "-o",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
            "-w",
            "%{url_effective}",
            &format!("https://github.com/{REPO}/releases/latest"),
        ]))
        .map_err(unreachable)?;
        url.rsplit('/').next().unwrap_or_default().to_string()
    };
    tag(&found).map_err(|_| format!("cannot tell the latest release (got {found:?})"))
}

fn download(gh: bool, tag: &str, asset: &str, dir: &Path) -> Result<(), String> {
    let sum = format!("{asset}.sha256");
    if gh {
        tool(Command::new("gh").args(["release", "download", tag, "--repo", &format!("github.com/{REPO}"), "--pattern", asset, "--pattern", &sum]).arg("--dir").arg(dir))?;
        return Ok(());
    }
    for name in [asset, sum.as_str()] {
        tool(
            Command::new("curl")
                .args(["-fsSL", "--proto", "=https", "-o"])
                .arg(dir.join(name))
                .arg(format!("https://github.com/{REPO}/releases/download/{tag}/{name}")),
        )?;
    }
    Ok(())
}

/// The file's SHA-256 against the release's `<asset>.sha256` (`<hex>  <name>`).
fn verify(file: &Path, sum_file: &str) -> Result<(), String> {
    let expected = sum_file.split_whitespace().next().unwrap_or_default().to_ascii_lowercase();
    if expected.len() != 64 || !expected.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("the release has no usable SHA-256 file".into());
    }
    let bytes = std::fs::read(file).map_err(|e| format!("cannot read the download: {e}"))?;
    let actual: String = Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect();
    if actual != expected {
        return Err(format!("checksum mismatch for {}: nothing was changed", file.display()));
    }
    Ok(())
}

/// The new binary must start and be the version asked for before it replaces this one.
fn check_starts(file: &Path, tag: &str) -> Result<(), String> {
    set_executable(file)?;
    let out = Command::new(file).arg("--version").stdin(Stdio::null()).stderr(Stdio::null()).output();
    let said = out.ok().filter(|o| o.status.success()).map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
    match said {
        Some(s) if s == format!("gh-prv-local {}", &tag[1..]) => Ok(()),
        Some(s) => Err(format!("the downloaded binary says {s:?}, not {tag}: nothing was changed")),
        None => Err(format!(
            "the downloaded {tag} binary does not start on this machine{}: nothing was changed",
            if cfg!(target_os = "linux") { " (it needs the WebKitGTK runtime, libwebkit2gtk-4.1)" } else { "" }
        )),
    }
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

/// Puts `new` in place of `exe` in one step: a copy next to it first (the download may be on
/// another disk), then a rename. Windows cannot replace a running program but can rename it, so
/// the old one moves aside to `<exe>.old` (removed by the next update).
fn replace(new: &Path, exe: &Path) -> Result<(), String> {
    let dir = exe.parent().ok_or("no folder for this program")?;
    let name = exe.file_name().unwrap_or_default().to_string_lossy().into_owned();
    let staged = dir.join(format!(".{name}.update-{}", std::process::id()));
    let denied = |e: std::io::Error| format!("cannot write to {} ({e}): install again with scripts/install.sh, or run this with the rights to change that folder", dir.display());
    std::fs::copy(new, &staged).map_err(denied)?;
    let done = set_executable(&staged).and_then(|()| swap(&staged, exe));
    if done.is_err() {
        let _ = std::fs::remove_file(&staged);
    }
    done
}

#[cfg(not(windows))]
fn swap(staged: &Path, exe: &Path) -> Result<(), String> {
    std::fs::rename(staged, exe).map_err(|e| format!("cannot replace {}: {e}", exe.display()))
}

#[cfg(windows)]
fn swap(staged: &Path, exe: &Path) -> Result<(), String> {
    let old = PathBuf::from(format!("{}.old", exe.display()));
    let _ = std::fs::remove_file(&old);
    std::fs::rename(exe, &old).map_err(|e| format!("cannot move {} aside: {e}", exe.display()))?;
    std::fs::rename(staged, exe).map_err(|e| {
        let _ = std::fs::rename(&old, exe);
        format!("cannot replace {}: {e}", exe.display())
    })
}

/// The Claude Code plugin (`/gh-prv-local`) comes from this repository's marketplace: when it is
/// installed, it is updated too (Claude Code applies it after a restart).
fn update_plugin() {
    let listed = Command::new("claude").args(["plugin", "list", "--json"]).stdin(Stdio::null()).stderr(Stdio::null()).output();
    let Some(scope) = listed.ok().and_then(|o| installed_scope(&String::from_utf8_lossy(&o.stdout))) else {
        return;
    };
    let ok = |args: &[&str]| Command::new("claude").args(args).stdin(Stdio::null()).status().is_ok_and(|s| s.success());
    if ok(&["plugin", "marketplace", "update", MARKETPLACE]) && ok(&["plugin", "update", PLUGIN, "--scope", &scope]) {
        println!("Restart Claude Code to use the updated /gh-prv-local plugin.");
    } else {
        println!("Update the Claude Code plugin with:\n  claude plugin marketplace update {MARKETPLACE}\n  claude plugin update {PLUGIN} --scope {scope}");
    }
}

/// The scope (user, project, …) the plugin is installed in, from `claude plugin list --json`.
fn installed_scope(list: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(list).ok()?;
    let p = v.as_array()?.iter().find(|p| p["id"] == PLUGIN)?;
    Some(p["scope"].as_str().unwrap_or("user").to_string())
}

/// A new, empty folder in the system temp directory, removed with everything in it when dropped.
struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Result<Self, String> {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let p = std::env::temp_dir().join(format!("gh-prv-local-update-{}-{nanos}", std::process::id()));
        std::fs::create_dir(&p).map_err(|e| format!("cannot create {}: {e}", p.display()))?;
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
        for bad in ["", "v", "latest", "1.2", "v1..2", "1.2.3/../x", "1.2.3 x", "-1.2.3"] {
            assert!(tag(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn checksums() {
        let dir = TempDir::new().unwrap();
        let f = dir.0.join("bin");
        std::fs::write(&f, b"abc").unwrap();
        // SHA-256("abc"), FIPS 180-2.
        let sum = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
        verify(&f, &format!("{sum}  bin\n")).unwrap();
        verify(&f, &sum.to_uppercase()).unwrap();
        assert!(verify(&f, &format!("{}0  bin", &sum[1..])).is_err());
        assert!(verify(&f, "").is_err());
        assert!(verify(&f, "not-a-sum bin").is_err());
    }

    #[test]
    fn replaces_the_file_in_place() {
        let dir = TempDir::new().unwrap();
        let exe = dir.0.join("gh-prv-local");
        let new = dir.0.join("download");
        std::fs::write(&exe, b"old").unwrap();
        std::fs::write(&new, b"new").unwrap();
        replace(&new, &exe).unwrap();
        assert_eq!(std::fs::read(&exe).unwrap(), b"new");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&exe).unwrap().permissions().mode() & 0o777, 0o755);
        }
        // Nothing staged is left behind.
        let mut left: Vec<_> = std::fs::read_dir(&dir.0).unwrap().map(|e| e.unwrap().file_name()).collect();
        left.sort();
        assert_eq!(left, ["download", "gh-prv-local"]);
    }

    #[test]
    fn plugin_scope() {
        let list = r#"[{"id":"other@x","scope":"user"},{"id":"gh-prv-local@github-preview-local","scope":"project"}]"#;
        assert_eq!(installed_scope(list).as_deref(), Some("project"));
        assert_eq!(installed_scope(r#"[{"id":"other@x","scope":"user"}]"#), None);
        assert_eq!(installed_scope("not json"), None);
    }
}
