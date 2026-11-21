//! Phonon 31M (Apache-2.0) by Gradium, run natively with `ptts` (pure Rust).
//!
//! The model and every English voice in Gradium's catalog are downloaded once
//! (about 112 MB in total), pinned to the exact Hugging Face commits that
//! `ptts` 0.5.0 pins. The voice list in `data/phonon_voices.json` is generated
//! from the catalog's `voices.jsonl` (English only, since this is the `-en`
//! model) with each file's SHA-256 taken from the repository tree.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use ptts::checkpoint::{Checkpoint, ResolveOptions};
use ptts::preprocess::Lang;
use ptts::synth::{DeviceKind, Quant, SpeechOptions, Synth};
use serde::Deserialize;

use super::{Engine, SpeakOutcome, VoiceInfo};
use crate::download::Download;

const MODEL_URL: &str =
    "https://huggingface.co/gradium/phonon-31m-en/resolve/8c64b55ec301728e2d1695bfea87a08a267d0c2d/";
const VOICES_URL: &str =
    "https://huggingface.co/gradium/phonon-voices/resolve/da6c9ec0d47be8df5c87c730a3aa97187f3229c3/voices/";
const VOICE_SIZE: u64 = 256_136;

struct ModelFile {
    path: &'static str,
    size: u64,
    sha256: &'static str,
}

/// Full-precision weights: faster than 8-bit on CPUs without fast 8-bit
/// instructions (most laptops before ~2020).
const MODEL_FILES: &[ModelFile] = &[
    ModelFile { path: "config.json", size: 2_851, sha256: "7062ea376e6b158543c8abec8e5af67df171c49ad70eb7e2a0fb25c16f265e06" },
    ModelFile { path: "tokenizer.json", size: 277_967, sha256: "691a00068fa7b989f2f3e5ae5daa2d1a5bb319f2d5360deafcfb19a8bb6e7936" },
    ModelFile { path: "model.safetensors", size: 102_823_920, sha256: "8a04cf833cfe69b67c2ec968b2d31244655b9accc84ade9c0ebcc176f2074607" },
];

#[derive(Deserialize)]
struct CatalogVoice {
    id: String,
    name: String,
    locale: String,
    gender: String,
    age: String,
    description: String,
    sha256: String,
}

#[derive(Default)]
pub struct Phonon {
    synth: Mutex<Option<Arc<Synth>>>,
}

fn catalog() -> Vec<CatalogVoice> {
    serde_json::from_str(include_str!("../../data/phonon_voices.json"))
        .expect("data/phonon_voices.json is valid")
}

fn model_dir(root: &Path) -> PathBuf {
    root.join("phonon-31m-en")
}

fn speaker_path(root: &Path, id: &str) -> PathBuf {
    root.join("speakers").join(format!("{id}.safetensors"))
}

impl Phonon {
    fn synth(&self, root: &Path) -> Result<Arc<Synth>, String> {
        let mut guard = self.synth.lock().map_err(|_| "Engine state is poisoned")?;
        if let Some(s) = guard.as_ref() {
            return Ok(s.clone());
        }
        let s = Arc::new(load_synth(root)?);
        *guard = Some(s.clone());
        Ok(s)
    }
}

fn load_synth(root: &Path) -> Result<Synth, String> {
    let ck = Checkpoint::resolve(&model_dir(root), ResolveOptions { quant: Quant::F32, weights: None })
        .map_err(|e| format!("Could not open the model: {e}"))?;

    // One thread per physical core is a good default for a laptop CPU
    // (hyper-threads add little for this kind of matrix math).
    let threads = std::thread::available_parallelism().map(|n| (n.get() / 2).max(2)).unwrap_or(2);
    xn::set_num_threads(threads);

    let mut synth = ck
        .builder(Lang::En)
        .device(DeviceKind::Cpu)
        .build()
        .map_err(|e| format!("Could not load the model: {e}"))?;
    for v in catalog() {
        synth
            .add_voice_file(&v.id, &speaker_path(root, &v.id))
            .map_err(|e| format!("Could not load the voice {}: {e}", v.name))?;
    }
    Ok(synth)
}

impl Engine for Phonon {
    fn id(&self) -> &'static str {
        "phonon"
    }

    fn name(&self) -> &'static str {
        "Phonon 31M"
    }

    fn description(&self) -> &'static str {
        "Gradium · 31M parameters · English · Apache-2.0 · pure Rust on CPU"
    }

    fn downloads(&self, root: &Path) -> Vec<Download> {
        let dir = model_dir(root);
        let mut files: Vec<Download> = MODEL_FILES
            .iter()
            .map(|f| Download {
                url: format!("{MODEL_URL}{}", f.path),
                size: f.size,
                sha256: f.sha256.to_string(),
                dest: dir.join(f.path),
            })
            .collect();
        for v in catalog() {
            files.push(Download {
                url: format!("{VOICES_URL}{}.safetensors", v.id),
                size: VOICE_SIZE,
                dest: speaker_path(root, &v.id),
                sha256: v.sha256,
            });
        }
        files
    }

    fn voices(&self) -> Vec<VoiceInfo> {
        catalog()
            .into_iter()
            .map(|v| VoiceInfo {
                id: v.id,
                name: v.name,
                locale: v.locale,
                gender: v.gender,
                age: v.age,
                description: v.description,
            })
            .collect()
    }

    fn load(&self, root: &Path) -> Result<u32, String> {
        Ok(self.synth(root)?.sample_rate())
    }

    fn is_loaded(&self) -> bool {
        self.synth.lock().map(|g| g.is_some()).unwrap_or(false)
    }

    fn speak(
        &self,
        root: &Path,
        text: &str,
        voice: &str,
        emit: &mut dyn FnMut(&[f32]) -> bool,
    ) -> Result<SpeakOutcome, String> {
        let synth = self.synth(root)?;
        let options = SpeechOptions::default().voice(voice.to_string());
        let stream = synth.stream_with(text, &options).map_err(|e| format!("The voice failed: {e}"))?;
        for chunk in stream {
            let samples = chunk.map_err(|e| format!("The voice failed: {e}"))?;
            if !emit(&samples) {
                break; // dropping the stream stops generation
            }
        }
        Ok(SpeakOutcome { sample_rate: synth.sample_rate() })
    }
}
