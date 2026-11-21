//! Resumable, verified downloads, shared by all engines.
//!
//! Each file downloads to a `.part` file next to its final path, so an
//! interrupted download continues where it stopped. Progress is reported over
//! a Tauri channel as one total across all files. Free disk space is checked
//! first, and every file's SHA-256 is verified before it is moved into place.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use reqwest::header::RANGE;
use reqwest::StatusCode;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::ipc::Channel;
use tokio::io::AsyncWriteExt;

/// Error message returned when the user cancels a download.
pub const CANCELLED: &str = "Download cancelled";

/// Extra free space to leave on the disk beyond the files themselves.
const DISK_MARGIN: u64 = 500 * 1024 * 1024;

/// One file to fetch.
pub struct Download {
    pub url: String,
    pub size: u64,
    pub sha256: String,
    pub dest: PathBuf,
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DownloadEvent {
    Progress { downloaded: u64, total: u64 },
    Verifying,
}

/// Only one download runs at a time, and it can be cancelled.
#[derive(Default)]
pub struct DownloadState {
    active: AtomicBool,
    cancel: AtomicBool,
}

#[tauri::command]
pub fn cancel_download(state: tauri::State<'_, DownloadState>) {
    state.cancel.store(true, Ordering::SeqCst);
}

pub fn part_path(final_path: &Path) -> PathBuf {
    let mut name = final_path.file_name().unwrap_or_default().to_os_string();
    name.push(".part");
    final_path.with_file_name(name)
}

/// Bytes already on disk for these files: finished files count in full,
/// unfinished ones by their `.part` size.
pub fn bytes_present(files: &[Download]) -> u64 {
    files
        .iter()
        .map(|f| {
            if f.dest.is_file() {
                f.size
            } else {
                std::fs::metadata(part_path(&f.dest)).map(|m| m.len().min(f.size)).unwrap_or(0)
            }
        })
        .sum()
}

/// Downloads every file that isn't in place yet.
pub async fn run(
    state: &DownloadState,
    files: &[Download],
    on_event: &Channel<DownloadEvent>,
) -> Result<(), String> {
    if state.active.swap(true, Ordering::SeqCst) {
        return Err("A download is already running".into());
    }
    state.cancel.store(false, Ordering::SeqCst);
    let result = run_inner(state, files, on_event).await;
    state.active.store(false, Ordering::SeqCst);
    result
}

async fn run_inner(
    state: &DownloadState,
    files: &[Download],
    on_event: &Channel<DownloadEvent>,
) -> Result<(), String> {
    let total: u64 = files.iter().map(|f| f.size).sum();

    // Throw away partial files that are bigger than they should be.
    for f in files {
        let part = part_path(&f.dest);
        if std::fs::metadata(&part).map(|m| m.len() > f.size).unwrap_or(false) {
            let _ = tokio::fs::remove_file(&part).await;
        }
    }

    // Make sure the rest fits on the disk.
    if let Some(first) = files.first() {
        let dir = first.dest.parent().ok_or("Invalid download path")?;
        tokio::fs::create_dir_all(dir)
            .await
            .map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
        let free = fs4::available_space(dir).map_err(|e| format!("Could not check free disk space: {e}"))?;
        let needed = total - bytes_present(files);
        if needed > 0 && free < needed + DISK_MARGIN {
            return Err(format!(
                "Not enough disk space. The download needs {} free, but only {} is available.",
                gb(needed + DISK_MARGIN),
                gb(free)
            ));
        }
    }

    let client = reqwest::Client::builder()
        .user_agent("tts-bench")
        .connect_timeout(Duration::from_secs(30))
        // Fail (and let the user resume) if the connection stalls.
        .read_timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;

    // Bytes of earlier files in the list, so progress is one running total.
    let mut done_before: u64 = 0;
    for f in files {
        if !f.dest.is_file() {
            fetch_one(&client, state, f, done_before, total, on_event).await?;
        }
        done_before += f.size;
    }
    let _ = on_event.send(DownloadEvent::Progress { downloaded: total, total });
    Ok(())
}

async fn fetch_one(
    client: &reqwest::Client,
    state: &DownloadState,
    f: &Download,
    base: u64,
    total: u64,
    on_event: &Channel<DownloadEvent>,
) -> Result<(), String> {
    let dir = f.dest.parent().ok_or("Invalid download path")?;
    tokio::fs::create_dir_all(dir)
        .await
        .map_err(|e| format!("Could not create {}: {e}", dir.display()))?;

    let part = part_path(&f.dest);
    let mut have = tokio::fs::metadata(&part).await.map(|m| m.len()).unwrap_or(0);

    if have < f.size {
        let mut req = client.get(&f.url);
        if have > 0 {
            req = req.header(RANGE, format!("bytes={have}-"));
        }
        let res = req
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .map_err(|e| format!("Could not reach the download server: {e}"))?;

        // 206 = the server honoured our resume request; otherwise start over.
        let mut file = if have > 0 && res.status() == StatusCode::PARTIAL_CONTENT {
            tokio::fs::OpenOptions::new().append(true).open(&part).await
        } else {
            have = 0;
            tokio::fs::File::create(&part).await
        }
        .map_err(|e| format!("Could not write the downloaded file: {e}"))?;

        let mut downloaded = have;
        let _ = on_event.send(DownloadEvent::Progress { downloaded: base + downloaded, total });
        let mut last_emit = Instant::now();
        let mut stream = res.bytes_stream();

        while let Some(chunk) = stream.next().await {
            if state.cancel.load(Ordering::SeqCst) {
                let _ = file.flush().await;
                return Err(CANCELLED.into());
            }
            let chunk = chunk.map_err(|e| format!("The download was interrupted: {e}"))?;
            file.write_all(&chunk)
                .await
                .map_err(|e| format!("Could not write the downloaded file: {e}"))?;
            downloaded += chunk.len() as u64;

            if last_emit.elapsed() >= Duration::from_millis(200) {
                let _ = on_event.send(DownloadEvent::Progress { downloaded: base + downloaded, total });
                last_emit = Instant::now();
            }
        }
        file.flush().await.map_err(|e| e.to_string())?;
        drop(file);
        let _ = on_event.send(DownloadEvent::Progress { downloaded: base + downloaded, total });

        if downloaded != f.size {
            return Err("The download ended early. Press Retry to continue where it stopped.".into());
        }
    }

    // Verify the file before using it. Only worth showing for big files.
    if f.size > 50 * 1024 * 1024 {
        let _ = on_event.send(DownloadEvent::Verifying);
    }
    let to_hash = part.clone();
    let hash = tauri::async_runtime::spawn_blocking(move || sha256_file(&to_hash))
        .await
        .map_err(|e| e.to_string())??;
    if hash != f.sha256 {
        let _ = tokio::fs::remove_file(&part).await;
        return Err("The downloaded file was damaged. Please download it again.".into());
    }

    tokio::fs::rename(&part, &f.dest)
        .await
        .map_err(|e| format!("Could not move the downloaded file into place: {e}"))
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1024 * 1024];
    loop {
        let n = file.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

fn gb(bytes: u64) -> String {
    format!("{:.1} GB", bytes as f64 / 1_073_741_824.0)
}
