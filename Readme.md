# tts-bench

A desktop app (Tauri + React) for trying local text-to-speech models: listen to every voice, and see how fast each model runs on this machine. Once a model is chosen, it can be wired into another project (for example one where an AI agent generates voice).

## Run

```
npm install
npm run tauri dev
```

Needs Node, Rust (MSVC toolchain on Windows) and WebView2. The first launch compiles the Rust side, which takes a few minutes.

## Models

| Engine | Runtime | Status |
|---|---|---|
| Phonon 31M (Gradium) | `ptts`, pure Rust, CPU | Working. 37 English voices (US, UK, characters). |

Planned: Kokoro, Piper and others. Each model is one file in `src-tauri/src/engines/` that implements the `Engine` trait ([mod.rs](src-tauri/src/engines/mod.rs)). Models that need another runtime (ONNX, Python) can wrap it behind the same trait.

## What the UI shows

- **Real-time factor (RTF):** generation time ÷ audio length. Below 1 means faster than real time.
- **First audio:** time until the first sound, which matters for interactive use.
- **Generated:** total generation time and audio length.
- **RAM:** memory of the app process (where the model lives), plus model load time in the header.
- Test sentences (numbers, acronyms, questions, long text) so every model gets the same input.
- **Run all voices:** generates the same text with every voice shown, silently, so you can listen to them one by one from the history.
- **Save:** writes a WAV file to the app's `outputs` folder and opens it.

Model files download once, with progress, resume and SHA-256 checks, into the app data folder (`%APPDATA%\com.barada02.tts-bench\engines\`).
