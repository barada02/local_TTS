mod download;
mod engines;

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde::Serialize;
use tauri::ipc::{Channel, InvokeBody, InvokeResponseBody, Request};
use tauri::{AppHandle, Manager, State};

use download::{Download, DownloadEvent, DownloadState};
use engines::{CloneSpec, Engine, LicenseInfo, VoiceInfo};

struct AppState {
    engines: Vec<Arc<dyn Engine>>,
    /// Held while something is being generated: one run at a time, so the
    /// timings are not distorted by another run on the same CPU.
    busy: Arc<Mutex<()>>,
    /// Bumped by `engine_stop`; a run started before the bump stops early.
    epoch: Arc<AtomicU64>,
}

impl AppState {
    fn engine(&self, id: &str) -> Result<Arc<dyn Engine>, String> {
        self.engines
            .iter()
            .find(|e| e.id() == id)
            .cloned()
            .ok_or_else(|| format!("Unknown engine: {id}"))
    }
}

fn engine_root(app: &AppHandle, engine: &str) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|d| d.join("engines").join(engine))
        .map_err(|e| format!("Could not resolve the app data folder: {e}"))
}

/// Memory used by the process the model lives in, in MB: the engine's worker
/// process if it has one, otherwise this app.
fn process_mb(sidecar: Option<u32>) -> f64 {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
    let pid = match sidecar {
        Some(p) => Pid::from_u32(p),
        None => match sysinfo::get_current_pid() {
            Ok(p) => p,
            Err(_) => return 0.0,
        },
    };
    let Ok(mut sys) = System::new() else {
        return 0.0;
    };
    sys.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[pid]),
        true,
        ProcessRefreshKind::nothing().with_memory(),
    );
    sys.process(pid)
        .map(|p| p.memory() as f64 / 1_048_576.0)
        .unwrap_or(0.0)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EngineInfo {
    id: String,
    name: String,
    description: String,
    voices: Vec<VoiceInfo>,
    license: LicenseInfo,
    /// Present when the engine can clone voices.
    clone: Option<CloneSpec>,
    downloaded: bool,
    present_bytes: u64,
    total_bytes: u64,
    loaded: bool,
}

fn describe(app: &AppHandle, e: &dyn Engine) -> Result<EngineInfo, String> {
    let root = engine_root(app, e.id())?;
    let files: Vec<Download> = e.downloads(&root);
    Ok(EngineInfo {
        id: e.id().into(),
        name: e.name().into(),
        description: e.description().into(),
        voices: e.voices(&root),
        license: e.license(),
        clone: e.clone_spec(&root),
        downloaded: files.iter().all(|f| f.dest.is_file()) && !e.needs_setup(&root),
        present_bytes: download::bytes_present(&files),
        total_bytes: files.iter().map(|f| f.size).sum(),
        loaded: e.is_loaded(),
    })
}

#[tauri::command]
fn engines_list(app: AppHandle, state: State<'_, AppState>) -> Result<Vec<EngineInfo>, String> {
    state
        .engines
        .iter()
        .map(|e| describe(&app, e.as_ref()))
        .collect()
}

#[tauri::command]
async fn engine_download(
    app: AppHandle,
    state: State<'_, AppState>,
    dl: State<'_, DownloadState>,
    engine: String,
    on_event: Channel<DownloadEvent>,
) -> Result<(), String> {
    let e = state.engine(&engine)?;
    let root = engine_root(&app, &engine)?;
    let files = e.downloads(&root);
    download::run(&dl, &files, &on_event).await?;
    if e.needs_setup(&root) {
        let events = on_event.clone();
        tauri::async_runtime::spawn_blocking(move || {
            e.setup(&root, &mut |message| {
                let _ = events.send(DownloadEvent::Installing { message: message.to_string() });
            })
        })
        .await
        .map_err(|e| e.to_string())??;
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LoadInfo {
    sample_rate: u32,
    /// Time to load the model; 0 if it was already loaded.
    load_ms: f64,
    ram_mb: f64,
}

#[tauri::command]
async fn engine_load(
    app: AppHandle,
    state: State<'_, AppState>,
    engine: String,
) -> Result<LoadInfo, String> {
    let e = state.engine(&engine)?;
    let root = engine_root(&app, &engine)?;
    tauri::async_runtime::spawn_blocking(move || {
        let was_loaded = e.is_loaded();
        let t = Instant::now();
        let sample_rate = e.load(&root)?;
        let load_ms = if was_loaded {
            0.0
        } else {
            t.elapsed().as_secs_f64() * 1000.0
        };
        Ok(LoadInfo {
            sample_rate,
            load_ms,
            ram_mb: process_mb(e.sidecar_pid()),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SpeakStats {
    sample_rate: u32,
    samples: usize,
    audio_sec: f64,
    /// Time from the start of the request to the first audio chunk.
    ttfa_ms: f64,
    /// Time to generate everything.
    total_ms: f64,
    /// Generation time divided by audio length; below 1 is faster than real time.
    rtf: f64,
    ram_mb: f64,
    /// True if the run was stopped before the end.
    stopped: bool,
}

/// Generates speech. Audio is sent over `on_audio` as it is produced, as raw
/// little-endian f32 samples (mono), so playback can start right away.
#[tauri::command]
async fn engine_speak(
    app: AppHandle,
    state: State<'_, AppState>,
    engine: String,
    text: String,
    voice: String,
    on_audio: Channel<InvokeResponseBody>,
) -> Result<SpeakStats, String> {
    let e = state.engine(&engine)?;
    let root = engine_root(&app, &engine)?;
    let epoch = state.epoch.load(Ordering::SeqCst);
    let current = state.epoch.clone();
    let busy = state.busy.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let _turn = busy.lock().map_err(|_| "State is poisoned")?;
        // Switching voice can take time on some engines; keep it out of the timings.
        e.prepare_voice(&root, &voice)?;
        let started = Instant::now();
        let mut first: Option<f64> = None;
        let mut samples = 0usize;
        let mut stopped = false;

        let outcome = e.speak(&root, &text, &voice, &mut |chunk| {
            if current.load(Ordering::SeqCst) != epoch {
                stopped = true;
                return false;
            }
            if first.is_none() && !chunk.is_empty() {
                first = Some(started.elapsed().as_secs_f64() * 1000.0);
            }
            samples += chunk.len();
            let bytes: Vec<u8> = chunk.iter().flat_map(|s| s.to_le_bytes()).collect();
            on_audio.send(InvokeResponseBody::Raw(bytes)).is_ok()
        })?;

        let total_ms = started.elapsed().as_secs_f64() * 1000.0;
        let audio_sec = samples as f64 / outcome.sample_rate as f64;
        Ok(SpeakStats {
            sample_rate: outcome.sample_rate,
            samples,
            audio_sec,
            ttfa_ms: first.unwrap_or(total_ms),
            total_ms,
            rtf: if audio_sec > 0.0 {
                total_ms / 1000.0 / audio_sec
            } else {
                0.0
            },
            ram_mb: process_mb(e.sidecar_pid()),
            stopped,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Decodes %XX escapes (the frontend percent-encodes header values).
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && bytes[i + 1].is_ascii_hexdigit()
            && bytes[i + 2].is_ascii_hexdigit()
        {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn header(request: &Request<'_>, name: &str) -> Result<String, String> {
    request
        .headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(percent_decode)
        .ok_or_else(|| format!("Missing {name} header"))
}

/// Makes a new voice from a recording. The body is the audio as raw mono f32
/// samples at the rate the engine asked for; `x-engine` and `x-name` carry the
/// engine id and the voice's name (percent-encoded).
#[tauri::command]
async fn engine_create_voice(
    app: AppHandle,
    state: State<'_, AppState>,
    request: Request<'_>,
) -> Result<VoiceInfo, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected raw audio bytes".into());
    };
    let pcm: Vec<f32> = bytes
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect();
    let engine = header(&request, "x-engine")?;
    let name = header(&request, "x-name")?;
    let e = state.engine(&engine)?;
    let root = engine_root(&app, &engine)?;
    let busy = state.busy.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _turn = busy.lock().map_err(|_| "State is poisoned")?;
        e.create_voice(&root, &name, &pcm)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn engine_delete_voice(
    app: AppHandle,
    state: State<'_, AppState>,
    engine: String,
    voice: String,
) -> Result<(), String> {
    let e = state.engine(&engine)?;
    e.delete_voice(&engine_root(&app, &engine)?, &voice)
}

#[tauri::command]
fn engine_stop(state: State<'_, AppState>) {
    state.epoch.fetch_add(1, Ordering::SeqCst);
}

/// Saves a WAV file (the raw request body) into the app's outputs folder and
/// returns its path. The file name comes from the `x-name` header.
#[tauri::command]
fn save_wav(app: AppHandle, request: Request<'_>) -> Result<String, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected raw WAV bytes".into());
    };
    let name = request
        .headers()
        .get("x-name")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("speech");
    let safe: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("outputs");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{safe}.wav"));
    std::fs::write(&path, bytes).map_err(|e| format!("Could not save the file: {e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            engines: engines::registry().into_iter().map(Arc::from).collect(),
            busy: Arc::new(Mutex::new(())),
            epoch: Arc::new(AtomicU64::new(0)),
        })
        .manage(DownloadState::default())
        .invoke_handler(tauri::generate_handler![
            engines_list,
            engine_download,
            engine_load,
            engine_speak,
            engine_stop,
            engine_create_voice,
            engine_delete_voice,
            download::cancel_download,
            save_wav
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Make sure engine worker processes never outlive the app.
            if let tauri::RunEvent::Exit = event {
                for e in &app.state::<AppState>().engines {
                    e.shutdown();
                }
            }
        });
}
