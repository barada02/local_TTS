//! What an engine has on disk, and deleting it.
//!
//! An engine's files are its own folder (`engines/<id>`: model, voices, and
//! for some engines a Python environment) plus any shared folders it uses,
//! such as `engines/_onnx-env`, which Kokoro and the Kitten models share. A
//! shared folder is only counted, and deleted, when no other engine that still
//! has files uses it.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use crate::download;
use crate::engines::Engine;

/// Total size of the files under `path` (0 if it doesn't exist). Links are
/// not followed.
pub fn dir_size(path: &Path) -> u64 {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return 0;
    };
    if !meta.is_dir() {
        return meta.len();
    }
    std::fs::read_dir(path)
        .map(|entries| entries.flatten().map(|e| dir_size(&e.path())).sum())
        .unwrap_or(0)
}

/// Whether an engine has any of its model files (or a partial download).
fn has_files(e: &dyn Engine, root: &Path) -> bool {
    download::bytes_present(&e.downloads(root)) > 0
}

/// The folders that deleting `engine`'s files removes: its own folder, plus
/// each shared folder no other engine with files still needs. `root_of`
/// gives an engine's folder.
pub fn deletable_dirs(
    engines: &[Arc<dyn Engine>],
    engine: &dyn Engine,
    root_of: &dyn Fn(&str) -> Result<PathBuf, String>,
) -> Result<Vec<PathBuf>, String> {
    let root = root_of(engine.id())?;
    let mut dirs = vec![root.clone()];
    for shared in engine.shared_dirs(&root) {
        let mut needed = false;
        for other in engines.iter().filter(|o| o.id() != engine.id()) {
            let other_root = root_of(other.id())?;
            if other.shared_dirs(&other_root).contains(&shared) && has_files(other.as_ref(), &other_root) {
                needed = true;
                break;
            }
        }
        if !needed {
            dirs.push(shared);
        }
    }
    Ok(dirs)
}

/// Deletes a folder, retrying briefly: on Windows a file can stay locked for
/// a moment after the process that had it open exits.
pub fn remove_dir(dir: &Path) -> Result<(), String> {
    let mut attempt = 0;
    loop {
        match std::fs::remove_dir_all(dir) {
            Ok(()) => return Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(_) if attempt < 5 => {
                attempt += 1;
                std::thread::sleep(Duration::from_millis(200 * attempt));
            }
            Err(e) => return Err(format!("Could not delete {}: {e}", dir.display())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sizes_and_removes_a_folder() {
        let dir = std::env::temp_dir().join(format!("tts-bench-storage-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("a/b")).unwrap();
        std::fs::write(dir.join("one.bin"), [0u8; 100]).unwrap();
        std::fs::write(dir.join("a/b/two.bin"), [0u8; 23]).unwrap();
        assert_eq!(dir_size(&dir), 123);
        remove_dir(&dir).unwrap();
        assert!(!dir.exists());
        assert_eq!(dir_size(&dir), 0);
        remove_dir(&dir).unwrap(); // already gone is fine
    }
}
