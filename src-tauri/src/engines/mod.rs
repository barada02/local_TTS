//! The engine abstraction: one trait per way of running a TTS model.
//!
//! Each model family (Phonon, Kokoro, Piper, ...) implements [`Engine`]. The
//! app only talks to this trait, so adding a model means adding one file here
//! and registering it in [`registry`]. Engines that need a different runtime
//! (Python, ONNX, an external binary) can wrap it behind the same trait.

pub mod phonon;

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
}

/// What an engine produced, sample-wise.
pub struct SpeakOutcome {
    pub sample_rate: u32,
}

pub trait Engine: Send + Sync {
    fn id(&self) -> &'static str;
    fn name(&self) -> &'static str;
    fn description(&self) -> &'static str;
    /// Files to fetch (model weights, voices...) into `root`.
    fn downloads(&self, root: &Path) -> Vec<Download>;
    fn voices(&self) -> Vec<VoiceInfo>;
    /// Loads the model (once). Returns the sample rate of the audio it makes.
    fn load(&self, root: &Path) -> Result<u32, String>;
    fn is_loaded(&self) -> bool;
    /// Generates speech, handing each audio chunk (mono f32) to `emit` as soon
    /// as it is ready. Stops early when `emit` returns `false`.
    fn speak(
        &self,
        root: &Path,
        text: &str,
        voice: &str,
        emit: &mut dyn FnMut(&[f32]) -> bool,
    ) -> Result<SpeakOutcome, String>;
}

pub fn registry() -> Vec<Box<dyn Engine>> {
    vec![Box::new(phonon::Phonon::default())]
}
