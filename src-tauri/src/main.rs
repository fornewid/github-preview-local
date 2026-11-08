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
mod publish;

use clap::{Parser, Subcommand, ValueEnum};
use git::{DiffEnds, Git, Options};
use model::*;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
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
        /// Output file (default: a file in the system temp directory)
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

struct AppState {
    git: Git,
    opts: Options,
    format: Format,
    current: Mutex<Option<(Snapshot, DiffEnds, Option<String>)>>,
    result: Mutex<Option<(serde_json::Value, String)>>,
}

fn state_file(git: &Git, branch: &str) -> PathBuf {
    let safe: String = branch.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '.' { c } else { '_' }).collect();
    git.git_path("prv").join(format!("state-{safe}.json"))
}

#[tauri::command]
async fn get_snapshot(app: State<'_, AppState>, from: Option<String>, to: Option<String>) -> Result<Snapshot, String> {
    let range = RangeInfo { from, to };
    let git = app.git.clone();
    let mut opts = app.opts.clone();
    // Fetch only once, on the first load.
    if app.current.lock().unwrap().is_some() {
        opts.fetch = false;
    }
    let r = tauri::async_runtime::spawn_blocking(move || git::snapshot(&git, &opts, &range))
        .await
        .map_err(|e| e.to_string())??;
    let snap = r.snapshot.clone();
    *app.current.lock().unwrap() = Some((r.snapshot, r.ends, r.remote));
    Ok(snap)
}

#[tauri::command]
async fn get_contents(app: State<'_, AppState>, path: String, side: String) -> Result<Option<String>, String> {
    let cur = app.current.lock().unwrap().clone();
    let Some((snap, ends, _)) = cur else { return Ok(None) };
    let git = app.git.clone();
    tauri::async_runtime::spawn_blocking(move || git::contents(&git, &ends, &snap.files, &path, &side))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn load_state(app: State<'_, AppState>) -> Result<Option<serde_json::Value>, String> {
    let cur = app.current.lock().unwrap();
    let Some((snap, _, _)) = cur.as_ref() else { return Ok(None) };
    let p = state_file(&app.git, &snap.head.name);
    Ok(std::fs::read_to_string(p).ok().and_then(|t| serde_json::from_str(&t).ok()))
}

#[tauri::command]
fn save_state(app: State<'_, AppState>, state: serde_json::Value) -> Result<(), String> {
    let cur = app.current.lock().unwrap();
    let Some((snap, _, _)) = cur.as_ref() else { return Ok(()) };
    let p = state_file(&app.git, &snap.head.name);
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(p, serde_json::to_vec_pretty(&state).unwrap_or_default()).map_err(|e| e.to_string())
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
    let env = app.current.lock().unwrap().as_ref().map(|(s, _, _)| check_env(s)).unwrap_or_default();
    let root = app.git.root.clone();
    std::thread::spawn(move || {
        let emit = |status: Option<&str>, chunk: Option<&str>, code: Option<i32>| {
            let _ = handle.emit(
                "check-event",
                serde_json::json!({ "name": def.name, "status": status, "chunk": chunk, "exitCode": code }),
            );
        };
        emit(Some("running"), None, None);
        let code = checks::run(&def, &root, &env, |c| emit(None, Some(c), None));
        let status = if code == Some(0) { "success" } else { "failure" };
        emit(Some(status), None, code);
    });
    Ok(())
}

#[tauri::command]
async fn publish(app: State<'_, AppState>, req: PublishRequest) -> Result<PublishResult, String> {
    let cur = app.current.lock().unwrap().clone();
    let Some((snap, _, remote)) = cur else { return Err("nothing loaded".into()) };
    let git = app.git.clone();
    tauri::async_runtime::spawn_blocking(move || publish::publish(&git, remote.as_deref(), &snap, &req))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn submit_review(handle: tauri::AppHandle, app: State<'_, AppState>, result: serde_json::Value, markdown: String) {
    *app.result.lock().unwrap() = Some((result, markdown));
    handle.exit(0);
}

/// End-to-end check used by `PRV_SELFTEST=1 prv`: the UI reports what it rendered.
#[tauri::command]
fn selftest_done(report: serde_json::Value) {
    println!("{}", serde_json::to_string(&report).unwrap_or_default());
    let _ = std::io::stdout().flush();
    std::process::exit(if report.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) { 0 } else { 3 });
}

#[tauri::command]
fn open_in_editor(app: State<'_, AppState>, path: String, line: Option<u32>) -> Result<(), String> {
    let file = app.git.root.join(&path);
    let target = format!("{}:{}", file.display(), line.unwrap_or(1));
    let try_cmd = |prog: &str, args: &[&str]| std::process::Command::new(prog).args(args).spawn().is_ok();
    if let Ok(editor) = std::env::var("PRV_EDITOR") {
        if try_cmd(&editor, &[&file.to_string_lossy()]) {
            return Ok(());
        }
    }
    if try_cmd("code", &["-g", &target]) {
        return Ok(());
    }
    let f = file.to_string_lossy().into_owned();
    let ok = if cfg!(target_os = "macos") {
        try_cmd("open", &[&f])
    } else if cfg!(windows) {
        try_cmd("cmd", &["/C", "start", "", &f])
    } else {
        try_cmd("xdg-open", &[&f])
    };
    if ok { Ok(()) } else { Err("could not open an editor; set PRV_EDITOR".into()) }
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

fn open_path(p: &std::path::Path) {
    let s = p.to_string_lossy().into_owned();
    let _ = if cfg!(target_os = "macos") {
        std::process::Command::new("open").arg(&s).spawn()
    } else if cfg!(windows) {
        std::process::Command::new("cmd").args(["/C", "start", "", &s]).spawn()
    } else {
        std::process::Command::new("xdg-open").arg(&s).spawn()
    };
}

fn fail(msg: impl std::fmt::Display) -> ! {
    eprintln!("prv: {msg}");
    std::process::exit(1)
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
            let path = output.unwrap_or_else(|| {
                let name: String = format!("prv-{}-{}", r.snapshot.repo.name, r.snapshot.head.name)
                    .chars()
                    .map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' })
                    .collect();
                std::env::temp_dir().join(format!("{name}.{}", if data { "json" } else { "html" }))
            });
            std::fs::write(&path, body).unwrap_or_else(|e| fail(e));
            println!("{}", path.display());
            if open {
                open_path(&path);
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
            let mut results = vec![];
            for d in &defs {
                if !json {
                    eprintln!("── {} ── $ {}", d.name, d.run);
                }
                let mut output = String::new();
                let code = checks::run(d, &git.root, &env, |c| {
                    if !json {
                        eprint!("{c}");
                    }
                    output.push_str(c);
                });
                let ok = code == Some(0);
                if !json {
                    eprintln!("{} {} (exit {})\n", if ok { "✓" } else { "✗" }, d.name, code.map(|c| c.to_string()).unwrap_or("timeout".into()));
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

fn run_window(git: Git, opts: Options, format: Format) {
    #[cfg(target_os = "linux")]
    if std::env::var_os("DISPLAY").is_none() && std::env::var_os("WAYLAND_DISPLAY").is_none() {
        fail("no display available. Use `prv export` to write a static HTML preview instead.");
    }
    let title = format!(
        "Pull request preview · {}",
        git.root.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
    );
    let state = AppState { git, opts, format, current: Mutex::new(None), result: Mutex::new(None) };
    let app = tauri::Builder::default()
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            get_snapshot,
            get_contents,
            load_state,
            save_state,
            list_checks,
            run_check,
            publish,
            submit_review,
            open_in_editor,
            selftest_done
        ])
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Regular);
            let mut builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()));
            if std::env::var_os("PRV_SELFTEST").is_some() {
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
            let result = st.result.lock().unwrap().clone();
            print_result(st.format, &result);
        }
    });
}
