//! ONNX models in a Python worker: Kitten TTS 0.8 (nano, micro, mini) and
//! Kokoro 82M. They share one Python environment (onnxruntime, espeak,
//! phonemizer, `kokoro-onnx`, `kittenml`) and one worker script
//! (`data/onnx_worker.py`); only the model files and voices differ.
//!
//! Files are pinned (Kitten: Hugging Face commits; Kokoro: the
//! `model-files-v1.1` release of kokoro-onnx) and checked by SHA-256.
//!
//! `kittenml` is installed with `--no-deps`, as its docs recommend for the
//! 0.8 models: its default dependencies include PyTorch, which these models
//! don't use.

use std::path::{Path, PathBuf};

use serde::Deserialize;

use super::pyworker::{self, EnvSpec, Worker, WorkerSlot};
use super::{Engine, LicenseInfo, SpeakOutcome, VoiceInfo};
use crate::download::Download;

const SCRIPT: &str = include_str!("../../data/onnx_worker.py");

/// Bump when the package list changes, so existing environments reinstall.
const ENV_VERSION: &str = "1";

/// kokoro-onnx 0.6.1 needs Python < 3.14 (onnxruntime), so ask `uv` for 3.12.
fn env_spec() -> EnvSpec<'static> {
    EnvSpec {
        version: ENV_VERSION,
        uv_python: Some("3.12"),
        min: (3, 10),
        max: (3, 13),
        installs: &[
            &["numpy", "onnxruntime", "espeakng_loader", "phonemizer", "soundfile", "huggingface_hub", "kokoro-onnx==0.6.1"],
            &["--no-deps", "kittenml==0.9.8"],
        ],
        check: "import onnxruntime, phonemizer, kokoro_onnx, kittenml.kittentts_legacy.onnx_model",
    }
}

/// The environment is shared by every ONNX engine: `engines/_onnx-env`.
fn venv_dir(root: &Path) -> PathBuf {
    root.parent().unwrap_or(root).join("_onnx-env")
}

fn model_dir(root: &Path) -> PathBuf {
    root.join("model")
}

#[derive(Clone, Copy)]
enum Kind {
    /// `kitten_files.json` key: nano, micro or mini.
    Kitten(&'static str),
    Kokoro,
}

pub struct OnnxEngine {
    kind: Kind,
    slot: WorkerSlot,
}

impl OnnxEngine {
    pub fn kitten(variant: &'static str) -> Self {
        Self { kind: Kind::Kitten(variant), slot: WorkerSlot::default() }
    }

    pub fn kokoro() -> Self {
        Self { kind: Kind::Kokoro, slot: WorkerSlot::default() }
    }

    fn start(&self, root: &Path) -> Result<Worker, String> {
        let kind = match self.kind {
            Kind::Kitten(_) => "kitten",
            Kind::Kokoro => "kokoro",
        };
        Worker::spawn(
            &pyworker::venv_python(&venv_dir(root)),
            "onnx_worker.py",
            SCRIPT,
            root,
            &[kind.into(), model_dir(root).into_os_string()],
        )
    }
}

// --- Kitten -----------------------------------------------------------------

#[derive(Deserialize)]
struct KittenVariant {
    repo: String,
    commit: String,
    files: Vec<FileEntry>,
}

#[derive(Deserialize)]
struct FileEntry {
    path: String,
    size: u64,
    sha256: String,
}

fn kitten_variant(key: &str) -> KittenVariant {
    let mut all: std::collections::HashMap<String, KittenVariant> =
        serde_json::from_str(include_str!("../../data/kitten_files.json")).expect("data/kitten_files.json is valid");
    all.remove(key).expect("known Kitten variant")
}

/// The eight Kitten 0.8 voices. The id is the name the model's config maps to
/// its internal voice; gender comes from that internal name (`expr-voice-N-f/m`).
const KITTEN_VOICES: &[(&str, &str)] = &[
    ("Bella", "female"),
    ("Jasper", "male"),
    ("Luna", "female"),
    ("Bruno", "male"),
    ("Rosie", "female"),
    ("Hugo", "male"),
    ("Kiki", "female"),
    ("Leo", "male"),
];

// --- Kokoro -----------------------------------------------------------------

#[derive(Deserialize)]
struct KokoroManifest {
    base: String,
    files: std::collections::HashMap<String, KokoroFile>,
}

#[derive(Deserialize)]
struct KokoroFile {
    size: u64,
    sha256: String,
}

/// The English voices in `voices-v1.0.bin` (the file also holds other languages).
const KOKORO_VOICES: &[&str] = &[
    "af_alloy", "af_aoede", "af_bella", "af_heart", "af_jessica", "af_kore", "af_nicole", "af_nova", "af_river",
    "af_sarah", "af_sky", "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam", "am_michael", "am_onyx",
    "am_puck", "am_santa", "bf_alice", "bf_emma", "bf_isabella", "bf_lily", "bm_daniel", "bm_fable", "bm_george",
    "bm_lewis",
];

fn title(s: &str) -> String {
    let mut c = s.chars();
    c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
}

impl Engine for OnnxEngine {
    fn id(&self) -> &'static str {
        match self.kind {
            Kind::Kitten("nano") => "kitten-nano",
            Kind::Kitten("micro") => "kitten-micro",
            Kind::Kitten(_) => "kitten-mini",
            Kind::Kokoro => "kokoro",
        }
    }

    fn name(&self) -> &'static str {
        match self.kind {
            Kind::Kitten("nano") => "Kitten TTS Nano 0.8",
            Kind::Kitten("micro") => "Kitten TTS Micro 0.8",
            Kind::Kitten(_) => "Kitten TTS Mini 0.8",
            Kind::Kokoro => "Kokoro 82M",
        }
    }

    fn description(&self) -> &'static str {
        match self.kind {
            Kind::Kitten("nano") => "KittenML · 15M parameters · English · ONNX on CPU (Python worker) · 8 voices, no cloning",
            Kind::Kitten("micro") => "KittenML · 40M parameters · English · ONNX on CPU (Python worker) · 8 voices, no cloning",
            Kind::Kitten(_) => "KittenML · 80M parameters · English · ONNX on CPU (Python worker) · 8 voices, no cloning",
            Kind::Kokoro => "hexgrad · 82M parameters · English voices (US and UK) · ONNX on CPU (Python worker) · no cloning",
        }
    }

    fn license(&self) -> LicenseInfo {
        match self.kind {
            Kind::Kitten(_) => LicenseInfo {
                name: "Apache-2.0",
                url: "https://huggingface.co/KittenML/kitten-tts-nano-0.8-fp32",
                summary: "Free for commercial use. Don't impersonate people, and tell listeners when speech is synthetic.",
                commercial_ok: true,
                credit: None,
            },
            Kind::Kokoro => LicenseInfo {
                name: "Apache-2.0",
                url: "https://huggingface.co/hexgrad/Kokoro-82M",
                summary: "Model weights are Apache-2.0, free for commercial use (the kokoro-onnx runtime is MIT). Don't impersonate people, and tell listeners when speech is synthetic.",
                commercial_ok: true,
                credit: None,
            },
        }
    }

    fn downloads(&self, root: &Path) -> Vec<Download> {
        let dir = model_dir(root);
        match self.kind {
            Kind::Kitten(key) => {
                let v = kitten_variant(key);
                v.files
                    .into_iter()
                    .map(|f| Download {
                        url: format!("https://huggingface.co/{}/resolve/{}/{}", v.repo, v.commit, f.path),
                        size: f.size,
                        dest: dir.join(&f.path),
                        sha256: f.sha256,
                    })
                    .collect()
            }
            Kind::Kokoro => {
                let m: KokoroManifest = serde_json::from_str(include_str!("../../data/kokoro_files.json"))
                    .expect("data/kokoro_files.json is valid");
                // The fp32 model only: the int8 build ran about 14x slower on a CPU without fast int8 instructions.
                ["kokoro-v1.0.onnx", "voices-v1.0.bin"]
                    .into_iter()
                    .map(|name| {
                        let f = &m.files[name];
                        Download { url: format!("{}{name}", m.base), size: f.size, dest: dir.join(name), sha256: f.sha256.clone() }
                    })
                    .collect()
            }
        }
    }

    fn needs_setup(&self, root: &Path) -> bool {
        !pyworker::env_ready(&venv_dir(root), ENV_VERSION)
    }

    fn setup(&self, root: &Path, progress: &mut dyn FnMut(&str)) -> Result<(), String> {
        pyworker::setup_env(&venv_dir(root), &env_spec(), progress)
    }

    fn voices(&self, _root: &Path) -> Vec<VoiceInfo> {
        match self.kind {
            Kind::Kitten(_) => KITTEN_VOICES
                .iter()
                .map(|(name, gender)| VoiceInfo {
                    id: (*name).into(),
                    name: (*name).into(),
                    locale: "en".into(),
                    gender: (*gender).into(),
                    age: String::new(),
                    description: format!("Kitten voice ({gender})"),
                    custom: false,
                })
                .collect(),
            Kind::Kokoro => KOKORO_VOICES
                .iter()
                .map(|id| {
                    let (accent, locale) = if id.starts_with('a') { ("American", "en-us") } else { ("British", "en-gb") };
                    let gender = if id.as_bytes()[1] == b'f' { "female" } else { "male" };
                    VoiceInfo {
                        id: (*id).into(),
                        name: title(&id[3..]),
                        locale: locale.into(),
                        gender: gender.into(),
                        age: String::new(),
                        description: format!("{accent} English, {gender}"),
                        custom: false,
                    }
                })
                .collect(),
        }
    }

    fn load(&self, root: &Path) -> Result<u32, String> {
        // The worker loads the model before it reports ready.
        self.slot.with(|| self.start(root), |_| Ok(24_000))
    }

    fn is_loaded(&self) -> bool {
        self.slot.is_running()
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
                w.speak(serde_json::json!({"text": text, "voice": voice}), emit)?;
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

    fn copy_dir(from: &Path, to: &Path) {
        std::fs::create_dir_all(to).unwrap();
        for entry in std::fs::read_dir(from).unwrap() {
            let entry = entry.unwrap();
            if entry.path().is_file() {
                std::fs::copy(entry.path(), to.join(entry.file_name())).unwrap();
            }
        }
    }

    /// Opt-in: needs downloaded model files, `uv` or Python 3.10-3.13, and network access for the packages.
    /// `TTS_KITTEN_SRC=<folder with config.json, the .onnx and voices.npz>`
    /// `TTS_KOKORO_SRC=<folder with kokoro-v1.0.onnx and voices-v1.0.bin>`
    /// `cargo test onnx -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn kitten_and_kokoro_set_up_and_speak() {
        let top = std::env::temp_dir().join(format!("tts-bench-onnx-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&top);
        let kitten_root = top.join("kitten-nano");
        let kokoro_root = top.join("kokoro");
        copy_dir(Path::new(&std::env::var("TTS_KITTEN_SRC").expect("TTS_KITTEN_SRC")), &model_dir(&kitten_root));
        copy_dir(Path::new(&std::env::var("TTS_KOKORO_SRC").expect("TTS_KOKORO_SRC")), &model_dir(&kokoro_root));

        let kitten = OnnxEngine::kitten("nano");
        let kokoro = OnnxEngine::kokoro();
        assert!(kitten.needs_setup(&kitten_root));
        kitten.setup(&kitten_root, &mut |m| eprintln!("setup: {m}")).unwrap();
        // The environment is shared, so the second engine needs no setup of its own.
        assert!(!kokoro.needs_setup(&kokoro_root));

        for (engine, root, voice) in [(&kitten, &kitten_root, "Bella"), (&kokoro, &kokoro_root, "bf_emma")] {
            assert_eq!(engine.load(root).unwrap(), 24_000);
            let (mut samples, mut chunks) = (0usize, 0usize);
            engine
                .speak(root, "Hello there. How are you doing today? I hope it is going well.", voice, &mut |c| {
                    samples += c.len();
                    chunks += 1;
                    true
                })
                .unwrap();
            eprintln!("{}: {chunks} chunks, {:.1}s of audio", engine.name(), samples as f64 / 24_000.0);
            assert!(samples > 24_000);

            // Cancel after the first chunk, then speak again on the same worker.
            let mut n = 0;
            engine
                .speak(root, "One sentence here. Another sentence here. A third sentence here. And a fourth one.", voice, &mut |_| {
                    n += 1;
                    false
                })
                .unwrap();
            assert_eq!(n, 1);
            let mut after = 0usize;
            engine.speak(root, "Hi there.", voice, &mut |c| { after += c.len(); true }).unwrap();
            assert!(after > 0);

            assert!(engine.sidecar_pid().is_some());
            engine.shutdown();
            assert!(!engine.is_loaded());
        }
        let _ = std::fs::remove_dir_all(&top);
    }
}
