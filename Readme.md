# tts-bench

A desktop app (Tauri + React) for trying local text-to-speech models: listen to every voice, clone your own, and see how fast each model runs on this machine. Once a model is chosen, it can be wired into another project (for example one where an AI agent generates voice).

## Run

```
npm install
npm run tauri dev
```

Needs Node, Rust (MSVC toolchain on Windows) and WebView2. The first launch compiles the Rust side, which takes several minutes. The Python-based engines need [`uv`](https://docs.astral.sh/uv/) (recommended) or a suitable Python; the app creates its own environments and installs the packages.

## Build the app

```
npm install
npm run tauri build
```

This makes a release build (several minutes the first time). The results are in `src-tauri/target/release/`:

| File | What it is |
|---|---|
| `tts-bench.exe` | The app itself; runs without installing |
| `bundle/nsis/tts-bench_<version>_x64-setup.exe` | Installer (installs to `C:\Program Files\tts-bench\`) |
| `bundle/msi/tts-bench_<version>_x64_en-US.msi` | The same as an MSI |

None of these contain the models; they are downloaded by the app (see below). `src-tauri/target/`, `node_modules/` and `dist/` are build output and not in git, so a fresh clone plus the commands above rebuilds everything.

## Where the app keeps its files

Everything the app downloads or writes is in `%APPDATA%\com.barada02.tts-bench\` (for example `C:\Users\<you>\AppData\Roaming\com.barada02.tts-bench\`). The dev build, the release exe and the installed app all share this folder.

| Folder | Contents |
|---|---|
| `engines\<engine>\` | One per engine: model files, voices, logs, and for Woof its Python environment |
| `engines\_onnx-env\` | The Python environment Kokoro and the Kitten models share |
| `outputs\` | WAV files saved from the Studio |

Saved voices (stars) and license acknowledgements are kept in the app's WebView storage, in `%LOCALAPPDATA%\com.barada02.tts-bench\`.

**Freeing disk space.** The Studio shows how much space the selected model takes, with a **Delete model files** button. It unloads the model and deletes its folder, including any voices cloned with it. For Kokoro and the Kitten models, the shared `_onnx-env` is deleted along with the last one of them that has files. A deleted model can be downloaded again at any time. You can also delete the folders above by hand while the app is closed.

**Uninstalling.** Uninstalling keeps these folders unless you tick **Delete the application data** in the uninstaller of the setup `.exe` version. The MSI version always keeps them. To remove everything by hand, delete `%APPDATA%\com.barada02.tts-bench\` (models, outputs) and `%LOCALAPPDATA%\com.barada02.tts-bench\` (saved voices, settings).

## Models

| Engine | Runtime | Voices | Cloning | License |
|---|---|---|---|---|
| Phonon 31M (Gradium) | `ptts`, pure Rust, in-process | 37 English | No (see below) | Apache-2.0 (commercial OK) |
| Kokoro 82M | ONNX in a Python worker | 28 English (US and UK) | No | Apache-2.0 (commercial OK) |
| Kitten TTS Nano / Micro / Mini 0.8 | ONNX in a Python worker | 8 (4 female, 4 male) | No | Apache-2.0 (commercial OK) |
| Underdog Woof | numpy in a Python worker | Juno, Mira (both female) | No | Underdog Non-Commercial 1.0 (credit required, no commercial use) |

Each model is one file in `src-tauri/src/engines/` that implements the `Engine` trait ([mod.rs](src-tauri/src/engines/mod.rs)). Phonon runs in the app itself. The others run in a Python worker process that the app starts on first use; [pyworker.rs](src-tauri/src/engines/pyworker.rs) holds the shared plumbing (environment setup, a small binary protocol over stdin/stdout, cancel, restart after a crash), [woof.rs](src-tauri/src/engines/woof.rs) and [onnx.rs](src-tauri/src/engines/onnx.rs) are the engines, and [data/](src-tauri/data/) has the worker scripts. Kokoro and the Kitten models share one Python environment (Python 3.12 via `uv`, because `kokoro-onnx` needs Python below 3.14).

Notes from trying them on an i5-8265U laptop (4 cores, no GPU):
- Kokoro's int8 build ran about 14x slower than its fp32 build here (this CPU lacks fast int8 instructions), so only fp32 is offered.
- Kitten's models are about 3x faster than real time (Nano); Kokoro fp32 is about 1.5x faster than real time; Woof's speed varies a lot with the text.

Switching engines in the UI keeps the earlier ones loaded, so history from different models can be compared side by side.

## The three tabs

- **Studio:** pick a model, type or choose a test sentence, pick a voice and speak. The last run shows real-time factor (generation time ÷ audio length; below 1 is faster than real time), time to first audio, total time and the memory of the process the model runs in. **Run all voices** makes the same text with every voice shown, silently, to listen to from the history. **Save** writes a WAV file to the app's `outputs` folder.
- **Saved voices:** star any voice (the star on a voice card or in the history) to keep it here, across all models. Each saved voice can be previewed with the current text, opened in the Studio, or removed. Saved voices are kept between sessions.
- **Compare:** speaks one text with every saved voice you tick, one at a time, then charts real-time factor (with a marker at real time), time to first audio, generation time and memory, plus a results table and "fastest / quickest to start / lightest" cards. Options: runs per voice (averaged) and an unseen warm-up run per model, since the first run is often slower. It loads each model it needs.

Switching tabs keeps results and filters. Model files download once, with progress, resume and SHA-256 checks, into the app data folder (`%APPDATA%\com.barada02.tts-bench\engines\`). Woof is pinned to one commit of its Hugging Face repo.

The logo is `app-icon.svg`; regenerate every icon from it with `npx tauri icon app-icon.svg` (then delete the `android` and `ios` folders it creates in `src-tauri/icons`).

## Voice cloning

The UI and the `Engine` trait support cloning: **+ Clone a voice** appears for any engine that reports a clone spec. It records you (or takes an audio file), trims silence, converts to the model's sample rate and sends it to the engine, and the new voice appears under **My voices** with a delete option. Only clone your own voice, or one you have permission to use.

**No engine uses it yet.** Phonon 31M can't clone locally: its released weights contain no speaker encoder (no `mimi_speaker.*` tensors, checked in the safetensors header), and Gradium only offers cloning through its hosted Studio. None of the other engines clone either. An engine with cloning (for example Kyutai's Pocket TTS) would plug into this.

## Licenses

Phonon is Apache-2.0. Woof is **not for commercial use** (that includes monetized videos and anything done for a company) and requires credit ("Voice by Underdog Woof"); the app shows this before you download it. If you publish this repository, don't bundle Woof's files; they are downloaded at run time.
