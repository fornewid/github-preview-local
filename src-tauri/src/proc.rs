//! Child-process helpers: timeouts without pipe deadlocks, whole process-tree
//! termination, and UTF-8 safe streaming.

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

/// Puts the child in its own process group (Unix) so the whole tree can be killed.
pub fn own_group(cmd: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    #[cfg(not(unix))]
    let _ = cmd;
}

/// Kills every process left in the child's process group (Unix).
pub fn kill_group(pid: u32) {
    #[cfg(unix)]
    let _ = Command::new("kill")
        .args(["-KILL", &format!("-{pid}")])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    #[cfg(not(unix))]
    let _ = pid;
}

/// Kills the child and everything it started.
pub fn kill_tree(child: &mut Child) {
    let pid = child.id().to_string();
    #[cfg(unix)]
    let _ = Command::new("kill")
        .args(["-KILL", &format!("-{pid}")])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    #[cfg(windows)]
    let _ = Command::new("taskkill")
        .args(["/T", "/F", "/PID", &pid])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    let _ = child.kill();
    let _ = child.wait();
}

/// Reads a pipe, sending complete UTF-8 text (multi-byte characters are never split).
pub fn spawn_reader(mut pipe: Box<dyn Read + Send>, tx: mpsc::Sender<String>) {
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
/// drained concurrently.
pub fn run(mut cmd: Command, stdin: Option<&str>, timeout: Duration) -> std::io::Result<Output> {
    cmd.stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    own_group(&mut cmd);
    let mut child = cmd.spawn()?;
    if let (Some(input), Some(mut pipe)) = (stdin.map(str::to_owned), child.stdin.take()) {
        std::thread::spawn(move || {
            let _ = pipe.write_all(input.as_bytes());
        });
    }
    let (otx, orx) = mpsc::channel();
    let (etx, erx) = mpsc::channel();
    if let Some(p) = child.stdout.take() {
        spawn_reader(Box::new(p), otx);
    }
    if let Some(p) = child.stderr.take() {
        spawn_reader(Box::new(p), etx);
    }
    let start = Instant::now();
    let (code, timed_out) = loop {
        if let Some(status) = child.try_wait()? {
            break (status.code(), false);
        }
        if start.elapsed() > timeout {
            kill_tree(&mut child);
            break (None, true);
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let collect = |rx: mpsc::Receiver<String>| {
        let mut s = String::new();
        let deadline = Instant::now() + Duration::from_secs(2);
        while let Ok(chunk) = rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            s.push_str(&chunk);
        }
        s
    };
    Ok(Output { code, stdout: collect(orx), stderr: collect(erx), timed_out })
}

/// Streams a long-running command's output; stops on exit, timeout or cancel.
/// Returns the exit code (None when killed).
pub fn stream(
    mut child: Child,
    timeout: Duration,
    cancel: &AtomicBool,
    mut on_chunk: impl FnMut(&str),
) -> Option<i32> {
    let (tx, rx) = mpsc::channel::<String>();
    if let Some(p) = child.stdout.take() {
        spawn_reader(Box::new(p), tx.clone());
    }
    if let Some(p) = child.stderr.take() {
        spawn_reader(Box::new(p), tx.clone());
    }
    drop(tx);
    let start = Instant::now();
    let drain = |rx: &mpsc::Receiver<String>, on_chunk: &mut dyn FnMut(&str), grace: Duration| {
        let deadline = Instant::now() + grace;
        while let Ok(c) = rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            on_chunk(&c);
        }
    };
    loop {
        match rx.recv_timeout(Duration::from_millis(50)) {
            Ok(c) => {
                on_chunk(&c);
                while let Ok(c) = rx.try_recv() {
                    on_chunk(&c);
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => std::thread::sleep(Duration::from_millis(50)),
        }
        if let Ok(Some(status)) = child.try_wait() {
            drain(&rx, &mut on_chunk, Duration::from_millis(500));
            // Background processes left behind by the check are stopped, like a CI job.
            kill_group(child.id());
            return status.code().or(Some(1));
        }
        if cancel.load(Ordering::SeqCst) {
            kill_tree(&mut child);
            drain(&rx, &mut on_chunk, Duration::from_millis(200));
            on_chunk("\nCancelled.\n");
            return None;
        }
        if start.elapsed() > timeout {
            kill_tree(&mut child);
            drain(&rx, &mut on_chunk, Duration::from_millis(200));
            on_chunk(&format!("\nTimed out after {}s.\n", timeout.as_secs()));
            return None;
        }
    }
}
