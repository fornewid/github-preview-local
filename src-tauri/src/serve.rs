//! The review page in a browser tab (the default; `--window` opens the native window instead). The
//! page is served on 127.0.0.1 for this run only and asks for the same things the window does (see
//! `AppState`) over HTTP. Every call must carry this run's token, which the page gets once for the
//! one-time code in the address it was opened with and sends in a header (other sites can neither
//! read it nor send such a request without the server allowing it); calls must also name this host
//! and port (no DNS rebinding) and come from this origin. The run ends when the review is
//! submitted, when the tab has been gone for a while, or on Ctrl-C.

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
/// Connections handled at once (a page needs a few); more are turned away.
const MAX_CONNECTIONS: usize = 64;
/// No page ever opened by then (no browser, an address never visited): the run ends as closed.
const NO_PAGE_AFTER: Duration = Duration::from_secs(600);
/// Time a connection has to send its request line and headers.
const HEADER_TIME: Duration = Duration::from_secs(5);

struct Server {
    state: Arc<AppState>,
    token: String,
    /// The one-time code in the address the browser is given (a command line other users of the
    /// machine may see): the page trades it for `token` once, then it is spent.
    launch: Mutex<Option<String>>,
    port: u16,
    /// Open event streams (one per page).
    streams: Mutex<Vec<mpsc::Sender<String>>>,
    pages: AtomicUsize,
    connections: AtomicUsize,
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
        launch: Mutex::new(Some(token())),
        port,
        streams: Mutex::new(vec![]),
        pages: AtomicUsize::new(0),
        connections: AtomicUsize::new(0),
        seen_page: AtomicBool::new(false),
        last_page: Mutex::new(Instant::now()),
        submitted: AtomicBool::new(false),
        interrupted: AtomicBool::new(false),
    });
    let code = srv.launch.lock().ok().and_then(|c| c.clone()).unwrap_or_default();
    let url = format!("http://127.0.0.1:{port}/?code={code}");
    eprintln!("gh-prv-local: reviewing in the browser at {url}");
    open_browser(&url, browser);
    let started = Instant::now();
    let mut reminded = false;
    {
        let srv = srv.clone();
        proc::on_terminate(move || srv.interrupted.store(true, Ordering::SeqCst));
    }
    let _ = listener.set_nonblocking(true);
    loop {
        if srv.submitted.load(Ordering::SeqCst) || srv.interrupted.load(Ordering::SeqCst) {
            break;
        }
        let seen = srv.seen_page.load(Ordering::SeqCst);
        let gone = seen
            && srv.pages.load(Ordering::SeqCst) == 0
            && srv.last_page.lock().map(|t| t.elapsed() > GONE_AFTER).unwrap_or(false);
        if gone {
            break;
        }
        if !seen && !reminded && started.elapsed() > Duration::from_secs(60) {
            reminded = true;
            eprintln!("gh-prv-local: no page has opened yet; open {url}");
        }
        if !seen && started.elapsed() > NO_PAGE_AFTER {
            eprintln!("gh-prv-local: no page opened in {} minutes; stopping", NO_PAGE_AFTER.as_secs() / 60);
            break;
        }
        match listener.accept() {
            Ok((stream, _)) => {
                if srv.connections.fetch_add(1, Ordering::SeqCst) >= MAX_CONNECTIONS {
                    srv.connections.fetch_sub(1, Ordering::SeqCst);
                    continue; // dropped
                }
                // Accepted sockets inherit the listener's non-blocking mode on macOS and BSDs.
                let _ = stream.set_nonblocking(false);
                let srv = srv.clone();
                std::thread::spawn(move || {
                    // Gives the slot back however the handler ends (a panic too).
                    struct Slot(Arc<Server>);
                    impl Drop for Slot {
                        fn drop(&mut self) {
                            self.0.connections.fetch_sub(1, Ordering::SeqCst);
                        }
                    }
                    let slot = Slot(srv);
                    Server::handle(&slot.0, stream);
                });
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

/// Opens the address in the browser (directly, so its request counts as typed: `Sec-Fetch-Site: none`).
fn open_browser(url: &str, browser: &str) {
    // `--browser=none`: only the address (open it yourself, e.g. through an SSH tunnel).
    if browser.eq_ignore_ascii_case("none") {
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
        // `start ""`: the empty title (Rust quotes an empty argument as "").
        c.args(["/C", "start", ""]);
        if !browser.is_empty() {
            c.arg(if browser == "edge" { "msedge" } else { browser });
        }
        c
    } else if browser.is_empty() {
        std::process::Command::new("xdg-open")
    } else {
        std::process::Command::new(if browser == "chrome" { "google-chrome" } else { browser })
    };
    // Not on our stdout (the review printed there is what the caller reads), and not in our process
    // group (Ctrl-C there must not close a browser that this started).
    use std::process::Stdio;
    proc::own_group(&mut cmd);
    match cmd.arg(url).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn() {
        Ok(mut child) => {
            std::thread::spawn(move || {
                if child.wait().is_ok_and(|s| !s.success()) {
                    eprintln!("gh-prv-local: could not open the browser; open the address above yourself");
                }
            });
        }
        Err(_) => eprintln!("gh-prv-local: could not open a browser; open the address above yourself"),
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

/// Reads with a deadline for all of it (not per read, which a trickle of bytes would keep alive).
struct Deadline<'a>(&'a TcpStream, Instant);
impl Read for Deadline<'_> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let left = self.1.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(std::io::ErrorKind::TimedOut.into());
        }
        self.0.set_read_timeout(Some(left))?;
        (&mut &*self.0).read(buf)
    }
}

/// The request line and headers; the body is read after the request has been let in.
fn read_request(stream: &TcpStream) -> Option<(Request, Vec<u8>)> {
    let mut r = BufReader::new(Deadline(stream, Instant::now() + HEADER_TIME).take(MAX_HEADERS));
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
    let path = target.split('?').next().unwrap_or("/").to_string();
    // Body bytes already read along with the headers.
    let buffered = r.buffer().to_vec();
    Some((Request { method, path, headers, body: vec![] }, buffered))
}

/// The body (`Content-Length` bytes), after what came with the headers.
fn read_body(stream: &TcpStream, req: &mut Request, buffered: Vec<u8>) -> Option<()> {
    let len: usize = req.header("content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
    if len > MAX_BODY {
        return None;
    }
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let mut body = buffered;
    body.truncate(len);
    if body.len() < len {
        let mut rest = vec![0; len - body.len()];
        (&*stream).read_exact(&mut rest).ok()?;
        body.extend(rest);
    }
    req.body = body;
    Some(())
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
        let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
        let Some((mut req, buffered)) = read_request(&stream) else { return };
        let here = [format!("127.0.0.1:{}", self.port), format!("localhost:{}", self.port)];
        let host_ok = req.header("host").is_some_and(|h| here.iter().any(|x| x == h));
        let origin_ok = req.header("origin").is_none_or(|o| here.iter().any(|x| o == format!("http://{x}")));
        // Calls from another site's page are refused too. The page itself holds no data (it gets it
        // through the calls), so it opens however the browser files the request from the system;
        // other pages cannot frame it (CSP frame-ancestors).
        let page = req.method == "GET" && req.path == "/";
        let site_ok = page || req.header("sec-fetch-site").is_none_or(|s| s == "same-origin" || s == "none");
        if !host_ok || !origin_ok || !site_ok {
            return respond(&stream, "403 Forbidden", "text/plain", b"forbidden", &[]);
        }
        let (method, path) = (req.method.clone(), req.path.clone());
        match (method.as_str(), path.as_str()) {
            ("GET", "/") => {
                let page = export::page_with("<script>window.__PRV_SERVER__=true;</script>");
                respond(&stream, "200 OK", "text/html; charset=utf-8", page.as_bytes(), &[("Content-Security-Policy", &csp())])
            }
            // The page's first call: the one-time code for this run's token.
            ("POST", "/api/session") => {
                let given = req.header("x-prv-code").unwrap_or_default().to_string();
                let traded = self.launch.lock().ok().and_then(|mut code| match code.as_deref() {
                    Some(c) if same(c, &given) => code.take(),
                    _ => None,
                });
                match traded {
                    Some(_) => respond(&stream, "200 OK", "application/json", json!({ "ok": self.token }).to_string().as_bytes(), &[]),
                    None => respond(
                        &stream,
                        "401 Unauthorized",
                        "application/json",
                        json!({ "error": "This review address was already opened (or is not this run's). Use the tab that is open, or run gh-prv-local again." })
                            .to_string()
                            .as_bytes(),
                        &[],
                    ),
                }
            }
            (_, path) if path.starts_with("/api/") => {
                if !req.header("x-prv-token").is_some_and(|t| same(t, &self.token)) {
                    return respond(&stream, "401 Unauthorized", "text/plain", b"no or wrong token", &[]);
                }
                if read_body(&stream, &mut req, buffered).is_none() {
                    return respond(&stream, "413 Content Too Large", "text/plain", b"too large", &[]);
                }
                match (method.as_str(), &path[5..]) {
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
            "check_runs" => to_json(Ok(st.check_runs())),
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
