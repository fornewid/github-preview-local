//! gh-prv-local — preview your branch as a GitHub pull request, locally.
//!
//! `gh-prv-local` opens a native window (system WebView, Tauri IPC — no web server)
//! showing the branch the way GitHub's "Files changed" tab would. When you
//! submit a review the result is printed to stdout, so AI agents such as
//! Claude Code can act on it. "Confirm" pushes the branch and opens the PR.

mod checks;
mod export;
mod git;
mod model;
mod proc;
mod publish;
mod serve;
#[cfg(test)]
mod testutil;

use clap::{Parser, Subcommand, ValueEnum};
use git::{DiffEnds, Git, Options};
use model::*;
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager, RunEvent, State, WebviewUrl, WebviewWindowBuilder};

#[derive(Parser, Debug)]
#[command(
    name = "gh-prv-local",
    version,
    about = "Preview your branch as a GitHub pull request, locally.",
    long_about = "Opens your branch in a GitHub-style \"Files changed\" view (merge-base...HEAD, like a pull request)\n\
                  in a browser tab (served on 127.0.0.1 for this run only), or in a native window with --window.\n\
                  Submitting a review prints it to stdout for AI agents; \"Confirm\" pushes and opens the pull request."
)]
struct Cli {
    /// Base branch or ref (default: the remote's default branch, e.g. origin/main)
    #[arg(short, long, global = true)]
    base: Option<String>,
    /// Head ref to preview (default: HEAD)
    #[arg(long, global = true)]
    head: Option<String>,
    /// Run as if started in <PATH>
    #[arg(short = 'C', value_name = "PATH", global = true)]
    dir: Option<PathBuf>,
    /// Do not fetch the base branch from the remote first
    #[arg(long, global = true)]
    no_fetch: bool,
    /// Include uncommitted (and untracked) working tree changes
    #[arg(short, long, global = true)]
    uncommitted: bool,
    /// Output format of the review printed on exit
    #[arg(long, value_enum, default_value_t = Format::Markdown, global = true)]
    format: Format,
    /// The browser for the review tab (the default): one by name (--browser=chrome) or none
    /// (--browser=none: just print the address). Default: $GH_PRV_LOCAL_BROWSER, else the system's.
    #[arg(long, value_name = "BROWSER", num_args = 0..=1, default_missing_value = "", require_equals = true)]
    browser: Option<String>,
    /// Review in the native window instead of a browser tab (nothing is served)
    #[arg(long, conflicts_with = "browser")]
    window: bool,
    #[command(subcommand)]
    command: Option<Cmd>,
}

#[derive(Subcommand, Debug)]
enum Cmd {
    /// Write a self-contained HTML preview (opens from disk, no server)
    Export {
        /// Output file (default: a new file in the system temp directory)
        #[arg(short, long)]
        output: Option<PathBuf>,
        /// Open the file in the default browser
        #[arg(long)]
        open: bool,
        /// Write only the JSON data (for UI development)
        #[arg(long)]
        data: bool,
    },
    /// Run local checks without opening a window
    Checks {
        /// Print a JSON summary
        #[arg(long)]
        json: bool,
        /// Only run these checks
        names: Vec<String>,
    },
    /// List the checks that would run
    ListChecks,
}

#[derive(Copy, Clone, Debug, ValueEnum, PartialEq)]
enum Format {
    Markdown,
    Json,
}

/// The snapshot currently shown, shared cheaply between IPC calls.
struct Current {
    snapshot: Snapshot,
    ends: DiffEnds,
    remote: Option<String>,
}

struct AppState {
    git: Git,
    /// `STATE_DIR` inside the git dir, resolved once.
    state_dir: PathBuf,
    opts: Options,
    format: Format,
    selftest: bool,
    /// A self-test reported and ends the run: no review result on stdout.
    selftest_reported: AtomicBool,
    loaded_once: AtomicBool,
    current: Mutex<Option<Arc<Current>>>,
    result: Mutex<Option<(serde_json::Value, String)>>,
    running: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    /// Each check's last run as the page knows it (status, exit code, output), so a reloaded tab
    /// catches up.
    check_runs: Arc<Mutex<HashMap<String, CheckRun>>>,
    /// One write of the state file at a time (a browser tab's saves arrive on several threads).
    state_lock: Mutex<()>,
    /// One snapshot at a time; only the newest asked for becomes current.
    snapshot_lock: Mutex<()>,
    snapshot_ticket: std::sync::atomic::AtomicU64,
    /// The review was taken: later saves (still on their way) must not bring its comments back.
    submitted: AtomicBool,
}

#[derive(Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CheckRun {
    status: String,
    exit_code: Option<i32>,
    output: String,
}

/// Output kept per check for a reloaded tab (the page keeps 200 000 characters).
const CHECK_OUTPUT_KEPT: usize = 256 * 1024;

/// What the page asks for, the same in a browser tab (HTTP, serve.rs) and in the native window
/// (`--window`, Tauri IPC). Blocking: callers run them off the UI thread.
impl AppState {
    fn new(git: Git, opts: Options, format: Format, selftest: bool) -> AppState {
        AppState {
            state_dir: git.git_path(STATE_DIR),
            git,
            opts,
            format,
            selftest,
            selftest_reported: AtomicBool::new(false),
            loaded_once: AtomicBool::new(false),
            current: Mutex::new(None),
            result: Mutex::new(None),
            running: Arc::new(Mutex::new(HashMap::new())),
            check_runs: Arc::new(Mutex::new(HashMap::new())),
            state_lock: Mutex::new(()),
            snapshot_lock: Mutex::new(()),
            snapshot_ticket: std::sync::atomic::AtomicU64::new(0),
            submitted: AtomicBool::new(false),
        }
    }

    fn current(&self) -> Option<Arc<Current>> {
        self.current.lock().ok().and_then(|c| c.clone())
    }

    fn snapshot(&self, from: Option<String>, to: Option<String>) -> Result<Snapshot, String> {
        // Ranges come from the commit menu: only full commit ids of this branch are accepted.
        if let Some(cur) = self.current() {
            for r in [&from, &to].into_iter().flatten() {
                if !is_sha(r) || !cur.snapshot.commits.iter().any(|c| &c.sha == r) {
                    return Err(format!("unknown commit `{r}`"));
                }
            }
        } else if from.is_some() || to.is_some() {
            return Err("load the full comparison first".into());
        }
        let range = RangeInfo { from, to };
        let ticket = self.snapshot_ticket.fetch_add(1, Ordering::SeqCst) + 1;
        let newest = || self.snapshot_ticket.load(Ordering::SeqCst) == ticket;
        let _one = self.snapshot_lock.lock().map_err(|e| e.to_string())?;
        // A newer one was asked for meanwhile: this answer would be stale (the page ignores it).
        if !newest() {
            return Err("superseded by a newer load".into());
        }
        let mut opts = self.opts.clone();
        // Fetch until a load has succeeded once.
        if self.loaded_once.load(Ordering::SeqCst) {
            opts.fetch = false;
        }
        let r = git::snapshot(&self.git, &opts, &range)?;
        self.loaded_once.store(true, Ordering::SeqCst);
        if !newest() {
            return Err("superseded by a newer load".into());
        }
        let snap = r.snapshot.clone();
        *self.current.lock().map_err(|e| e.to_string())? = Some(Arc::new(Current { snapshot: r.snapshot, ends: r.ends, remote: r.remote }));
        Ok(snap)
    }

    fn contents(&self, path: &str, side: &str) -> Option<String> {
        let cur = self.current()?;
        git::contents(&self.git, &cur.ends, &cur.snapshot.files, path, side)
    }

    fn image(&self, path: &str, side: &str) -> Option<String> {
        let cur = self.current()?;
        git::image(&self.git, &cur.ends, &cur.snapshot.files, path, side)
    }

    fn load_state(&self) -> Option<serde_json::Value> {
        read_state(&self.state_dir, &self.current()?.snapshot.head.name)
    }

    fn save_state(&self, state: &serde_json::Value) -> Result<(), String> {
        if !state.is_object() {
            return Err("the state must be an object".into());
        }
        let Some(cur) = self.current() else { return Ok(()) };
        let _one = self.state_lock.lock().map_err(|e| e.to_string())?;
        // After the submit, a save still on its way keeps what it says except the comments.
        let mut state = state.clone();
        if self.submitted.load(Ordering::SeqCst) {
            if let Some(obj) = state.as_object_mut() {
                obj.insert("drafts".into(), serde_json::json!([]));
            }
        }
        write_state(&self.state_dir, &cur.snapshot.head.name, &state)
    }

    fn check_runs(&self) -> Vec<(String, CheckRun)> {
        self.check_runs.lock().map(|r| r.iter().map(|(k, v)| (k.clone(), v.clone())).collect()).unwrap_or_default()
    }

    fn list_checks(&self) -> Result<Vec<CheckDef>, String> {
        checks::discover(&self.git.root)
    }

    /// Starts a check; `emit` gets its progress (status changes and output, as the page's `CheckEvent`).
    fn run_check(&self, name: &str, emit: impl Fn(serde_json::Value) + Send + 'static) -> Result<(), String> {
        let defs = checks::discover(&self.git.root)?;
        let def = defs.into_iter().find(|d| d.name == name).ok_or(format!("unknown check `{name}`"))?;
        let cancel = Arc::new(AtomicBool::new(false));
        {
            let mut running = self.running.lock().map_err(|e| e.to_string())?;
            if running.contains_key(name) {
                return Err(format!("`{name}` is already running"));
            }
            running.insert(name.to_string(), cancel.clone());
        }
        let env = self.current().map(|c| check_env(&c.snapshot)).unwrap_or_default();
        let root = self.git.root.clone();
        let running = self.running.clone();
        let runs = self.check_runs.clone();
        let name = def.name.clone();
        std::thread::spawn(move || {
            let event = |status: Option<&str>, chunk: Option<&str>, code: Option<i32>| {
                // Sent while the record is locked: a page that joins now (serve.rs) finds each
                // event either in the record or on its stream, never in both.
                let mut runs = runs.lock();
                if let Ok(runs) = runs.as_mut() {
                    let run = runs.entry(def.name.clone()).or_default();
                    if let Some(s) = status {
                        if s == "running" {
                            run.output.clear();
                        }
                        run.status = s.to_string();
                        run.exit_code = code;
                    }
                    if let Some(c) = chunk {
                        run.output.push_str(c);
                        if run.output.len() > 2 * CHECK_OUTPUT_KEPT {
                            proc::keep_tail(&mut run.output, CHECK_OUTPUT_KEPT);
                        }
                    }
                }
                // Finished: free to run again only now, after its result is recorded, so a new
                // run never gets this one's result.
                if status.is_some_and(|s| s != "running") {
                    if let Ok(mut running) = running.lock() {
                        running.remove(&name);
                    }
                }
                emit(serde_json::json!({ "name": def.name, "status": status, "chunk": chunk, "exitCode": code }))
            };
            event(Some("running"), None, None);
            // Output arrives batched (at most ~10 events per second).
            let code = checks::run(&def, &root, &env, &cancel, Some(256 * 1024), |c| event(None, Some(c), None));
            let status = if cancel.load(Ordering::SeqCst) {
                "cancelled"
            } else if code == Some(0) {
                "success"
            } else {
                "failure"
            };
            event(Some(status), None, code);
        });
        Ok(())
    }

    fn cancel_check(&self, name: &str) -> Result<(), String> {
        if let Some(flag) = self.running.lock().map_err(|e| e.to_string())?.get(name) {
            flag.store(true, Ordering::SeqCst);
        }
        Ok(())
    }

    fn find_pr(&self) -> Result<Option<ExistingPr>, String> {
        let Some(cur) = self.current() else { return Ok(None) };
        publish::find_pr(&self.git, &cur.snapshot)
    }

    fn publish(&self, req: &PublishRequest) -> Result<PublishResult, String> {
        let Some(cur) = self.current() else { return Err("nothing loaded".into()) };
        publish::publish(&self.git, cur.remote.as_deref(), &cur.snapshot, req)
    }

    /// Keeps the review for stdout; the caller ends the run.
    fn submit(&self, result: serde_json::Value, markdown: String) {
        // Submitted comments must not come back as pending drafts next time.
        let _one = self.state_lock.lock();
        self.submitted.store(true, Ordering::SeqCst);
        if let Some(cur) = self.current() {
            if let Some(mut st) = read_state(&self.state_dir, &cur.snapshot.head.name) {
                if let Some(obj) = st.as_object_mut() {
                    obj.insert("drafts".into(), serde_json::json!([]));
                    let _ = write_state(&self.state_dir, &cur.snapshot.head.name, &st);
                }
            }
        }
        if let Ok(mut r) = self.result.lock() {
            *r = Some((result, markdown));
        }
    }

    /// Opens a changed file in a text editor. Never hands the file to an OS
    /// launcher (which could execute scripts or app bundles from the repository).
    fn open_in_editor(&self, path: &str) -> Result<(), String> {
        let cur = self.current().ok_or("nothing loaded")?;
        if !cur.snapshot.files.iter().any(|f| f.path == path && f.status != "deleted") {
            return Err("not a changed file".into());
        }
        // Canonical paths are only used for the containment check (Windows returns \\?\ paths).
        let root = self.git.root.canonicalize().map_err(|e| e.to_string())?;
        let canonical = self.git.root.join(path).canonicalize().map_err(|e| e.to_string())?;
        if !canonical.starts_with(&root) || !canonical.is_file() {
            return Err("the file is outside the repository".into());
        }
        let f = self.git.root.join(path).to_string_lossy().into_owned();
        let target = format!("{f}:1");
        // Not on our stdout (the review printed there is what the caller reads; an editor still
        // open would also keep it from ending), not in our process group.
        let spawn = |prog: &str, args: &[&str]| {
            use std::process::Stdio;
            let mut cmd = std::process::Command::new(prog);
            cmd.args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
            proc::own_group(&mut cmd);
            // One that ends at once with an error (a terminal editor without a terminal) did not open.
            cmd.spawn().is_ok_and(|mut child| {
                std::thread::sleep(Duration::from_millis(300));
                !matches!(child.try_wait(), Ok(Some(status)) if !status.success())
            })
        };
        if let Ok(editor) = std::env::var("GH_PRV_LOCAL_EDITOR") {
            if !editor.trim().is_empty() && spawn(editor.trim(), &[&f]) {
                return Ok(());
            }
        }
        let code = if cfg!(windows) { "code.cmd" } else { "code" };
        if spawn(code, &["-g", &target]) {
            return Ok(());
        }
        let ok = if cfg!(target_os = "macos") {
            spawn("open", &["-t", &f]) // -t: always the default *text editor*
        } else if cfg!(windows) {
            spawn("notepad.exe", &[&f])
        } else {
            false
        };
        if ok {
            Ok(())
        } else {
            Err("no editor found: install the VS Code `code` command or set GH_PRV_LOCAL_EDITOR (e.g. GH_PRV_LOCAL_EDITOR=gedit)".into())
        }
    }

    /// The end of a run: stops running checks, then prints the review (or that none was given).
    fn finish(&self) {
        let any = self.running.lock().map(|running| {
            for flag in running.values() {
                flag.store(true, Ordering::SeqCst);
            }
            !running.is_empty()
        });
        if any.unwrap_or(false) {
            // Give the runner threads a moment (at most 400ms) to kill their process trees;
            // each leaves `running` once its tree is gone.
            let deadline = Instant::now() + Duration::from_millis(400);
            while Instant::now() < deadline && self.running.lock().is_ok_and(|r| !r.is_empty()) {
                std::thread::sleep(Duration::from_millis(10));
            }
        }
        if !self.selftest_reported.load(Ordering::SeqCst) {
            let result = self.result.lock().ok().and_then(|r| r.clone());
            print_result(self.format, &result);
        }
    }
}

fn fnv(s: &str) -> u32 {
    s.bytes().fold(0x811c9dc5u32, |h, b| (h ^ b as u32).wrapping_mul(0x01000193))
}

/// Per-repository state (pending comments, viewed files, the last review), inside the git dir.
pub const STATE_DIR: &str = "gh-prv-local";

fn state_file(state_dir: &Path, branch: &str) -> PathBuf {
    let safe: String = branch
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '.' { c } else { '_' })
        .collect();
    state_dir.join(format!("state-{safe}-{:08x}.json", fnv(branch)))
}

fn read_state(state_dir: &Path, branch: &str) -> Option<serde_json::Value> {
    std::fs::read_to_string(state_file(state_dir, branch)).ok().and_then(|t| serde_json::from_str(&t).ok())
}

fn write_state(state_dir: &Path, branch: &str, state: &serde_json::Value) -> Result<(), String> {
    let p = state_file(state_dir, branch);
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    // Its own temporary file, so two runs on the branch never mix their writes.
    let tmp = p.with_extension(format!("{}.tmp", unique_name("json")));
    let written = std::fs::write(&tmp, serde_json::to_vec_pretty(state).unwrap_or_default()).and_then(|_| std::fs::rename(&tmp, &p));
    if written.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    written.map_err(|e| e.to_string())
}

/// `<prefix>-<pid>-<nanoseconds>`: a file name no other gh-prv-local run picks at the same time.
pub fn unique_name(prefix: &str) -> String {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    format!("{prefix}-{}-{nanos}", std::process::id())
}

fn is_sha(s: &str) -> bool {
    (s.len() == 40 || s.len() == 64) && s.chars().all(|c| c.is_ascii_hexdigit())
}

fn check_env(snap: &Snapshot) -> Vec<(String, String)> {
    vec![
        ("GH_PRV_LOCAL_BASE".into(), snap.base.reference.clone()),
        ("GH_PRV_LOCAL_BASE_SHA".into(), snap.base.sha.clone()),
        ("GH_PRV_LOCAL_HEAD".into(), snap.head.sha.clone()),
        ("GH_PRV_LOCAL_MERGE_BASE".into(), snap.merge_base.clone()),
        ("GH_PRV_LOCAL_CHANGED_FILES".into(), git::changed_paths(&snap.files)),
    ]
}

/* ---------------- The native window's commands (Tauri IPC) ---------------- */

type App<'a> = State<'a, Arc<AppState>>;

/// Runs a blocking call of the state on a worker thread.
async fn blocking<T: Send + 'static>(app: &App<'_>, f: impl FnOnce(&AppState) -> T + Send + 'static) -> Result<T, String> {
    let st = Arc::clone(app.inner());
    tauri::async_runtime::spawn_blocking(move || f(&st)).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_snapshot(app: App<'_>, from: Option<String>, to: Option<String>) -> Result<Snapshot, String> {
    blocking(&app, move |st| st.snapshot(from, to)).await?
}

#[tauri::command]
async fn get_contents(app: App<'_>, path: String, side: String) -> Result<Option<String>, String> {
    blocking(&app, move |st| st.contents(&path, &side)).await
}

#[tauri::command]
async fn get_image(app: App<'_>, path: String, side: String) -> Result<Option<String>, String> {
    blocking(&app, move |st| st.image(&path, &side)).await
}

#[tauri::command]
fn load_state(app: App<'_>) -> Option<serde_json::Value> {
    app.load_state()
}

#[tauri::command]
fn save_state(app: App<'_>, state: serde_json::Value) -> Result<(), String> {
    app.save_state(&state)
}

#[tauri::command]
fn list_checks(app: App<'_>) -> Result<Vec<CheckDef>, String> {
    app.list_checks()
}

#[tauri::command]
fn run_check(handle: tauri::AppHandle, app: App<'_>, name: String) -> Result<(), String> {
    app.run_check(&name, move |e| {
        let _ = handle.emit("check-event", e);
    })
}

#[tauri::command]
fn check_runs(app: App<'_>) -> Vec<(String, CheckRun)> {
    app.check_runs()
}

#[tauri::command]
fn cancel_check(app: App<'_>, name: String) -> Result<(), String> {
    app.cancel_check(&name)
}

#[tauri::command]
async fn find_pr(app: App<'_>) -> Result<Option<ExistingPr>, String> {
    blocking(&app, |st| st.find_pr()).await?
}

#[tauri::command]
async fn publish(app: App<'_>, req: PublishRequest) -> Result<PublishResult, String> {
    blocking(&app, move |st| st.publish(&req)).await?
}

#[tauri::command]
fn submit_review(handle: tauri::AppHandle, app: App<'_>, result: serde_json::Value, markdown: String) {
    app.submit(result, markdown);
    handle.exit(0);
}

/// `GH_PRV_LOCAL_SELFTEST=flows`: a progress report from the UI that does not end the run (the run ends
/// the normal way, through Confirm). Ignored outside self-tests.
#[tauri::command]
fn selftest_log(app: App<'_>, report: serde_json::Value) {
    if app.selftest {
        print_report(&report);
    }
}

/// `GH_PRV_LOCAL_SELFTEST` (`1` or `flows`); empty or `0` is off.
fn selftest_mode() -> Option<String> {
    std::env::var("GH_PRV_LOCAL_SELFTEST").ok().filter(|v| !v.is_empty() && v != "0")
}

fn print_report(report: &serde_json::Value) {
    println!("{}", serde_json::to_string(report).unwrap_or_default());
    let _ = std::io::stdout().flush();
}

/// End-to-end check used by `GH_PRV_LOCAL_SELFTEST=1 gh-prv-local`: the UI reports what it rendered. Leaves through
/// the normal exit, which also stops checks still running (exit code 0 when ok, else 3).
#[tauri::command]
fn selftest_done(handle: tauri::AppHandle, app: App<'_>, report: serde_json::Value) {
    if !app.selftest {
        return;
    }
    print_report(&report);
    app.selftest_reported.store(true, Ordering::SeqCst);
    handle.exit(if report.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) { 0 } else { 3 });
}

/// Browser-like zoom for the window (Cmd/Ctrl + `=` / `-` / `0` in the UI).
#[tauri::command]
fn set_zoom(window: tauri::WebviewWindow, scale: f64) -> Result<(), String> {
    if !scale.is_finite() {
        return Err("invalid zoom".into());
    }
    window.set_zoom(scale.clamp(0.25, 5.0)).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_in_editor(app: App<'_>, path: String) -> Result<(), String> {
    app.open_in_editor(&path)
}

/// Opens an http(s) URL or a local HTML file in the default browser.
fn open_external(target: &str) {
    let mut cmd = if cfg!(target_os = "macos") {
        std::process::Command::new("open")
    } else if cfg!(windows) {
        std::process::Command::new("explorer.exe")
    } else {
        std::process::Command::new("xdg-open")
    };
    // Not on our stdout: the review printed there is what the caller reads.
    use std::process::Stdio;
    let _ = cmd.arg(target).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn();
}

fn print_result(format: Format, result: &Option<(serde_json::Value, String)>) {
    let mut out = std::io::stdout().lock();
    match (format, result) {
        (Format::Json, Some((json, _))) => {
            let _ = writeln!(out, "{}", serde_json::to_string_pretty(json).unwrap_or_default());
        }
        (Format::Markdown, Some((_, md))) => {
            let _ = writeln!(out, "{md}");
        }
        (Format::Json, None) => {
            let _ = writeln!(out, "{{\"event\":\"CLOSED\",\"comments\":[]}}");
        }
        (Format::Markdown, None) => {
            let _ = writeln!(
                out,
                "# Pull request preview: closed\n\nThe preview was closed without submitting a review. No feedback was given."
            );
        }
    }
    let _ = out.flush();
}

fn fail(msg: impl std::fmt::Display) -> ! {
    eprintln!("gh-prv-local: {msg}");
    std::process::exit(1)
}

/// Creates a new, private file (0600 on Unix) without following existing paths.
fn create_private(path: &Path) -> std::io::Result<std::fs::File> {
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(0o600);
    }
    o.open(path)
}

fn main() {
    // gh-prv-local talks to the repository's origin only. The GitHub CLI (used on Confirm and to find an
    // open pull request) would otherwise send telemetry and check for updates; every child
    // process (gh, git and its credential helpers, local checks) inherits these.
    for (key, value) in [
        ("GH_TELEMETRY", "false"),
        ("DO_NOT_TRACK", "1"),
        ("GH_NO_UPDATE_NOTIFIER", "1"),
        ("GH_NO_EXTENSION_UPDATE_NOTIFIER", "1"),
    ] {
        std::env::set_var(key, value);
    }
    let cli = Cli::parse();
    let cwd = cli.dir.clone().unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| ".".into()));
    let git = Git::discover(&cwd).unwrap_or_else(|e| fail(e));
    let opts = Options { base: cli.base.clone(), head: cli.head.clone(), fetch: !cli.no_fetch, uncommitted: cli.uncommitted };

    match cli.command {
        Some(Cmd::Export { output, open, data }) => {
            let r = git::snapshot(&git, &opts, &RangeInfo::default()).unwrap_or_else(|e| fail(e));
            let json = export::data_json(&git, &r);
            let body = if data { serde_json::to_string(&json).unwrap_or_default() } else { export::html(&json) };
            let path = match output {
                Some(p) => {
                    std::fs::write(&p, body).unwrap_or_else(|e| fail(e));
                    p
                }
                None => {
                    let name: String = format!("gh-prv-local-{}-{}", r.snapshot.repo.name, r.snapshot.head.name)
                        .chars()
                        .map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' })
                        .collect();
                    let p = std::env::temp_dir().join(format!("{}.{}", unique_name(&name), if data { "json" } else { "html" }));
                    let mut f = create_private(&p).unwrap_or_else(|e| fail(e));
                    f.write_all(body.as_bytes()).unwrap_or_else(|e| fail(e));
                    p
                }
            };
            println!("{}", path.display());
            if open {
                open_external(&path.to_string_lossy());
            }
        }
        Some(Cmd::ListChecks) => {
            for c in checks::discover(&git.root).unwrap_or_else(|e| fail(e)) {
                println!("{}\t{}\t({})", c.name, c.run, c.source);
            }
        }
        Some(Cmd::Checks { json, names }) => {
            let mut o = opts.clone();
            o.fetch = false;
            let r = git::snapshot(&git, &o, &RangeInfo::default()).unwrap_or_else(|e| fail(e));
            let env = check_env(&r.snapshot);
            let defs: Vec<_> = checks::discover(&git.root)
                .unwrap_or_else(|e| fail(e))
                .into_iter()
                .filter(|d| names.is_empty() || names.contains(&d.name))
                .collect();
            if defs.is_empty() {
                fail("no checks found (add a .gh-prv-local.toml)");
            }
            static STOP: AtomicBool = AtomicBool::new(false);
            // Ctrl-C / SIGTERM: stop the running check's whole process group, then exit.
            proc::on_terminate(|| STOP.store(true, Ordering::SeqCst));
            let mut results = vec![];
            for d in &defs {
                if STOP.load(Ordering::SeqCst) {
                    break;
                }
                if !json {
                    eprintln!("── {} ── $ {}", d.name, d.run);
                }
                let mut output = String::new();
                let code = checks::run(d, &git.root, &env, &STOP, None, |c| {
                    if !json {
                        eprint!("{c}");
                    }
                    // Only the tail is kept for the summary; without --json the full output also streams to stderr.
                    output.push_str(c);
                    if output.len() > 64 * 1024 {
                        // At least 4096 characters follow keep_tail's marker: it never reaches the 4000-character tail below.
                        proc::keep_tail(&mut output, 16 * 1024);
                    }
                });
                let ok = code == Some(0);
                if !json {
                    let how = match code {
                        Some(c) => format!("exit {c}"),
                        None if STOP.load(Ordering::SeqCst) => "interrupted".into(),
                        None => "timed out".into(),
                    };
                    eprintln!("{} {} ({how})\n", if ok { "✓" } else { "✗" }, d.name);
                }
                let tail: String = output.chars().rev().take(4000).collect::<Vec<_>>().into_iter().rev().collect();
                results.push(serde_json::json!({ "name": d.name, "run": d.run, "success": ok, "exitCode": code, "outputTail": tail }));
            }
            if STOP.load(Ordering::SeqCst) {
                eprintln!("gh-prv-local: interrupted");
                std::process::exit(130);
            }
            let failed = results.iter().filter(|r| r["success"] == false).count();
            if json {
                println!("{}", serde_json::to_string_pretty(&results).unwrap_or_default());
            } else {
                println!("{} of {} checks passed", results.len() - failed, results.len());
            }
            std::process::exit(if failed > 0 { 1 } else { 0 });
        }
        // The self-tests exercise the native window.
        None if cli.window || selftest_mode().is_some() => run_window(git, opts, cli.format),
        None => {
            let browser = cli.browser.or_else(|| std::env::var("GH_PRV_LOCAL_BROWSER").ok()).unwrap_or_default();
            serve::run(Arc::new(AppState::new(git, opts, cli.format, false)), browser.trim())
        }
    }
}

/// URLs the window itself may load: the embedded UI only.
fn is_app_url(url: &tauri::Url) -> bool {
    matches!(url.scheme(), "tauri" | "about" | "data" | "blob")
        || (url.scheme() == "http" && url.host_str() == Some("tauri.localhost"))
        || (url.scheme() == "https" && url.host_str() == Some("tauri.localhost"))
        || (cfg!(debug_assertions) && url.host_str() == Some("localhost"))
}

fn run_window(git: Git, opts: Options, format: Format) {
    #[cfg(target_os = "linux")]
    if std::env::var_os("DISPLAY").is_none() && std::env::var_os("WAYLAND_DISPLAY").is_none() {
        fail("no display available. Use `gh-prv-local export` to write a static HTML preview instead.");
    }
    let title = format!(
        "Pull request preview · {}",
        git.root.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
    );
    let selftest = selftest_mode().is_some();
    let flows = selftest_mode().as_deref() == Some("flows");
    // `flows` clicks Confirm, which pushes and opens a pull request: only in a scratch repository
    // that scripts/native-selftest.sh prepared (and marked).
    if flows {
        if !git.git_path("gh-prv-local-selftest").exists() {
            fail("GH_PRV_LOCAL_SELFTEST=flows pushes and opens a pull request, so it only runs in a scratch repository prepared by scripts/native-selftest.sh");
        }
    }
    let state = Arc::new(AppState::new(git, opts, format, selftest));
    let app = tauri::Builder::default()
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            get_snapshot,
            get_contents,
            get_image,
            load_state,
            save_state,
            list_checks,
            run_check,
            cancel_check,
            check_runs,
            find_pr,
            publish,
            submit_review,
            open_in_editor,
            set_zoom,
            selftest_log,
            selftest_done
        ])
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Regular);
            // Ctrl-C / SIGTERM / SIGHUP (e.g. the agent stops gh-prv-local): exit cleanly so running checks are killed.
            let handle = app.handle().clone();
            proc::on_terminate(move || handle.exit(130));
            let mut builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                // Links (PR template, comments) open in the browser instead of replacing the UI.
                .on_navigation(|url| {
                    if is_app_url(url) {
                        return true;
                    }
                    if matches!(url.scheme(), "http" | "https") {
                        open_external(url.as_str());
                    }
                    false
                });
            #[cfg(target_os = "macos")]
            if selftest {
                // A window that is not on screen (display asleep, another Space) has its WebView
                // suspended by WebKit, which would stall the self-test's timers. macOS 14+.
                use objc2::runtime::NSObjectProtocol;
                use objc2_web_kit::{WKInactiveSchedulingPolicy, WKWebViewConfiguration};
                if let Some(mtm) = objc2::MainThreadMarker::new() {
                    let config = unsafe { WKWebViewConfiguration::new(mtm) };
                    let prefs = unsafe { config.preferences() };
                    if prefs.respondsToSelector(objc2::sel!(setInactiveSchedulingPolicy:)) {
                        unsafe { prefs.setInactiveSchedulingPolicy(WKInactiveSchedulingPolicy::None) };
                        builder = builder.with_webview_configuration(config);
                    }
                }
            }
            if selftest {
                // `flows` also drives commit ranges, local checks and Confirm (scripts/native-selftest.sh).
                let mode = if flows { "\"flows\"" } else { "true" };
                builder = builder.initialization_script(&format!("window.__PRV_SELFTEST__ = {mode};"));
            }
            let w = builder
                .title(&title)
                .inner_size(1440.0, 900.0)
                .min_inner_size(320.0, 360.0)
                .center()
                .build()?;
            let _ = w.set_focus();
            Ok(())
        })
        .build(tauri::generate_context!())
        .unwrap_or_else(|e| fail(e));
    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            // Stops running checks with the window and prints the review.
            handle.state::<Arc<AppState>>().finish();
        }
    });
}
