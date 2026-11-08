//! prv — preview your branch as a GitHub pull request, locally.
//!
//! `prv` opens a native window (system WebView, Tauri IPC — no web server)
//! showing the branch the way GitHub's "Files changed" tab would. When you
//! submit a review the result is printed to stdout, so AI agents such as
//! Claude Code can act on it. "Confirm" pushes the branch and opens the PR.

mod checks;
mod export;
mod git;
mod model;
mod proc;
mod publish;

use clap::{Parser, Subcommand, ValueEnum};
use git::{DiffEnds, Git, Options};
use model::*;
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager, RunEvent, State, WebviewUrl, WebviewWindowBuilder};

#[derive(Parser, Debug)]
#[command(
    name = "prv",
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
    opts: Options,
    format: Format,
    selftest: bool,
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

fn state_file(git: &Git, branch: &str) -> PathBuf {
    let safe: String = branch
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '.' { c } else { '_' })
        .collect();
    git.git_path("prv").join(format!("state-{safe}-{:08x}.json", fnv(branch)))
}

fn is_sha(s: &str) -> bool {
    s.len() == 40 && s.chars().all(|c| c.is_ascii_hexdigit())
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
    let p = state_file(&app.git, &cur.snapshot.head.name);
    Ok(std::fs::read_to_string(p).ok().and_then(|t| serde_json::from_str(&t).ok()))
}

fn write_state(git: &Git, branch: &str, state: &serde_json::Value) -> Result<(), String> {
    let p = state_file(git, branch);
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(state).unwrap_or_default()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_state(app: State<'_, AppState>, state: serde_json::Value) -> Result<(), String> {
    let Some(cur) = app.current() else { return Ok(()) };
    write_state(&app.git, &cur.snapshot.head.name, &state)
}

#[tauri::command]
fn list_checks(app: State<'_, AppState>) -> Result<Vec<CheckDef>, String> {
    checks::discover(&app.git.root)
}

fn check_env(snap: &Snapshot) -> Vec<(String, String)> {
    vec![
        ("PRV_BASE".into(), snap.base.reference.clone()),
        ("PRV_BASE_SHA".into(), snap.base.sha.clone()),
        ("PRV_HEAD".into(), snap.head.sha.clone()),
        ("PRV_MERGE_BASE".into(), snap.merge_base.clone()),
        ("PRV_CHANGED_FILES".into(), git::changed_paths(&snap.files)),
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
        // Batch output so the UI re-renders at most ~10 times per second.
        let mut buf = String::new();
        let mut last = Instant::now();
        let code = checks::run(&def, &root, &env, &cancel, |c| {
            buf.push_str(c);
            if last.elapsed() > Duration::from_millis(100) || buf.len() > 64 * 1024 {
                emit(None, Some(&buf), None);
                buf.clear();
                last = Instant::now();
            }
        });
        if !buf.is_empty() {
            emit(None, Some(&buf), None);
        }
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
        let p = state_file(&app.git, &cur.snapshot.head.name);
        if let Some(mut st) = std::fs::read_to_string(&p).ok().and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok()) {
            st["drafts"] = serde_json::json!([]);
            let _ = write_state(&app.git, &cur.snapshot.head.name, &st);
        }
    }
    if let Ok(mut r) = app.result.lock() {
        *r = Some((result, markdown));
    }
    handle.exit(0);
}

/// End-to-end check used by `PRV_SELFTEST=1 prv`: the UI reports what it rendered.
#[tauri::command]
fn selftest_done(app: State<'_, AppState>, report: serde_json::Value) {
    if !app.selftest {
        return;
    }
    println!("{}", serde_json::to_string(&report).unwrap_or_default());
    let _ = std::io::stdout().flush();
    std::process::exit(if report.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) { 0 } else { 3 });
}

/// Opens a changed file in a text editor. Never hands the file to an OS
/// launcher (which could execute scripts or app bundles from the repository).
#[tauri::command]
fn open_in_editor(app: State<'_, AppState>, path: String, line: Option<u32>) -> Result<(), String> {
    let cur = app.current().ok_or("nothing loaded")?;
    if !cur.snapshot.files.iter().any(|f| f.path == path && f.status != "deleted") {
        return Err("not a changed file".into());
    }
    let root = app.git.root.canonicalize().map_err(|e| e.to_string())?;
    let file = root.join(&path).canonicalize().map_err(|e| e.to_string())?;
    if !file.starts_with(&root) || !file.is_file() {
        return Err("the file is outside the repository".into());
    }
    let f = file.to_string_lossy().into_owned();
    let target = format!("{f}:{}", line.unwrap_or(1));
    let spawn = |prog: &str, args: &[&str]| std::process::Command::new(prog).args(args).spawn().is_ok();
    if let Ok(editor) = std::env::var("PRV_EDITOR") {
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
    if ok { Ok(()) } else { Err("no editor found; set PRV_EDITOR (e.g. PRV_EDITOR=subl)".into()) }
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
    eprintln!("prv: {msg}");
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
                    let name: String = format!("prv-{}-{}", r.snapshot.repo.name, r.snapshot.head.name)
                        .chars()
                        .map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' })
                        .collect();
                    let nanos = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.subsec_nanos())
                        .unwrap_or(0);
                    let p = std::env::temp_dir().join(format!(
                        "{name}-{}{nanos:08x}.{}",
                        std::process::id(),
                        if data { "json" } else { "html" }
                    ));
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
                fail("no checks found (add a .prv.toml)");
            }
            let never = AtomicBool::new(false);
            let mut results = vec![];
            for d in &defs {
                if !json {
                    eprintln!("── {} ── $ {}", d.name, d.run);
                }
                let mut output = String::new();
                let code = checks::run(d, &git.root, &env, &never, |c| {
                    if !json {
                        eprint!("{c}");
                    }
                    output.push_str(c);
                });
                let ok = code == Some(0);
                if !json {
                    eprintln!(
                        "{} {} (exit {})\n",
                        if ok { "✓" } else { "✗" },
                        d.name,
                        code.map(|c| c.to_string()).unwrap_or("timeout".into())
                    );
                }
                let tail: String = output.chars().rev().take(4000).collect::<Vec<_>>().into_iter().rev().collect();
                results.push(serde_json::json!({ "name": d.name, "run": d.run, "success": ok, "exitCode": code, "outputTail": tail }));
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
        fail("no display available. Use `prv export` to write a static HTML preview instead.");
    }
    let title = format!(
        "Pull request preview · {}",
        git.root.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
    );
    let selftest = std::env::var_os("PRV_SELFTEST").is_some();
    let state = AppState {
        git,
        opts,
        format,
        selftest,
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
            selftest_done
        ])
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Regular);
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
            if selftest {
                builder = builder.initialization_script("window.__PRV_SELFTEST__ = true;");
            }
            let w = builder
                .title(&title)
                .inner_size(1440.0, 900.0)
                .min_inner_size(720.0, 480.0)
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
                // Give the runner threads a moment to kill their process trees.
                std::thread::sleep(Duration::from_millis(400));
            }
            let result = st.result.lock().ok().and_then(|r| r.clone());
            print_result(st.format, &result);
        }
    });
}
