//! The engine abstraction: one trait per way of running a TTS model.
//!
//! Each model family (Phonon, Woof, Kokoro, Piper, ...) implements [`Engine`].
//! The app only talks to this trait, so adding a model means adding one file
//! here and registering it in [`registry`]. Engines that need a different
//! runtime (Python, ONNX, an external binary) wrap it behind the same trait:
//! Woof, Kitten and Kokoro, for example, run in a small Python process (see
//! `pyworker.rs`, `woof.rs` and `onnx.rs`).

pub mod onnx;
pub mod phonon;
pub mod pyworker;
pub mod woof;

use std::path::Path;

use serde::Serialize;

use crate::download::Download;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceInfo {
    pub id: String,
    pub name: String,
    pub locale: String,
    pub gender: String,
    pub age: String,
    pub description: String,
    /// A voice the user made (cloned), as opposed to one that ships with the model.
    pub custom: bool,
}

/// What the user needs to know before using an engine's model.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseInfo {
    pub name: &'static str,
    pub url: &'static str,
    pub summary: &'static str,
    /// False means the license forbids commercial use, so the UI asks for an acknowledgement.
    pub commercial_ok: bool,
    /// Credit the license requires when you use the audio or the model.
    pub credit: Option<&'static str>,
}

/// What a voice-cloning engine needs from a reference recording.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneSpec {
    pub sample_rate: u32,
    pub min_seconds: f32,
    pub max_seconds: f32,
}

pub struct SpeakOutcome {
    pub sample_rate: u32,
}

pub trait Engine: Send + Sync {
    fn id(&self) -> &'static str;
    fn name(&self) -> &'static str;
    fn description(&self) -> &'static str;
    fn license(&self) -> LicenseInfo;
    /// Files to fetch (model weights, voices...) into `root`.
    fn downloads(&self, root: &Path) -> Vec<Download>;
    /// Anything to install after the download (for example a Python environment).
    fn needs_setup(&self, _root: &Path) -> bool {
        false
    }
    fn setup(&self, _root: &Path, _progress: &mut dyn FnMut(&str)) -> Result<(), String> {
        Ok(())
    }
    /// Built-in voices plus any the user made.
    fn voices(&self, root: &Path) -> Vec<VoiceInfo>;
    /// Loads the model (once). Returns the sample rate of the audio it makes.
    fn load(&self, root: &Path) -> Result<u32, String>;
    fn is_loaded(&self) -> bool;
    /// Gets `voice` ready (for engines where switching voices takes time), so
    /// that cost isn't counted in the timings of the run that follows.
    fn prepare_voice(&self, _root: &Path, _voice: &str) -> Result<(), String> {
        Ok(())
    }
    /// Generates speech, handing each audio chunk (mono f32) to `emit` as soon
    /// as it is ready. Stops early when `emit` returns `false`.
    fn speak(
        &self,
        root: &Path,
        text: &str,
        voice: &str,
        emit: &mut dyn FnMut(&[f32]) -> bool,
    ) -> Result<SpeakOutcome, String>;
    /// Process id of a separate process the model runs in, if any. Its memory
    /// is what the benchmark reports for this engine.
    fn sidecar_pid(&self) -> Option<u32> {
        None
    }
    /// Stops any separate process. Called when the app exits.
    fn shutdown(&self) {}

    /// Voice cloning: what the reference recording must look like, if supported.
    fn clone_spec(&self, _root: &Path) -> Option<CloneSpec> {
        None
    }
    /// Makes a new voice from a reference recording (mono f32 at the rate in [`CloneSpec`]).
    fn create_voice(&self, _root: &Path, _name: &str, _pcm: &[f32]) -> Result<VoiceInfo, String> {
        Err("This engine can't clone voices".into())
    }
    fn delete_voice(&self, _root: &Path, _voice: &str) -> Result<(), String> {
        Err("This engine has no voices of your own".into())
    }
}

pub fn registry() -> Vec<Box<dyn Engine>> {
    vec![
        Box::new(phonon::Phonon::default()),
        Box::new(onnx::OnnxEngine::kokoro()),
        Box::new(onnx::OnnxEngine::kitten("nano")),
        Box::new(onnx::OnnxEngine::kitten("micro")),
        Box::new(onnx::OnnxEngine::kitten("mini")),
        Box::new(woof::Woof::default()),
    ]
}
