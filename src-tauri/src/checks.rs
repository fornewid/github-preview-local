//! Local checks: commands from `.gh-prv-local.toml`, or auto-detected from common
//! project files (package.json, Gradle, Cargo, Go, Makefile, pre-commit).

use crate::model::CheckDef;
use serde::Deserialize;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::AtomicBool;
use std::time::Duration;

#[derive(Deserialize)]
struct Config {
    #[serde(default)]
    checks: Vec<CheckConf>,
}

#[derive(Deserialize)]
struct CheckConf {
    name: String,
    run: String,
    timeout: Option<u64>,
}

pub fn discover(root: &Path) -> Result<Vec<CheckDef>, String> {
    for name in [".gh-prv-local.toml", "gh-prv-local.toml", ".github/gh-prv-local.toml"] {
        let p = root.join(name);
        if let Ok(text) = std::fs::read_to_string(&p) {
            let cfg: Config = toml::from_str(&text).map_err(|e| format!("{name}: {e}"))?;
            return Ok(cfg
                .checks
                .into_iter()
                .map(|c| CheckDef { name: c.name, run: c.run, source: name.into(), timeout: c.timeout })
                .collect());
        }
    }
    Ok(auto_detect(root))
}

fn auto_detect(root: &Path) -> Vec<CheckDef> {
    let mut out = vec![];
    let mut push = |name: &str, run: String, source: &str| {
        out.push(CheckDef { name: name.into(), run, source: source.into(), timeout: None })
    };
    if let Ok(text) = std::fs::read_to_string(root.join("package.json")) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
            let pm = if root.join("pnpm-lock.yaml").exists() {
                "pnpm"
            } else if root.join("yarn.lock").exists() {
                "yarn"
            } else if root.join("bun.lockb").exists() || root.join("bun.lock").exists() {
                "bun"
            } else {
                "npm"
            };
            if let Some(scripts) = v.get("scripts").and_then(|s| s.as_object()) {
                for s in ["lint", "typecheck", "type-check", "check", "test"] {
                    if let Some(cmd) = scripts.get(s).and_then(|c| c.as_str()) {
                        if s == "test" && cmd.contains("no test specified") {
                            continue;
                        }
                        push(s, format!("{pm} run {s}"), "package.json");
                    }
                }
            }
        }
    }
    let gradlew = if cfg!(windows) { "gradlew.bat" } else { "gradlew" };
    if root.join(gradlew).exists() {
        let cmd = if cfg!(windows) { "gradlew.bat" } else { "./gradlew" };
        push("gradle check", format!("{cmd} check"), "gradlew");
    }
    if root.join("Cargo.toml").exists() {
        push("cargo clippy", "cargo clippy --all-targets".into(), "Cargo.toml");
        push("cargo test", "cargo test".into(), "Cargo.toml");
    }
    if root.join("go.mod").exists() {
        push("go vet", "go vet ./...".into(), "go.mod");
        push("go test", "go test ./...".into(), "go.mod");
    }
    if let Ok(mk) = std::fs::read_to_string(root.join("Makefile")) {
        for t in ["lint", "test"] {
            if mk.lines().any(|l| l.starts_with(&format!("{t}:"))) {
                push(&format!("make {t}"), format!("make {t}"), "Makefile");
            }
        }
    }
    if root.join(".pre-commit-config.yaml").exists() {
        push(
            "pre-commit",
            "pre-commit run --from-ref \"$GH_PRV_LOCAL_MERGE_BASE\" --to-ref \"$GH_PRV_LOCAL_HEAD\"".into(),
            ".pre-commit-config.yaml",
        );
    }
    out
}

/// Default timeout for checks without an explicit `timeout` (30 minutes).
pub const DEFAULT_TIMEOUT: u64 = 30 * 60;

pub fn spawn(def: &CheckDef, root: &Path, env: &[(String, String)]) -> std::io::Result<Child> {
    let mut c = if cfg!(windows) {
        let mut c = Command::new("cmd");
        c.args(["/C", &def.run]);
        c
    } else {
        let mut c = Command::new("sh");
        c.args(["-c", &def.run]);
        c
    };
    c.current_dir(root)
        .envs(env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .env("CI", "true")
        .env("FORCE_COLOR", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::proc::own_group(&mut c);
    c.spawn()
}

/// Runs a check, streaming output; returns the exit code (None on timeout/cancel).
pub fn run(
    def: &CheckDef,
    root: &Path,
    env: &[(String, String)],
    cancel: &AtomicBool,
    tail: Option<usize>,
    mut on_output: impl FnMut(&str),
) -> Option<i32> {
    let child = match spawn(def, root, env) {
        Ok(c) => c,
        Err(e) => {
            on_output(&format!("failed to start: {e}\n"));
            return Some(127);
        }
    };
    let timeout = Duration::from_secs(def.timeout.unwrap_or(DEFAULT_TIMEOUT));
    crate::proc::stream(child, timeout, cancel, tail, on_output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;

    fn dir(files: &[(&str, &str)]) -> TempDir {
        let d = TempDir::new();
        std::fs::create_dir(d.join(".github")).unwrap();
        for (name, text) in files {
            std::fs::write(d.join(name), text).unwrap();
        }
        d
    }

    #[test]
    fn config_file_names() {
        let one = |name: &str| "[[checks]]\nname = \"NAME\"\nrun = \"true\"\n".replace("NAME", name);
        let d = dir(&[(".github/gh-prv-local.toml", &one("github"))]);
        let found = discover(&d).unwrap();
        assert_eq!((found[0].name.as_str(), found[0].source.as_str()), ("github", ".github/gh-prv-local.toml"));
        // The repository root wins over .github/.
        let d2 = dir(&[(".github/gh-prv-local.toml", &one("github")), (".gh-prv-local.toml", &one("root"))]);
        assert_eq!(discover(&d2).unwrap()[0].name, "root");
    }
}
