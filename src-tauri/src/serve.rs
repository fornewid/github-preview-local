//! `gh-prv-local --browser`: the review page in a browser tab instead of the native window. The page
//! is served on 127.0.0.1 for this run only and asks for the same things the window does (see
//! `AppState`) over HTTP. Every API request must carry this run's token, which the page sends in a
//! header (other sites can neither read it nor send such a request without the server allowing it),
//! name this host and port (no DNS rebinding) and come from this origin. The run ends when the
//! review is submitted, when the tab has been gone for a while, or on Ctrl-C.

use crate::model::PublishRequest;
use crate::{export, fail, proc, AppState};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

/// Tried first, so the page's own settings (kept by the browser per origin) carry over between
/// runs; another free port when it is taken. `GH_PRV_LOCAL_PORT` picks one (e.g. for SSH forwarding).
const DEFAULT_PORT: u16 = 19514;
const MAX_HEADERS: u64 = 64 * 1024;
const MAX_BODY: usize = 32 * 1024 * 1024;
/// The tab is taken as closed once no page has been connected for this long (a reload is back
/// well within it).
const GONE_AFTER: Duration = Duration::from_secs(15);
const HEARTBEAT: Duration = Duration::from_secs(5);

struct Server {
    state: Arc<AppState>,
    token: String,
    port: u16,
    /// Open event streams (one per page).
    streams: Mutex<Vec<mpsc::Sender<String>>>,
    pages: AtomicUsize,
    seen_page: AtomicBool,
    last_page: Mutex<Instant>,
    submitted: AtomicBool,
    interrupted: AtomicBool,
}

pub fn run(state: Arc<AppState>, browser: &str) -> ! {
    let port = std::env::var("GH_PRV_LOCAL_PORT").ok().and_then(|p| p.parse().ok());
    let listener = match port {
        Some(p) => TcpListener::bind(("127.0.0.1", p)).unwrap_or_else(|e| fail(format!("cannot listen on 127.0.0.1:{p}: {e}"))),
        None => TcpListener::bind(("127.0.0.1", DEFAULT_PORT))
            .or_else(|_| TcpListener::bind(("127.0.0.1", 0)))
            .unwrap_or_else(|e| fail(format!("cannot listen on 127.0.0.1: {e}"))),
    };
    let port = listener.local_addr().map(|a| a.port()).unwrap_or_else(|e| fail(e));
    let srv = Arc::new(Server {
        state,
        token: token(),
        port,
        streams: Mutex::new(vec![]),
        pages: AtomicUsize::new(0),
        seen_page: AtomicBool::new(false),
        last_page: Mutex::new(Instant::now()),
        submitted: AtomicBool::new(false),
        interrupted: AtomicBool::new(false),
    });
    let url = format!("http://127.0.0.1:{port}/?token={}", srv.token);
    eprintln!("gh-prv-local: reviewing in the browser at {url}");
    open_browser(&url, browser);
    {
        let srv = srv.clone();
        proc::on_terminate(move || srv.interrupted.store(true, Ordering::SeqCst));
    }
    let _ = listener.set_nonblocking(true);
    loop {
        if srv.submitted.load(Ordering::SeqCst) || srv.interrupted.load(Ordering::SeqCst) {
            break;
        }
        let gone = srv.seen_page.load(Ordering::SeqCst)
            && srv.pages.load(Ordering::SeqCst) == 0
            && srv.last_page.lock().map(|t| t.elapsed() > GONE_AFTER).unwrap_or(false);
        if gone {
            break;
        }
        match listener.accept() {
            Ok((stream, _)) => {
                // Accepted sockets inherit the listener's non-blocking mode on macOS and BSDs.
                let _ = stream.set_nonblocking(false);
                let srv = srv.clone();
                std::thread::spawn(move || Server::handle(&srv, stream));
            }
            Err(_) => std::thread::sleep(Duration::from_millis(50)),
        }
    }
    srv.state.finish();
    std::process::exit(if srv.interrupted.load(Ordering::SeqCst) { 130 } else { 0 })
}

/// 128 random bits: SipHash keyed from the OS's random source (std's RandomState), so no extra crate.
fn token() -> String {
    use std::hash::{BuildHasher, Hasher};
    (0..2u64)
        .map(|i| {
            let mut h = std::collections::hash_map::RandomState::new().build_hasher();
            h.write_u64(i);
            format!("{:016x}", h.finish())
        })
        .collect()
}

fn open_browser(url: &str, browser: &str) {
    // `--browser=none`: only the address (open it yourself, e.g. through an SSH tunnel).
    if browser == "none" {
        return;
    }
    let mac_app = |b: &str| match b.to_ascii_lowercase().as_str() {
        "chrome" | "google-chrome" => "Google Chrome".to_string(),
        "edge" => "Microsoft Edge".to_string(),
        "firefox" => "Firefox".to_string(),
        "safari" => "Safari".to_string(),
        _ => b.to_string(),
    };
    let mut cmd = if cfg!(target_os = "macos") {
        let mut c = std::process::Command::new("open");
        if !browser.is_empty() {
            c.args(["-a", &mac_app(browser)]);
        }
        c
    } else if cfg!(windows) {
        let mut c = std::process::Command::new("cmd");
        c.args(["/C", "start", "\"\""]);
        if !browser.is_empty() {
            c.arg(if browser == "edge" { "msedge" } else { browser });
        }
        c
    } else if browser.is_empty() {
        std::process::Command::new("xdg-open")
    } else {
        std::process::Command::new(if browser == "chrome" { "google-chrome" } else { browser })
    };
    if cmd.arg(url).spawn().is_err() {
        eprintln!("gh-prv-local: could not open a browser; open the address above yourself");
    }
}

struct Request {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Request {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }
}

fn read_request(stream: &TcpStream) -> Option<Request> {
    let mut r = BufReader::new(stream.try_clone().ok()?.take(MAX_HEADERS));
    let mut line = String::new();
    r.read_line(&mut line).ok()?;
    let mut parts = line.split_whitespace();
    let (method, target) = (parts.next()?.to_string(), parts.next()?.to_string());
    let mut headers = vec![];
    loop {
        let mut h = String::new();
        if r.read_line(&mut h).ok()? == 0 {
            return None;
        }
        let h = h.trim_end();
        if h.is_empty() {
            break;
        }
        let (k, v) = h.split_once(':')?;
        headers.push((k.trim().to_ascii_lowercase(), v.trim().to_string()));
    }
    let len: usize = headers.iter().find(|(k, _)| k == "content-length").and_then(|(_, v)| v.parse().ok()).unwrap_or(0);
    if len > MAX_BODY {
        return None;
    }
    // The rest of the stream (the header limit no longer applies).
    let buffered = r.buffer().to_vec();
    let mut body = buffered[..buffered.len().min(len)].to_vec();
    if body.len() < len {
        let mut rest = vec![0; len - body.len()];
        (&*stream).read_exact(&mut rest).ok()?;
        body.extend(rest);
    }
    let path = target.split('?').next().unwrap_or("/").to_string();
    Some(Request { method, path, headers, body })
}

fn respond(mut stream: &TcpStream, status: &str, kind: &str, body: &[u8], extra: &[(&str, &str)]) {
    let mut head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nCache-Control: no-store\r\n\
         X-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\n",
        body.len()
    );
    for (k, v) in extra {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    head.push_str("\r\n");
    let _ = stream.write_all(head.as_bytes()).and_then(|_| stream.write_all(body)).and_then(|_| stream.flush());
}

fn to_json<T: serde::Serialize>(v: Result<T, String>) -> Result<Value, String> {
    v.and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
}

/// Constant-time, so the token cannot be guessed byte by byte from response times.
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// The window's CSP, plus no framing by other pages (a header can say that, a meta element cannot).
fn csp() -> String {
    let conf: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap_or_default();
    format!("{}; frame-ancestors 'none'", conf["app"]["security"]["csp"].as_str().unwrap_or("default-src 'self'"))
}

impl Server {
    fn handle(self: &Arc<Self>, stream: TcpStream) {
        let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
        let Some(req) = read_request(&stream) else { return };
        let here = [format!("127.0.0.1:{}", self.port), format!("localhost:{}", self.port)];
        let host_ok = req.header("host").is_some_and(|h| here.iter().any(|x| x == h));
        let origin_ok = req.header("origin").is_none_or(|o| here.iter().any(|x| o == format!("http://{x}")));
        // A link or a form on another site, or a page that frames this one, is refused too.
        let site_ok = req.header("sec-fetch-site").is_none_or(|s| s == "same-origin" || s == "none");
        if !host_ok || !origin_ok || !site_ok {
            return respond(&stream, "403 Forbidden", "text/plain", b"forbidden", &[]);
        }
        match (req.method.as_str(), req.path.as_str()) {
            ("GET", "/") => {
                let page = export::page_with("<script>window.__PRV_SERVER__=true;</script>");
                respond(&stream, "200 OK", "text/html; charset=utf-8", page.as_bytes(), &[("Content-Security-Policy", &csp())])
            }
            (_, path) if path.starts_with("/api/") => {
                if !req.header("x-prv-token").is_some_and(|t| same(t, &self.token)) {
                    return respond(&stream, "401 Unauthorized", "text/plain", b"no or wrong token", &[]);
                }
                match (req.method.as_str(), &path[5..]) {
                    ("GET", "events") => self.events(&stream),
                    ("POST", name) => {
                        let args: Value = serde_json::from_slice(&req.body).unwrap_or(Value::Null);
                        let (status, body) = match self.call(name, &args) {
                            Ok(v) => ("200 OK", json!({ "ok": v })),
                            Err(e) => ("500 Internal Server Error", json!({ "error": e })),
                        };
                        respond(&stream, status, "application/json", body.to_string().as_bytes(), &[]);
                        // The review is printed once the page has its answer.
                        if name == "submit_review" && status.starts_with("200") {
                            self.submitted.store(true, Ordering::SeqCst);
                        }
                    }
                    _ => respond(&stream, "404 Not Found", "text/plain", b"not found", &[]),
                }
            }
            _ => respond(&stream, "404 Not Found", "text/plain", b"not found", &[]),
        }
    }

    /// The page's calls, by the names the native window's commands have.
    fn call(self: &Arc<Self>, name: &str, args: &Value) -> Result<Value, String> {
        let st = &self.state;
        let text = |key: &str| args[key].as_str().map(str::to_string);
        let need = |key: &str| text(key).ok_or(format!("`{key}` is missing"));
        match name {
            "get_snapshot" => to_json(st.snapshot(text("from"), text("to"))),
            "get_contents" => to_json::<Option<String>>(Ok(st.contents(&need("path")?, &need("side")?))),
            "get_image" => to_json::<Option<String>>(Ok(st.image(&need("path")?, &need("side")?))),
            "load_state" => Ok(st.load_state().unwrap_or(Value::Null)),
            "save_state" => to_json(st.save_state(&args["state"])),
            "list_checks" => to_json(st.list_checks()),
            "run_check" => {
                // The check outlives this request: its events go to every open page.
                let srv = Arc::clone(self);
                to_json(st.run_check(&need("name")?, move |e| srv.broadcast(e.to_string())))
            }
            "cancel_check" => to_json(st.cancel_check(&need("name")?)),
            "find_pr" => to_json(st.find_pr()),
            "publish" => {
                let req: PublishRequest = serde_json::from_value(args["req"].clone()).map_err(|e| e.to_string())?;
                to_json(st.publish(&req))
            }
            "submit_review" => {
                st.submit(args["result"].clone(), need("markdown")?);
                Ok(Value::Null)
            }
            "open_in_editor" => to_json(st.open_in_editor(&need("path")?)),
            _ => Err(format!("unknown call `{name}`")),
        }
    }

    fn broadcast(&self, line: String) {
        if let Ok(mut streams) = self.streams.lock() {
            streams.retain(|tx| tx.send(line.clone()).is_ok());
        }
    }

    /// A page's event stream: one JSON object per line (check progress), an empty line as a
    /// heartbeat. While it is open, the tab is there.
    fn events(&self, mut stream: &TcpStream) {
        let head = "HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\nCache-Control: no-store\r\n\
                    X-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n";
        if stream.write_all(head.as_bytes()).is_err() {
            return;
        }
        let (tx, rx) = mpsc::channel();
        if let Ok(mut streams) = self.streams.lock() {
            streams.push(tx);
        }
        self.pages.fetch_add(1, Ordering::SeqCst);
        self.seen_page.store(true, Ordering::SeqCst);
        loop {
            let line = match rx.recv_timeout(HEARTBEAT) {
                Ok(l) => l,
                Err(mpsc::RecvTimeoutError::Timeout) => String::new(),
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            };
            if stream.write_all(format!("{line}\n").as_bytes()).and_then(|_| stream.flush()).is_err() {
                break;
            }
        }
        if let Ok(mut t) = self.last_page.lock() {
            *t = Instant::now();
        }
        self.pages.fetch_sub(1, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_128_random_bits() {
        let (a, b) = (token(), token());
        assert_eq!(a.len(), 32);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }

    #[test]
    fn token_comparison() {
        assert!(same("abc", "abc"));
        assert!(!same("abc", "abd"));
        assert!(!same("abc", "abcd"));
        assert!(!same("", "a"));
    }
}
