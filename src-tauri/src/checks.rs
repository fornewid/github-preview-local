//! Local checks: commands from `.prv.toml`, or auto-detected from common
//! project files (package.json, Gradle, Cargo, Go, Makefile, pre-commit).

use crate::model::CheckDef;
use serde::Deserialize;
use std::io::Read;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

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
    for name in [".prv.toml", "prv.toml", ".github/prv.toml"] {
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
            "pre-commit run --from-ref \"$PRV_MERGE_BASE\" --to-ref \"$PRV_HEAD\"".into(),
            ".pre-commit-config.yaml",
        );
    }
    out
}

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
        .stderr(Stdio::piped())
        .spawn()
}

/// Runs a check, streaming output chunks; returns the exit code (None on timeout/kill).
pub fn run(def: &CheckDef, root: &Path, env: &[(String, String)], mut on_chunk: impl FnMut(&str)) -> Option<i32> {
    let mut child = match spawn(def, root, env) {
        Ok(c) => c,
        Err(e) => {
            on_chunk(&format!("failed to start: {e}\n"));
            return Some(127);
        }
    };
    let (tx, rx) = mpsc::channel::<String>();
    let mut readers = vec![];
    for pipe in [child.stdout.take().map(|p| Box::new(p) as Box<dyn Read + Send>), child.stderr.take().map(|p| Box::new(p) as Box<dyn Read + Send>)]
        .into_iter()
        .flatten()
    {
        let tx = tx.clone();
        readers.push(std::thread::spawn(move || {
            let mut pipe = pipe;
            let mut buf = [0u8; 8192];
            loop {
                match pipe.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let _ = tx.send(String::from_utf8_lossy(&buf[..n]).into_owned());
                    }
                }
            }
        }));
    }
    drop(tx);
    let start = Instant::now();
    let timeout = def.timeout.map(Duration::from_secs);
    loop {
        while let Ok(chunk) = rx.recv_timeout(Duration::from_millis(100)) {
            on_chunk(&chunk);
        }
        if let Ok(Some(status)) = child.try_wait() {
            for r in readers {
                let _ = r.join();
            }
            while let Ok(chunk) = rx.try_recv() {
                on_chunk(&chunk);
            }
            return status.code().or(Some(1));
        }
        if let Some(t) = timeout {
            if start.elapsed() > t {
                let _ = child.kill();
                on_chunk(&format!("\nTimed out after {}s\n", t.as_secs()));
                return None;
            }
        }
    }
}
