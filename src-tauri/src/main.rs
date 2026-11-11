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
    long_about = "Opens your branch in a GitHub-style \"Files changed\" view (merge-base...HEAD, like a pull request).\n\
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
    running: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl AppState {
    fn current(&self) -> Option<Arc<Current>> {
        self.current.lock().ok().and_then(|c| c.clone())
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
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(state).unwrap_or_default()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

/// `<prefix>-<pid>-<nanoseconds>`: a file name no other gh-prv-local run picks at the same time.
pub fn unique_name(prefix: &str) -> String {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    format!("{prefix}-{}-{nanos}", std::process::id())
}

fn is_sha(s: &str) -> bool {
    (s.len() == 40 || s.len() == 64) && s.chars().all(|c| c.is_ascii_hexdigit())
}

#[tauri::command]
async fn get_snapshot(app: State<'_, AppState>, from: Option<String>, to: Option<String>) -> Result<Snapshot, String> {
    // Ranges come from the commit menu: only full commit ids of this branch are accepted.
    if let Some(cur) = app.current() {
        for r in [&from, &to].into_iter().flatten() {
            if !is_sha(r) || !cur.snapshot.commits.iter().any(|c| &c.sha == r) {
                return Err(format!("unknown commit `{r}`"));
            }
        }
    } else if from.is_some() || to.is_some() {
        return Err("load the full comparison first".into());
    }
    let range = RangeInfo { from, to };
    let git = app.git.clone();
    let mut opts = app.opts.clone();
    // Fetch only once, on the first load.
    if app.loaded_once.swap(true, Ordering::SeqCst) {
        opts.fetch = false;
    }
    let r = tauri::async_runtime::spawn_blocking(move || git::snapshot(&git, &opts, &range))
        .await
        .map_err(|e| e.to_string())??;
    let snap = r.snapshot.clone();
    *app.current.lock().map_err(|e| e.to_string())? = Some(Arc::new(Current { snapshot: r.snapshot, ends: r.ends, remote: r.remote }));
    Ok(snap)
}

#[tauri::command]
async fn get_contents(app: State<'_, AppState>, path: String, side: String) -> Result<Option<String>, String> {
    let Some(cur) = app.current() else { return Ok(None) };
    let git = app.git.clone();
    tauri::async_runtime::spawn_blocking(move || git::contents(&git, &cur.ends, &cur.snapshot.files, &path, &side))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn load_state(app: State<'_, AppState>) -> Result<Option<serde_json::Value>, String> {
    let Some(cur) = app.current() else { return Ok(None) };
    Ok(read_state(&app.state_dir, &cur.snapshot.head.name))
}

#[tauri::command]
fn save_state(app: State<'_, AppState>, state: serde_json::Value) -> Result<(), String> {
    let Some(cur) = app.current() else { return Ok(()) };
    write_state(&app.state_dir, &cur.snapshot.head.name, &state)
}

#[tauri::command]
fn list_checks(app: State<'_, AppState>) -> Result<Vec<CheckDef>, String> {
    checks::discover(&app.git.root)
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

#[tauri::command]
fn run_check(handle: tauri::AppHandle, app: State<'_, AppState>, name: String) -> Result<(), String> {
    let defs = checks::discover(&app.git.root)?;
    let def = defs.into_iter().find(|d| d.name == name).ok_or(format!("unknown check `{name}`"))?;
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut running = app.running.lock().map_err(|e| e.to_string())?;
        if running.contains_key(&name) {
            return Err(format!("`{name}` is already running"));
        }
        running.insert(name.clone(), cancel.clone());
    }
    let env = app.current().map(|c| check_env(&c.snapshot)).unwrap_or_default();
    let root = app.git.root.clone();
    std::thread::spawn(move || {
        let emit = |status: Option<&str>, chunk: Option<&str>, code: Option<i32>| {
            let _ = handle.emit(
                "check-event",
                serde_json::json!({ "name": def.name, "status": status, "chunk": chunk, "exitCode": code }),
            );
        };
        emit(Some("running"), None, None);
        // Output arrives batched (at most ~10 events per second).
        let code = checks::run(&def, &root, &env, &cancel, Some(256 * 1024), |c| emit(None, Some(c), None));
        let status = if cancel.load(Ordering::SeqCst) {
            "cancelled"
        } else if code == Some(0) {
            "success"
        } else {
            "failure"
        };
        if let Ok(mut running) = handle.state::<AppState>().running.lock() {
            running.remove(&def.name);
        }
        emit(Some(status), None, code);
    });
    Ok(())
}

#[tauri::command]
fn cancel_check(app: State<'_, AppState>, name: String) -> Result<(), String> {
    if let Some(flag) = app.running.lock().map_err(|e| e.to_string())?.get(&name) {
        flag.store(true, Ordering::SeqCst);
    }
    Ok(())
}

#[tauri::command]
async fn find_pr(app: State<'_, AppState>) -> Result<Option<ExistingPr>, String> {
    let Some(cur) = app.current() else { return Ok(None) };
    let git = app.git.clone();
    tauri::async_runtime::spawn_blocking(move || publish::find_pr(&git, &cur.snapshot))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn publish(app: State<'_, AppState>, req: PublishRequest) -> Result<PublishResult, String> {
    let Some(cur) = app.current() else { return Err("nothing loaded".into()) };
    let git = app.git.clone();
    tauri::async_runtime::spawn_blocking(move || publish::publish(&git, cur.remote.as_deref(), &cur.snapshot, &req))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn submit_review(handle: tauri::AppHandle, app: State<'_, AppState>, result: serde_json::Value, markdown: String) {
    // Submitted comments must not come back as pending drafts next time.
    if let Some(cur) = app.current() {
        if let Some(mut st) = read_state(&app.state_dir, &cur.snapshot.head.name) {
            st["drafts"] = serde_json::json!([]);
            let _ = write_state(&app.state_dir, &cur.snapshot.head.name, &st);
        }
    }
    if let Ok(mut r) = app.result.lock() {
        *r = Some((result, markdown));
    }
    handle.exit(0);
}

/// `GH_PRV_LOCAL_SELFTEST=flows`: a progress report from the UI that does not end the run (the run ends
/// the normal way, through Confirm). Ignored outside self-tests.
#[tauri::command]
fn selftest_log(app: State<'_, AppState>, report: serde_json::Value) {
    if app.selftest {
        print_report(&report);
    }
}

fn print_report(report: &serde_json::Value) {
    println!("{}", serde_json::to_string(report).unwrap_or_default());
    let _ = std::io::stdout().flush();
}

/// End-to-end check used by `GH_PRV_LOCAL_SELFTEST=1 gh-prv-local`: the UI reports what it rendered. Leaves through
/// the normal exit, which also stops checks still running (exit code 0 when ok, else 3).
#[tauri::command]
fn selftest_done(handle: tauri::AppHandle, app: State<'_, AppState>, report: serde_json::Value) {
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

/// Opens a changed file in a text editor. Never hands the file to an OS
/// launcher (which could execute scripts or app bundles from the repository).
#[tauri::command]
fn open_in_editor(app: State<'_, AppState>, path: String) -> Result<(), String> {
    let cur = app.current().ok_or("nothing loaded")?;
    if !cur.snapshot.files.iter().any(|f| f.path == path && f.status != "deleted") {
        return Err("not a changed file".into());
    }
    // Canonical paths are only used for the containment check (Windows returns \\?\ paths).
    let root = app.git.root.canonicalize().map_err(|e| e.to_string())?;
    let canonical = app.git.root.join(&path).canonicalize().map_err(|e| e.to_string())?;
    if !canonical.starts_with(&root) || !canonical.is_file() {
        return Err("the file is outside the repository".into());
    }
    let f = app.git.root.join(&path).to_string_lossy().into_owned();
    let target = format!("{f}:1");
    let spawn = |prog: &str, args: &[&str]| std::process::Command::new(prog).args(args).spawn().is_ok();
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

/// Opens an http(s) URL or a local HTML file in the default browser.
fn open_external(target: &str) {
    let mut cmd = if cfg!(target_os = "macos") {
        std::process::Command::new("open")
    } else if cfg!(windows) {
        std::process::Command::new("explorer.exe")
    } else {
        std::process::Command::new("xdg-open")
    };
    let _ = cmd.arg(target).spawn();
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
                "# Pull request preview: closed\n\nThe preview window was closed without submitting a review. No feedback was given."
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
        None => run_window(git, opts, cli.format),
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
    let selftest = std::env::var_os("GH_PRV_LOCAL_SELFTEST").is_some();
    let flows = std::env::var("GH_PRV_LOCAL_SELFTEST").as_deref() == Ok("flows");
    // `flows` clicks Confirm, which pushes and opens a pull request: only in a scratch repository
    // that scripts/native-selftest.sh prepared (and marked).
    if flows {
        if !git.git_path("gh-prv-local-selftest").exists() {
            fail("GH_PRV_LOCAL_SELFTEST=flows pushes and opens a pull request, so it only runs in a scratch repository prepared by scripts/native-selftest.sh");
        }
    }
    let state = AppState {
        state_dir: git.git_path(STATE_DIR),
        git,
        opts,
        format,
        selftest,
        selftest_reported: AtomicBool::new(false),
        loaded_once: AtomicBool::new(false),
        current: Mutex::new(None),
        result: Mutex::new(None),
        running: Mutex::new(HashMap::new()),
    };
    let app = tauri::Builder::default()
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            get_snapshot,
            get_contents,
            load_state,
            save_state,
            list_checks,
            run_check,
            cancel_check,
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
            let st = handle.state::<AppState>();
            // Stop running checks with the window.
            let any = st.running.lock().map(|running| {
                for flag in running.values() {
                    flag.store(true, Ordering::SeqCst);
                }
                !running.is_empty()
            });
            if any.unwrap_or(false) {
                // Give the runner threads a moment (at most 400ms) to kill their process trees;
                // each leaves `running` once its tree is gone.
                let deadline = Instant::now() + Duration::from_millis(400);
                while Instant::now() < deadline && st.running.lock().is_ok_and(|r| !r.is_empty()) {
                    std::thread::sleep(Duration::from_millis(10));
                }
            }
            if !st.selftest_reported.load(Ordering::SeqCst) {
                let result = st.result.lock().ok().and_then(|r| r.clone());
                print_result(st.format, &result);
            }
        }
    });
}
