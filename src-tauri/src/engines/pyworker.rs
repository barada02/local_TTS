//! Shared plumbing for engines that run in a Python worker process.
//!
//! The worker (see `data/worker_base.py`) loads a model and then serves
//! requests over stdin/stdout. This module starts it, speaks the protocol,
//! restarts it after a failure, and creates the Python environment it needs.

use std::ffi::OsString;
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

/// The protocol module every worker script imports; written next to the scripts.
pub const WORKER_BASE: &str = include_str!("../../data/worker_base.py");

const READY: u8 = 0;
const PREPARED: u8 = 1;
const AUDIO: u8 = 2;
const DONE: u8 = 3;
const ERROR: u8 = 4;

/// A command that doesn't flash a console window on Windows.
pub fn command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

/// Runs a command to completion; on failure, the error carries the end of its output.
fn run(cmd: &mut Command) -> Result<(), String> {
    let out = cmd.output().map_err(|e| format!("Could not run {:?}: {e}", cmd.get_program()))?;
    if out.status.success() {
        return Ok(());
    }
    let text = String::from_utf8_lossy(&out.stderr);
    let tail: Vec<&str> = text.lines().rev().take(6).collect();
    let tail: Vec<&str> = tail.into_iter().rev().collect();
    Err(format!("{:?} failed: {}", cmd.get_program(), tail.join(" | ")))
}

fn works(program: &str, args: &[&str]) -> bool {
    command(program).args(args).output().map(|o| o.status.success()).unwrap_or(false)
}

// ---------------------------------------------------------------------------
// Python environment
// ---------------------------------------------------------------------------

pub fn venv_python(venv: &Path) -> PathBuf {
    if cfg!(windows) {
        venv.join("Scripts").join("python.exe")
    } else {
        venv.join("bin").join("python")
    }
}

fn marker(venv: &Path) -> PathBuf {
    venv.join(".tts-bench-ready")
}

pub fn env_ready(venv: &Path, version: &str) -> bool {
    std::fs::read_to_string(marker(venv)).map(|s| s.trim() == version).unwrap_or(false)
}

/// What a worker's environment needs.
pub struct EnvSpec<'a> {
    /// Changing this reinstalls (it is stored in the environment's marker file).
    pub version: &'a str,
    /// Python to ask `uv` for (for example "3.12"); `None` uses its default.
    pub uv_python: Option<&'a str>,
    /// Acceptable Python versions when `uv` isn't installed and the system Python is used.
    pub min: (u32, u32),
    pub max: (u32, u32),
    /// `pip install` argument lists, run in order.
    pub installs: &'a [&'a [&'a str]],
    /// Python code that must run without error afterwards.
    pub check: &'a str,
}

/// A system Python within the version range: a command and its leading arguments.
fn find_system_python(min: (u32, u32), max: (u32, u32)) -> Option<(String, Vec<String>)> {
    let mut candidates: Vec<(String, Vec<String>)> = Vec::new();
    for minor in (min.1..=max.1.min(14)).rev() {
        candidates.push(("py".into(), vec![format!("-{}.{minor}", min.0)]));
        candidates.push((format!("python{}.{minor}", min.0), vec![]));
    }
    candidates.push(("python".into(), vec![]));
    candidates.push(("python3".into(), vec![]));
    for (program, args) in candidates {
        let out = command(&program)
            .args(&args)
            .args(["-c", "import sys; print('%d.%d' % sys.version_info[:2])"])
            .output();
        let Ok(out) = out else { continue };
        if !out.status.success() {
            continue;
        }
        let text = String::from_utf8_lossy(&out.stdout);
        let mut parts = text.trim().split('.');
        let (Some(a), Some(b)) = (parts.next(), parts.next()) else { continue };
        if let (Ok(a), Ok(b)) = (a.parse::<u32>(), b.parse::<u32>()) {
            if (a, b) >= min && (a, b) <= max {
                return Some((program, args));
            }
        }
    }
    None
}

/// Creates the environment (if needed) and installs its packages.
pub fn setup_env(venv: &Path, spec: &EnvSpec, progress: &mut dyn FnMut(&str)) -> Result<(), String> {
    let py = venv_python(venv);
    let have_uv = works("uv", &["--version"]);

    if !py.is_file() {
        progress("Creating a Python environment…");
        if have_uv {
            let mut cmd = command("uv");
            cmd.arg("venv");
            if let Some(v) = spec.uv_python {
                cmd.args(["--python", v]);
            }
            run(cmd.arg(venv))?;
        } else {
            let (program, args) = find_system_python(spec.min, spec.max).ok_or_else(|| {
                format!(
                    "No suitable Python found. Install `uv` (https://docs.astral.sh/uv/), or Python {}.{}–{}.{}.",
                    spec.min.0, spec.min.1, spec.max.0, spec.max.1
                )
            })?;
            run(command(program).args(args).args(["-m", "venv"]).arg(venv))?;
        }
    }

    for (i, install) in spec.installs.iter().enumerate() {
        progress(&format!("Installing packages ({}/{})…", i + 1, spec.installs.len()));
        if have_uv {
            run(command("uv").args(["pip", "install", "--python"]).arg(&py).args(*install))?;
        } else {
            run(command(&py).args(["-m", "pip", "install"]).args(*install))?;
        }
    }
    run(command(&py).args(["-c", spec.check]))?;
    std::fs::write(marker(venv), spec.version).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// The worker process
// ---------------------------------------------------------------------------

pub struct Worker {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    pid: u32,
    /// The voice last loaded in the worker, if the engine tracks it.
    pub voice: Option<String>,
}

fn read_frame(r: &mut impl Read) -> std::io::Result<(u8, Vec<u8>)> {
    let mut head = [0u8; 5];
    r.read_exact(&mut head)?;
    let len = u32::from_le_bytes([head[1], head[2], head[3], head[4]]) as usize;
    let mut payload = vec![0u8; len];
    r.read_exact(&mut payload)?;
    Ok((head[0], payload))
}

impl Worker {
    /// Starts `python script args…` and waits until the model is loaded.
    /// `base` is the folder the scripts are written to; its stderr goes to `log`.
    pub fn spawn(
        python: &Path,
        script_name: &str,
        script: &str,
        folder: &Path,
        args: &[OsString],
    ) -> Result<Worker, String> {
        std::fs::create_dir_all(folder).map_err(|e| e.to_string())?;
        std::fs::write(folder.join("worker_base.py"), WORKER_BASE).map_err(|e| e.to_string())?;
        let script_path = folder.join(script_name);
        std::fs::write(&script_path, script).map_err(|e| format!("Could not write the worker script: {e}"))?;
        let log = std::fs::File::create(folder.join("worker.log")).map_err(|e| e.to_string())?;

        let mut child = command(python)
            .arg("-u")
            .arg(&script_path)
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::from(log))
            .spawn()
            .map_err(|e| format!("Could not start Python ({}): {e}", python.display()))?;
        let stdin = child.stdin.take().ok_or("No stdin")?;
        let stdout = BufReader::new(child.stdout.take().ok_or("No stdout")?);
        let pid = child.id();
        let mut worker = Worker { child, stdin, stdout, pid, voice: None };
        match worker.wait_for(READY) {
            Ok(_) => Ok(worker),
            Err(e) => {
                worker.kill();
                Err(format!("{e} (see worker.log in {})", folder.display()))
            }
        }
    }

    pub fn send(&mut self, msg: serde_json::Value) -> Result<(), String> {
        writeln!(self.stdin, "{msg}").map_err(|e| e.to_string())?;
        self.stdin.flush().map_err(|e| e.to_string())
    }

    /// Reads frames until one of type `until` (or ERROR) arrives.
    fn wait_for(&mut self, until: u8) -> Result<Vec<u8>, String> {
        loop {
            let (kind, payload) =
                read_frame(&mut self.stdout).map_err(|e| format!("The worker process stopped: {e}"))?;
            if kind == until {
                return Ok(payload);
            }
            if kind == ERROR {
                return Err(String::from_utf8_lossy(&payload).into_owned());
            }
        }
    }

    /// Loads a voice (skipped if it is already the current one).
    pub fn prepare(&mut self, voice: &str) -> Result<(), String> {
        if self.voice.as_deref() != Some(voice) {
            self.send(serde_json::json!({"cmd": "prepare", "voice": voice}))?;
            self.wait_for(PREPARED)?;
            self.voice = Some(voice.to_string());
        }
        Ok(())
    }

    /// Sends a speak request (`msg` gets `cmd` added) and passes each audio
    /// chunk to `emit`. When `emit` returns false the worker is told to
    /// cancel, and the rest of its output is discarded.
    pub fn speak(
        &mut self,
        mut msg: serde_json::Value,
        emit: &mut dyn FnMut(&[f32]) -> bool,
    ) -> Result<(), String> {
        msg["cmd"] = "speak".into();
        if let Some(v) = msg["voice"].as_str() {
            self.voice = Some(v.to_string());
        }
        self.send(msg)?;
        let mut cancelled = false;
        loop {
            let (kind, payload) =
                read_frame(&mut self.stdout).map_err(|e| format!("The worker process stopped: {e}"))?;
            match kind {
                AUDIO if !cancelled => {
                    let samples: Vec<f32> = payload
                        .chunks_exact(4)
                        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
                        .collect();
                    if !emit(&samples) {
                        cancelled = true;
                        self.send(serde_json::json!({"cmd": "cancel"}))?;
                    }
                }
                DONE => return Ok(()),
                ERROR => return Err(String::from_utf8_lossy(&payload).into_owned()),
                _ => {} // audio after a cancel, or a frame we don't need
            }
        }
    }

    fn kill(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Holds an engine's worker: started on first use, dropped after a failure so
/// the next call starts a fresh one.
#[derive(Default)]
pub struct WorkerSlot {
    worker: Mutex<Option<Worker>>,
    /// Process id of the worker, 0 when none runs.
    pid: AtomicU32,
}

impl WorkerSlot {
    pub fn is_running(&self) -> bool {
        self.pid.load(Ordering::SeqCst) != 0
    }

    pub fn pid(&self) -> Option<u32> {
        match self.pid.load(Ordering::SeqCst) {
            0 => None,
            pid => Some(pid),
        }
    }

    /// Runs `f` on the worker, starting it with `start` first if needed.
    pub fn with<T>(
        &self,
        start: impl FnOnce() -> Result<Worker, String>,
        f: impl FnOnce(&mut Worker) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut guard = self.worker.lock().map_err(|_| "Engine state is poisoned")?;
        if guard.is_none() {
            let worker = start()?;
            self.pid.store(worker.pid, Ordering::SeqCst);
            *guard = Some(worker);
        }
        let result = f(guard.as_mut().expect("worker was just started"));
        if result.is_err() {
            if let Some(mut w) = guard.take() {
                w.kill();
            }
            self.pid.store(0, Ordering::SeqCst);
        }
        result
    }

    pub fn shutdown(&self) {
        if let Ok(mut guard) = self.worker.lock() {
            if let Some(mut w) = guard.take() {
                let _ = w.send(serde_json::json!({"cmd": "quit"}));
                w.kill();
            }
        }
        self.pid.store(0, Ordering::SeqCst);
    }
}
