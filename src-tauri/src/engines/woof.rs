//! Underdog Woof: a 40.6 MB English model with two voices (Juno, Mira) that
//! runs on plain numpy. It has no Rust runtime, so it runs in a Python worker
//! process (`data/woof_worker.py`) that the app starts on first use, using the
//! shared plumbing in `pyworker.rs`.
//!
//! Setup creates a private Python environment with numpy (using `uv` if it is
//! installed, otherwise the system Python) in the engine's folder.
//!
//! The model is under the Underdog Non-Commercial License 1.0: free for
//! personal, research and non-profit use, with credit. The app shows this
//! before the download and asks for an acknowledgement.

use std::path::{Path, PathBuf};

use serde::Deserialize;

use super::pyworker::{self, EnvSpec, Worker, WorkerSlot};
use super::{Engine, LicenseInfo, SpeakOutcome, VoiceInfo};
use crate::download::Download;

const REPO: &str = "https://huggingface.co/ConwayResearch/Underdog-Woof/resolve/";
const SCRIPT: &str = include_str!("../../data/woof_worker.py");

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

#[derive(Default)]
pub struct Woof {
    slot: WorkerSlot,
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

const ENV_VERSION: &str = "1";

fn env_spec() -> EnvSpec<'static> {
    EnvSpec {
        version: ENV_VERSION,
        uv_python: None,
        min: (3, 9),
        max: (3, 99),
        installs: &[&["numpy>=1.24"]],
        check: "import numpy",
    }
}

impl Woof {
    fn start(&self, root: &Path) -> Result<Worker, String> {
        Worker::spawn(
            &pyworker::venv_python(&venv_dir(root)),
            "woof_worker.py",
            SCRIPT,
            root,
            &[model_dir(root).into_os_string()],
        )
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
        !pyworker::env_ready(&venv_dir(root), ENV_VERSION)
    }

    fn setup(&self, root: &Path, progress: &mut dyn FnMut(&str)) -> Result<(), String> {
        pyworker::setup_env(&venv_dir(root), &env_spec(), progress)
    }

    fn voices(&self, _root: &Path) -> Vec<VoiceInfo> {
        // Both are female: median pitch measured at ~197 Hz (Juno) and ~247 Hz (Mira).
        let voice = |id: &str, name: &str, description: &str| VoiceInfo {
            id: id.into(),
            name: name.into(),
            locale: "en".into(),
            gender: "female".into(),
            age: String::new(),
            description: description.into(),
            custom: false,
        };
        vec![
            voice("juno", "Juno", "Female voice (pitch ~200 Hz, measured). Default; faster and lighter on memory."),
            voice("mira", "Mira", "Female voice (pitch ~250 Hz, measured). Lower word error rate in Underdog's tests, but slower and heavier."),
        ]
    }

    fn load(&self, root: &Path) -> Result<u32, String> {
        // Load the default voice now, so load time includes the model.
        self.slot.with(
            || self.start(root),
            |w| {
                w.prepare("juno")?;
                Ok(24_000)
            },
        )
    }

    fn is_loaded(&self) -> bool {
        self.slot.is_running()
    }

    fn prepare_voice(&self, root: &Path, voice: &str) -> Result<(), String> {
        self.slot.with(|| self.start(root), |w| w.prepare(voice))
    }

    fn speak(
        &self,
        root: &Path,
        text: &str,
        voice: &str,
        emit: &mut dyn FnMut(&[f32]) -> bool,
    ) -> Result<SpeakOutcome, String> {
        self.slot.with(
            || self.start(root),
            |w| {
                // A fixed seed, so the same text gives the same audio.
                w.speak(serde_json::json!({"text": text, "voice": voice, "seed": 0}), emit)?;
                Ok(SpeakOutcome { sample_rate: 24_000 })
            },
        )
    }

    fn sidecar_pid(&self) -> Option<u32> {
        self.slot.pid()
    }

    fn shutdown(&self) {
        self.slot.shutdown();
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
