//! Underdog Woof: a 40.6 MB English model with two voices (Juno, Mira) that
//! runs on plain numpy. It has no Rust runtime, so it runs in a Python worker
//! process (`data/woof_worker.py`) that the app starts on first use and talks
//! to over stdin/stdout. This is the template for any engine that needs
//! another runtime.
//!
//! Setup creates a private Python environment with numpy (using `uv` if it is
//! installed, otherwise the system Python) in the engine's folder.
//!
//! The model is under the Underdog Non-Commercial License 1.0: free for
//! personal, research and non-profit use, with credit. The app shows this
//! before the download and asks for an acknowledgement.

use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use serde::Deserialize;

use super::{Engine, LicenseInfo, SpeakOutcome, VoiceInfo};
use crate::download::Download;

const REPO: &str = "https://huggingface.co/ConwayResearch/Underdog-Woof/resolve/";
const WORKER_SCRIPT: &str = include_str!("../../data/woof_worker.py");

const READY: u8 = 0;
const PREPARED: u8 = 1;
const AUDIO: u8 = 2;
const DONE: u8 = 3;
const ERROR: u8 = 4;

#[derive(Deserialize)]
struct Manifest {
    commit: String,
    files: Vec<ManifestFile>,
}

#[derive(Deserialize)]
struct ManifestFile {
    path: String,
    size: u64,
    sha256: String,
}

struct Worker {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    voice: Option<String>,
}

#[derive(Default)]
pub struct Woof {
    worker: Mutex<Option<Worker>>,
    /// Process id of the worker, 0 when none runs.
    pid: AtomicU32,
}

fn manifest() -> Manifest {
    serde_json::from_str(include_str!("../../data/woof_files.json")).expect("data/woof_files.json is valid")
}

fn model_dir(root: &Path) -> PathBuf {
    root.join("underdog-woof")
}

fn venv_dir(root: &Path) -> PathBuf {
    root.join("venv")
}

fn python_path(root: &Path) -> PathBuf {
    if cfg!(windows) {
        venv_dir(root).join("Scripts").join("python.exe")
    } else {
        venv_dir(root).join("bin").join("python")
    }
}

fn ready_marker(root: &Path) -> PathBuf {
    venv_dir(root).join(".tts-bench-ready")
}

/// A command that doesn't flash a console window on Windows.
fn command(program: impl AsRef<std::ffi::OsStr>) -> Command {
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

fn works(program: &str, arg: &str) -> bool {
    command(program).arg(arg).output().map(|o| o.status.success()).unwrap_or(false)
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
    fn send(&mut self, msg: serde_json::Value) -> std::io::Result<()> {
        writeln!(self.stdin, "{msg}")?;
        self.stdin.flush()
    }

    /// Reads frames until one of type `until` (or ERROR) arrives.
    fn wait_for(&mut self, until: u8) -> Result<Vec<u8>, String> {
        loop {
            let (kind, payload) = read_frame(&mut self.stdout).map_err(|e| format!("The Woof process stopped: {e}"))?;
            if kind == until {
                return Ok(payload);
            }
            if kind == ERROR {
                return Err(String::from_utf8_lossy(&payload).into_owned());
            }
        }
    }
}

impl Woof {
    fn start(&self, root: &Path) -> Result<Worker, String> {
        let script = root.join("woof_worker.py");
        std::fs::write(&script, WORKER_SCRIPT).map_err(|e| format!("Could not write the worker script: {e}"))?;
        let log = std::fs::File::create(root.join("woof_worker.log")).map_err(|e| e.to_string())?;
        let mut child = command(python_path(root))
            .arg("-u")
            .arg(&script)
            .arg(model_dir(root))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::from(log))
            .spawn()
            .map_err(|e| format!("Could not start Python ({}): {e}", python_path(root).display()))?;
        let stdin = child.stdin.take().ok_or("No stdin")?;
        let stdout = BufReader::new(child.stdout.take().ok_or("No stdout")?);
        let pid = child.id();
        let mut worker = Worker { child, stdin, stdout, voice: None };
        match worker.wait_for(READY) {
            Ok(_) => {
                self.pid.store(pid, Ordering::SeqCst);
                Ok(worker)
            }
            Err(e) => {
                let _ = worker.child.kill();
                Err(format!("{e} (see woof_worker.log in the engine folder)"))
            }
        }
    }

    /// Runs `f` on the worker, starting it first if needed. If `f` fails, the
    /// worker is dropped, so the next call starts a fresh one.
    fn with_worker<T>(&self, root: &Path, f: impl FnOnce(&mut Worker) -> Result<T, String>) -> Result<T, String> {
        let mut guard = self.worker.lock().map_err(|_| "Engine state is poisoned")?;
        if guard.is_none() {
            *guard = Some(self.start(root)?);
        }
        let result = f(guard.as_mut().expect("worker was just started"));
        if result.is_err() {
            if let Some(mut w) = guard.take() {
                let _ = w.child.kill();
                let _ = w.child.wait();
            }
            self.pid.store(0, Ordering::SeqCst);
        }
        result
    }
}

impl Engine for Woof {
    fn id(&self) -> &'static str {
        "woof"
    }

    fn name(&self) -> &'static str {
        "Underdog Woof"
    }

    fn description(&self) -> &'static str {
        "Underdog · 40.6 MB · English · numpy on CPU (Python worker) · 2 voices · no cloning"
    }

    fn license(&self) -> LicenseInfo {
        LicenseInfo {
            name: "Underdog Non-Commercial License 1.0",
            url: "https://huggingface.co/ConwayResearch/Underdog-Woof/blob/main/LICENSE",
            summary: "Free for personal, research, teaching and non-profit use. Anything for a company, an ad or a monetized video needs a commercial license from Underdog. No training other speech models on it, and no cloning real people without consent.",
            commercial_ok: false,
            credit: Some("Credit required: \"Voice by Underdog Woof\" in apps that use it, and \"Underdog Woof\" or \"underdog.ai\" in the title or description of published audio."),
        }
    }

    fn downloads(&self, root: &Path) -> Vec<Download> {
        let m = manifest();
        let dir = model_dir(root);
        m.files
            .into_iter()
            .map(|f| Download {
                url: format!("{REPO}{}/{}", m.commit, f.path),
                size: f.size,
                dest: dir.join(&f.path),
                sha256: f.sha256,
            })
            .collect()
    }

    fn needs_setup(&self, root: &Path) -> bool {
        !ready_marker(root).is_file()
    }

    fn setup(&self, root: &Path, progress: &mut dyn FnMut(&str)) -> Result<(), String> {
        let venv = venv_dir(root);
        let py = python_path(root);
        let have_uv = works("uv", "--version");

        if !py.is_file() {
            progress("Creating a Python environment…");
            if have_uv {
                run(command("uv").arg("venv").arg(&venv))?;
            } else {
                let system = ["python", "python3", "py"]
                    .into_iter()
                    .find(|p| works(p, "--version"))
                    .ok_or("Python was not found. Install Python 3.9 or newer (or `uv`) and try again.")?;
                run(command(system).args(["-m", "venv"]).arg(&venv))?;
            }
        }

        progress("Installing numpy…");
        if have_uv {
            run(command("uv").args(["pip", "install", "--python"]).arg(&py).arg("numpy>=1.24"))?;
        } else {
            run(command(&py).args(["-m", "pip", "install", "numpy>=1.24"]))?;
        }
        run(command(&py).args(["-c", "import numpy"]))?;
        std::fs::write(ready_marker(root), "ok").map_err(|e| e.to_string())
    }

    fn voices(&self, _root: &Path) -> Vec<VoiceInfo> {
        let voice = |id: &str, name: &str, description: &str| VoiceInfo {
            id: id.into(),
            name: name.into(),
            locale: "en".into(),
            gender: "unknown".into(),
            age: String::new(),
            description: description.into(),
            custom: false,
        };
        vec![
            voice("juno", "Juno", "Default voice. Faster and lighter on memory."),
            voice("mira", "Mira", "Lower word error rate in Underdog's tests, but slower and heavier."),
        ]
    }

    fn load(&self, root: &Path) -> Result<u32, String> {
        self.with_worker(root, |w| {
            // Load the default voice now, so load time includes the model.
            w.send(serde_json::json!({"cmd": "prepare", "voice": "juno"})).map_err(|e| e.to_string())?;
            w.wait_for(PREPARED)?;
            w.voice = Some("juno".into());
            Ok(24_000)
        })
    }

    fn is_loaded(&self) -> bool {
        self.pid.load(Ordering::SeqCst) != 0
    }

    fn prepare_voice(&self, root: &Path, voice: &str) -> Result<(), String> {
        self.with_worker(root, |w| {
            if w.voice.as_deref() != Some(voice) {
                w.send(serde_json::json!({"cmd": "prepare", "voice": voice})).map_err(|e| e.to_string())?;
                w.wait_for(PREPARED)?;
                w.voice = Some(voice.to_string());
            }
            Ok(())
        })
    }

    fn speak(
        &self,
        root: &Path,
        text: &str,
        voice: &str,
        emit: &mut dyn FnMut(&[f32]) -> bool,
    ) -> Result<SpeakOutcome, String> {
        self.with_worker(root, |w| {
            w.send(serde_json::json!({"cmd": "speak", "text": text, "voice": voice, "seed": 0}))
                .map_err(|e| e.to_string())?;
            w.voice = Some(voice.to_string());
            let mut cancelled = false;
            loop {
                let (kind, payload) =
                    read_frame(&mut w.stdout).map_err(|e| format!("The Woof process stopped: {e}"))?;
                match kind {
                    AUDIO if !cancelled => {
                        let samples: Vec<f32> = payload
                            .chunks_exact(4)
                            .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
                            .collect();
                        if !emit(&samples) {
                            cancelled = true;
                            w.send(serde_json::json!({"cmd": "cancel"})).map_err(|e| e.to_string())?;
                        }
                    }
                    DONE => break,
                    ERROR => return Err(String::from_utf8_lossy(&payload).into_owned()),
                    _ => {} // audio after a cancel, or a frame we don't need
                }
            }
            Ok(SpeakOutcome { sample_rate: 24_000 })
        })
    }

    fn sidecar_pid(&self) -> Option<u32> {
        match self.pid.load(Ordering::SeqCst) {
            0 => None,
            pid => Some(pid),
        }
    }

    fn shutdown(&self) {
        if let Ok(mut guard) = self.worker.lock() {
            if let Some(mut w) = guard.take() {
                let _ = w.send(serde_json::json!({"cmd": "quit"}));
                let _ = w.child.kill();
                let _ = w.child.wait();
            }
        }
        self.pid.store(0, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Opt-in: needs the downloaded Woof files, Python (or uv) and network access for numpy.
    /// `TTS_WOOF_SRC=<folder with woof_int8.npz and underdog_woof/> cargo test woof -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn sets_up_loads_speaks_and_cancels() {
        let src = PathBuf::from(std::env::var("TTS_WOOF_SRC").expect("TTS_WOOF_SRC"));
        let root = std::env::temp_dir().join(format!("tts-bench-woof-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(model_dir(&root).join("underdog_woof")).unwrap();
        std::fs::copy(src.join("woof_int8.npz"), model_dir(&root).join("woof_int8.npz")).unwrap();
        for entry in std::fs::read_dir(src.join("underdog_woof")).unwrap() {
            let entry = entry.unwrap();
            if !entry.path().is_file() {
                continue; // e.g. __pycache__
            }
            std::fs::copy(entry.path(), model_dir(&root).join("underdog_woof").join(entry.file_name())).unwrap();
        }

        let engine = Woof::default();
        assert!(engine.needs_setup(&root));
        engine.setup(&root, &mut |m| eprintln!("setup: {m}")).unwrap();
        assert!(!engine.needs_setup(&root));

        let rate = engine.load(&root).unwrap();
        assert_eq!(rate, 24_000);
        assert!(engine.is_loaded());
        assert!(engine.sidecar_pid().is_some());

        let mut samples = 0usize;
        engine
            .speak(&root, "Hello there. How are you today?", "juno", &mut |c| {
                samples += c.len();
                true
            })
            .unwrap();
        assert!(samples > 24_000, "expected over a second of audio, got {samples} samples");

        // Cancel after the first chunk, then speak again on the same worker.
        let mut chunks = 0;
        engine
            .speak(&root, "One short sentence. Two short sentences. Three short sentences. Four.", "juno", &mut |_| {
                chunks += 1;
                false
            })
            .unwrap();
        assert_eq!(chunks, 1, "emit returning false must stop delivery");
        engine.prepare_voice(&root, "mira").unwrap();
        let mut n = 0usize;
        engine.speak(&root, "Hello.", "mira", &mut |c| { n += c.len(); true }).unwrap();
        assert!(n > 0);

        // An unknown voice is an error, and the next call starts a fresh worker.
        assert!(engine.speak(&root, "Hi.", "nobody", &mut |_| true).is_err());
        assert!(!engine.is_loaded());
        engine.load(&root).unwrap();

        engine.shutdown();
        assert!(!engine.is_loaded());
        let _ = std::fs::remove_dir_all(&root);
    }
}
