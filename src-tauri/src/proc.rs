//! Child-process helpers: timeouts without pipe deadlocks, process-group
//! termination for checks, and UTF-8 safe, rate-limited output streaming.

use std::io::{Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

pub struct Output {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
}

impl Output {
    pub fn success(&self) -> bool {
        self.code == Some(0) && !self.timed_out
    }
}

/// Puts the child in its own process group (Unix) so the whole tree can be
/// killed. Only for checks: git/gh stay in the terminal's foreground group so
/// ssh / credential prompts keep working.
pub fn own_group(cmd: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    #[cfg(not(unix))]
    let _ = cmd;
}

/// Kills every process in the process group led by `pid` (Unix).
pub fn kill_group(pid: u32) {
    #[cfg(unix)]
    unsafe {
        libc::killpg(pid as libc::pid_t, libc::SIGKILL);
    }
    #[cfg(windows)]
    let _ = Command::new("taskkill")
        .args(["/T", "/F", "/PID", &pid.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

/// Kills a process and all its descendants without relying on process groups
/// (used for git/gh, which must stay in the terminal's group for prompts).
pub fn kill_descendants(child: &mut Child) {
    #[cfg(unix)]
    {
        fn collect(pid: u32, out: &mut Vec<u32>) {
            if let Ok(o) = Command::new("pgrep").args(["-P", &pid.to_string()]).stderr(Stdio::null()).output() {
                for line in String::from_utf8_lossy(&o.stdout).lines() {
                    if let Ok(c) = line.trim().parse::<u32>() {
                        if !out.contains(&c) {
                            out.push(c);
                            collect(c, out);
                        }
                    }
                }
            }
        }
        let mut pids = vec![];
        collect(child.id(), &mut pids);
        for p in pids {
            unsafe {
                libc::kill(p as libc::pid_t, libc::SIGKILL);
            }
        }
    }
    #[cfg(windows)]
    let _ = Command::new("taskkill")
        .args(["/T", "/F", "/PID", &child.id().to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    let _ = child.kill();
    let _ = child.wait();
}

/// Reads a pipe, sending complete UTF-8 text (multi-byte characters are never split).
fn spawn_reader(mut pipe: Box<dyn Read + Send>, tx: mpsc::SyncSender<String>) {
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut carry: Vec<u8> = Vec::new();
        loop {
            match pipe.read(&mut buf) {
                Ok(0) | Err(_) => {
                    if !carry.is_empty() {
                        let _ = tx.send(String::from_utf8_lossy(&carry).into_owned());
                    }
                    break;
                }
                Ok(n) => {
                    carry.extend_from_slice(&buf[..n]);
                    let valid = match std::str::from_utf8(&carry) {
                        Ok(_) => carry.len(),
                        Err(e) if e.error_len().is_none() => e.valid_up_to(),
                        Err(_) => carry.len(),
                    };
                    if valid > 0 {
                        let s = String::from_utf8_lossy(&carry[..valid]).into_owned();
                        carry.drain(..valid);
                        if tx.send(s).is_err() {
                            break;
                        }
                    }
                }
            }
        }
    });
}

/// Runs a command to completion with a timeout, optional stdin, and both pipes
/// drained concurrently (no deadlock on large output).
pub fn run(mut cmd: Command, stdin: Option<&str>, timeout: Duration) -> std::io::Result<Output> {
    cmd.stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn()?;
    if let (Some(input), Some(mut pipe)) = (stdin.map(str::to_owned), child.stdin.take()) {
        std::thread::spawn(move || {
            let _ = pipe.write_all(input.as_bytes());
        });
    }
    let (otx, orx) = mpsc::sync_channel(64);
    let (etx, erx) = mpsc::sync_channel(64);
    if let Some(p) = child.stdout.take() {
        spawn_reader(Box::new(p), otx);
    }
    if let Some(p) = child.stderr.take() {
        spawn_reader(Box::new(p), etx);
    }
    // Collect concurrently so a full pipe never blocks the child. A grandchild
    // that keeps a pipe open (ssh, hooks) must not make us wait forever.
    let collect = |rx: mpsc::Receiver<String>| {
        let buf = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
        let (done_tx, done_rx) = mpsc::channel::<()>();
        let b = buf.clone();
        std::thread::spawn(move || {
            while let Ok(c) = rx.recv() {
                if let Ok(mut s) = b.lock() {
                    s.push_str(&c);
                }
            }
            let _ = done_tx.send(());
        });
        (buf, done_rx)
    };
    let ((obuf, odone), (ebuf, edone)) = (collect(orx), collect(erx));
    let start = Instant::now();
    let (code, timed_out) = loop {
        if let Some(status) = child.try_wait()? {
            break (status.code(), false);
        }
        if start.elapsed() > timeout {
            kill_descendants(&mut child);
            break (None, true);
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let grace = Instant::now() + Duration::from_secs(2);
    let _ = odone.recv_timeout(grace.saturating_duration_since(Instant::now()));
    let _ = edone.recv_timeout(grace.saturating_duration_since(Instant::now()));
    let take = |b: &std::sync::Arc<std::sync::Mutex<String>>| b.lock().map(|s| s.clone()).unwrap_or_default();
    Ok(Output { code, stdout: take(&obuf), stderr: take(&ebuf), timed_out })
}

const FLUSH_EVERY: Duration = Duration::from_millis(100);
const FLUSH_SIZE: usize = 64 * 1024;

fn keep_tail(buf: &mut String, max: usize) {
    if buf.len() <= max {
        return;
    }
    let mut cut = buf.len() - max;
    while !buf.is_char_boundary(cut) {
        cut += 1;
    }
    *buf = format!("…(output truncated)…\n{}", &buf[cut..]);
}

/// Streams a check's output in batches (every 100ms or 64KB, also when the
/// process is quiet); stops on exit, timeout or cancel. `tail` keeps only the
/// last bytes of each batch (UI); headless callers pass None to get everything.
/// Returns the exit code (None when killed). The child must use `own_group`.
pub fn stream(
    mut child: Child,
    timeout: Duration,
    cancel: &AtomicBool,
    tail: Option<usize>,
    mut on_output: impl FnMut(&str),
) -> Option<i32> {
    let (tx, rx) = mpsc::sync_channel::<String>(256);
    if let Some(p) = child.stdout.take() {
        spawn_reader(Box::new(p), tx.clone());
    }
    if let Some(p) = child.stderr.take() {
        spawn_reader(Box::new(p), tx.clone());
    }
    drop(tx);
    let pid = child.id();
    let start = Instant::now();
    let mut buf = String::new();
    let mut last_flush = Instant::now();
    let flush = |buf: &mut String, on_output: &mut dyn FnMut(&str)| {
        if buf.is_empty() {
            return;
        }
        if let Some(max) = tail {
            keep_tail(buf, max);
        }
        on_output(buf);
        buf.clear();
    };
    let mut disconnected = false;
    loop {
        // Receive for at most ~50ms per iteration (even under a flood) so
        // exit / cancel / timeout are always checked.
        let tick = Instant::now() + Duration::from_millis(50);
        while !disconnected && Instant::now() < tick {
            match rx.recv_timeout(tick.saturating_duration_since(Instant::now())) {
                Ok(c) => {
                    buf.push_str(&c);
                    match tail {
                        Some(max) if buf.len() > 2 * max => keep_tail(&mut buf, max),
                        None if buf.len() >= FLUSH_SIZE => {
                            flush(&mut buf, &mut on_output);
                            last_flush = Instant::now();
                        }
                        _ => {}
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => break,
                Err(mpsc::RecvTimeoutError::Disconnected) => disconnected = true,
            }
        }
        if disconnected {
            std::thread::sleep(Duration::from_millis(20));
        }
        if last_flush.elapsed() >= FLUSH_EVERY {
            flush(&mut buf, &mut on_output);
            last_flush = Instant::now();
        }
        if let Ok(Some(status)) = child.try_wait() {
            // Stop background processes the check left behind (like a CI job), then drain.
            kill_group(pid);
            let deadline = Instant::now() + Duration::from_millis(300);
            while let Ok(c) = rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                buf.push_str(&c);
            }
            flush(&mut buf, &mut on_output);
            return status.code().or(Some(1));
        }
        let stop = if cancel.load(Ordering::SeqCst) {
            Some("\nCancelled.\n".to_string())
        } else if start.elapsed() > timeout {
            Some(format!("\nTimed out after {}s.\n", timeout.as_secs()))
        } else {
            None
        };
        if let Some(msg) = stop {
            kill_group(pid);
            let _ = child.kill();
            let _ = child.wait();
            buf.push_str(&msg);
            flush(&mut buf, &mut on_output);
            return None;
        }
    }
}

/// Installs a Ctrl-C / SIGTERM / SIGHUP handler without overriding signals the
/// parent asked us to ignore (`nohup`, background jobs).
pub fn on_terminate(f: impl Fn() + Send + 'static) {
    #[cfg(unix)]
    let ignored: Vec<libc::c_int> = [libc::SIGINT, libc::SIGTERM, libc::SIGHUP]
        .into_iter()
        .filter(|&sig| unsafe {
            let mut old: libc::sigaction = std::mem::zeroed();
            libc::sigaction(sig, std::ptr::null(), &mut old) == 0 && old.sa_sigaction == libc::SIG_IGN
        })
        .collect();
    let _ = ctrlc::set_handler(f);
    #[cfg(unix)]
    for sig in ignored {
        unsafe {
            libc::signal(sig, libc::SIG_IGN);
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn timeout_with_grandchild_holding_pipes() {
        // A background grandchild keeps stdout open; the timeout must still win.
        let mut cmd = Command::new("sh");
        cmd.args(["-c", "sleep 30 & sleep 60"]);
        let start = Instant::now();
        let out = run(cmd, None, Duration::from_secs(1)).unwrap();
        assert!(out.timed_out);
        assert!(start.elapsed() < Duration::from_secs(5), "took {:?}", start.elapsed());
    }

    #[test]
    fn stream_flood_is_bounded_and_stoppable() {
        let mut cmd = Command::new("sh");
        cmd.args(["-c", "yes"]).stdout(Stdio::piped()).stderr(Stdio::piped());
        own_group(&mut cmd);
        let child = cmd.spawn().unwrap();
        let cancel = AtomicBool::new(false);
        let start = Instant::now();
        let mut max_batch = 0usize;
        let code = stream(child, Duration::from_secs(1), &cancel, Some(64 * 1024), |s| max_batch = max_batch.max(s.len()));
        assert_eq!(code, None);
        assert!(start.elapsed() < Duration::from_secs(4), "took {:?}", start.elapsed());
        assert!(max_batch <= 64 * 1024 + 64, "batch {max_batch}");
    }
}
