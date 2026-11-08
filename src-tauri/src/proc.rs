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
    // Collect concurrently so a full pipe never blocks the child.
    let collect = |rx: mpsc::Receiver<String>| {
        std::thread::spawn(move || {
            let mut s = String::new();
            while let Ok(c) = rx.recv() {
                s.push_str(&c);
            }
            s
        })
    };
    let (oh, eh) = (collect(orx), collect(erx));
    let start = Instant::now();
    let (code, timed_out) = loop {
        if let Some(status) = child.try_wait()? {
            break (status.code(), false);
        }
        if start.elapsed() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            break (None, true);
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    Ok(Output { code, stdout: oh.join().unwrap_or_default(), stderr: eh.join().unwrap_or_default(), timed_out })
}

const FLUSH_EVERY: Duration = Duration::from_millis(100);
const MAX_BATCH: usize = 256 * 1024;

/// Streams a check's output in batches (at most every 100ms, always flushed
/// when quiet); stops on exit, timeout or cancel. Returns the exit code
/// (None when killed). The child must have been spawned with `own_group`.
pub fn stream(mut child: Child, timeout: Duration, cancel: &AtomicBool, mut on_output: impl FnMut(&str)) -> Option<i32> {
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
        if buf.len() > MAX_BATCH {
            // Keep the tail; the UI keeps only the last part anyway.
            let mut cut = buf.len() - MAX_BATCH;
            while !buf.is_char_boundary(cut) {
                cut += 1;
            }
            let tail = format!("…(output truncated)…\n{}", &buf[cut..]);
            *buf = tail;
        }
        on_output(buf);
        buf.clear();
    };
    let mut disconnected = false;
    loop {
        // Receive for at most ~50ms per iteration so exit/cancel/timeout are always checked.
        let tick = Instant::now() + Duration::from_millis(50);
        while !disconnected {
            match rx.recv_timeout(tick.saturating_duration_since(Instant::now())) {
                Ok(c) => buf.push_str(&c),
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
