# tts-bench

A desktop app (Tauri + React) for trying local text-to-speech models: listen to every voice, clone your own, and see how fast each model runs on this machine. Once a model is chosen, it can be wired into another project (for example one where an AI agent generates voice).

## Run

```
npm install
npm run tauri dev
```

Needs Node, Rust (MSVC toolchain on Windows) and WebView2. The first launch compiles the Rust side, which takes several minutes. Woof also needs Python 3.9+ or [`uv`](https://docs.astral.sh/uv/); the app creates its own environment with numpy.

## Models

| Engine | Runtime | Voices | Cloning | License |
|---|---|---|---|---|
| Phonon 31M (Gradium) | `ptts`, pure Rust, in-process | 37 English | No (see below) | Apache-2.0 (commercial OK) |
| Underdog Woof | numpy in a Python worker process | Juno, Mira | No | Underdog Non-Commercial 1.0 (credit required, no commercial use) |

Each model is one file in `src-tauri/src/engines/` that implements the `Engine` trait ([mod.rs](src-tauri/src/engines/mod.rs)). Phonon runs in the app itself; [woof.rs](src-tauri/src/engines/woof.rs) is the template for models that need another runtime: it starts a worker process ([woof_worker.py](src-tauri/data/woof_worker.py)) and streams audio back over a small binary protocol.

Switching engines in the UI keeps the earlier ones loaded, so history from different models can be compared side by side.

## What the UI shows

- **Real-time factor (RTF):** generation time ÷ audio length. Below 1 means faster than real time.
- **First audio:** time until the first sound, which matters for interactive use.
- **Generated:** total generation time and audio length.
- **RAM:** memory of the process the model runs in (the app for Phonon, the worker for Woof), plus model load time in the header.
- Test sentences (numbers, acronyms, questions, long text) so every model gets the same input.
- **Run all voices:** generates the same text with every voice shown, silently, so you can listen to them one by one from the history.
- **Save:** writes a WAV file to the app's `outputs` folder and opens it.

Model files download once, with progress, resume and SHA-256 checks, into the app data folder (`%APPDATA%\com.barada02.tts-bench\engines\`). Woof is pinned to one commit of its Hugging Face repo.

## Voice cloning

The UI and the `Engine` trait support cloning: **+ Clone a voice** appears for any engine that reports a clone spec. It records you (or takes an audio file), trims silence, converts to the model's sample rate and sends it to the engine, and the new voice appears under **My voices** with a delete option. Only clone your own voice, or one you have permission to use.

**No engine uses it yet.** Phonon 31M can't clone locally: its released weights contain no speaker encoder (no `mimi_speaker.*` tensors, checked in the safetensors header), and Gradium only offers cloning through its hosted Studio. Woof has no cloning either. An engine with cloning (for example Kyutai's Pocket TTS) would plug into this.

## Licenses

Phonon is Apache-2.0. Woof is **not for commercial use** (that includes monetized videos and anything done for a company) and requires credit ("Voice by Underdog Woof"); the app shows this before you download it. If you publish this repository, don't bundle Woof's files; they are downloaded at run time.
