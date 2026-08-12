use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
use transcribe_cpp::{Backend, CancelToken, Model, ModelOptions, Session, SessionOptions};

use crate::protocol::{emit, Event};

const MODEL_FILENAME: &str = "nemotron-3.5-asr-streaming-0.6b-Q5_K_M.gguf";
const MODEL_LOCK_FILENAME: &str = "nemotron-3.5-asr-streaming-0.6b-Q5_K_M.gguf.lock";
const MODEL_PART_FILENAME: &str = "nemotron-3.5-asr-streaming-0.6b-Q5_K_M.gguf.part";
#[cfg(test)]
const MODEL_REVISION: &str = "6d44e540bc31b0de1dbe174a3cea87f53a7f22fb";
const MODEL_URL: &str = "https://huggingface.co/handy-computer/nemotron-3.5-asr-streaming-0.6b-gguf/resolve/6d44e540bc31b0de1dbe174a3cea87f53a7f22fb/nemotron-3.5-asr-streaming-0.6b-Q5_K_M.gguf";
const MODEL_BYTES: u64 = 559_647_200;
const MODEL_SHA256: &str = "86429e8c4f7fdcf9b3312269ad1ca6669478ba7805331c4aea7a2e33e9910d65";

pub struct Engine {
    pub session: Session,
    pub cancel: CancelToken,
}

impl Engine {
    pub fn load(request_id: u64) -> Result<Self, String> {
        emit(&Event::Preparing {
            request_id,
            progress: None,
        });
        let model_path = ensure_model(request_id)?;
        let backend = if cfg!(target_os = "macos")
            && std::env::var("GSV_TRANSCRIBE_ACCELERATION").as_deref() == Ok("1")
        {
            Backend::Metal
        } else {
            Backend::Cpu
        };
        let model = Model::load_with(
            &model_path,
            &ModelOptions {
                backend,
                gpu_device: 0,
            },
        )
        .map_err(|error| format!("voice input could not load: {error}"))?;
        if !model.capabilities().supports_streaming {
            return Err("voice input model does not support streaming".to_string());
        }
        let available = std::thread::available_parallelism()
            .map(usize::from)
            .unwrap_or(2);
        let n_threads = available.saturating_div(2).clamp(1, 4) as i32;
        let mut session = model
            .session_with(&SessionOptions {
                n_threads,
                ..SessionOptions::default()
            })
            .map_err(|error| format!("voice input could not start: {error}"))?;
        let cancel = CancelToken::new();
        session.set_cancel_token(&cancel);
        Ok(Self { session, cancel })
    }
}

fn ensure_model(request_id: u64) -> Result<PathBuf, String> {
    if let Some(custom) = std::env::var_os("GSV_TRANSCRIBE_MODEL") {
        let path = PathBuf::from(custom);
        return path
            .is_file()
            .then_some(path)
            .ok_or_else(|| "configured voice input model does not exist".to_string());
    }

    let directory = model_cache_directory()?;
    fs::create_dir_all(&directory)
        .map_err(|error| format!("voice input cache could not be created: {error}"))?;
    let lock = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(directory.join(MODEL_LOCK_FILENAME))
        .map_err(|error| format!("voice input preparation lock could not be opened: {error}"))?;
    lock.lock()
        .map_err(|error| format!("voice input preparation lock could not be acquired: {error}"))?;
    cleanup_legacy_downloads(&directory)?;

    let path = directory.join(MODEL_FILENAME);
    let marker = directory.join(format!("{MODEL_FILENAME}.sha256"));
    if model_is_verified(&path, &marker)? {
        return Ok(path);
    }

    remove_if_present(&path, "cached voice input model")?;
    remove_if_present(&marker, "voice input verification marker")?;
    let temporary = TemporaryModel::new(directory.join(MODEL_PART_FILENAME))?;
    download_model(request_id, temporary.path())?;
    verify_hash(temporary.path())?;
    fs::rename(temporary.path(), &path)
        .map_err(|error| format!("voice input model could not be installed: {error}"))?;
    fs::write(&marker, format!("{MODEL_SHA256}\n"))
        .map_err(|error| format!("voice input verification could not be saved: {error}"))?;
    Ok(path)
}

fn model_cache_directory() -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    if let Some(directory) = std::env::var_os("LOCALAPPDATA") {
        return Ok(PathBuf::from(directory).join("GSV").join("models"));
    }
    #[cfg(target_os = "macos")]
    if let Some(home) = std::env::var_os("HOME") {
        return Ok(PathBuf::from(home)
            .join("Library")
            .join("Caches")
            .join("GSV")
            .join("models"));
    }
    if let Some(directory) = std::env::var_os("XDG_CACHE_HOME") {
        return Ok(PathBuf::from(directory).join("gsv").join("models"));
    }
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .map(|home| home.join(".cache").join("gsv").join("models"))
        .ok_or_else(|| "voice input cache directory is unavailable".to_string())
}

fn model_is_verified(path: &Path, marker: &Path) -> Result<bool, String> {
    if fs::metadata(path).map(|metadata| metadata.len()).ok() != Some(MODEL_BYTES) {
        return Ok(false);
    }
    if fs::read_to_string(marker)
        .ok()
        .is_some_and(|value| value.trim() == MODEL_SHA256)
    {
        return Ok(true);
    }
    if !hash_matches(path)? {
        return Ok(false);
    }
    fs::write(marker, format!("{MODEL_SHA256}\n"))
        .map_err(|error| format!("voice input verification could not be saved: {error}"))?;
    Ok(true)
}

fn download_model(request_id: u64, destination: &Path) -> Result<(), String> {
    let response = ureq::get(MODEL_URL)
        .call()
        .map_err(|error| format!("voice input could not be prepared: {error}"))?;
    let mut reader = response.into_reader();
    let mut output = File::create(destination)
        .map_err(|error| format!("voice input download could not start: {error}"))?;
    let mut buffer = vec![0_u8; 1024 * 1024];
    let mut received = 0_u64;
    let mut last_percent = 0_u64;
    loop {
        let count = reader
            .read(&mut buffer)
            .map_err(|error| format!("voice input download failed: {error}"))?;
        if count == 0 {
            break;
        }
        output
            .write_all(&buffer[..count])
            .map_err(|error| format!("voice input download could not be saved: {error}"))?;
        received = received.saturating_add(count as u64);
        if received > MODEL_BYTES {
            return Err("voice input download exceeded its expected size".to_string());
        }
        let percent = received.saturating_mul(100) / MODEL_BYTES;
        if percent >= last_percent.saturating_add(2) {
            last_percent = percent;
            emit(&Event::Preparing {
                request_id,
                progress: Some((percent as f32 / 100.0).clamp(0.0, 1.0)),
            });
        }
    }
    output
        .sync_all()
        .map_err(|error| format!("voice input download could not be completed: {error}"))?;
    if received != MODEL_BYTES {
        return Err(format!(
            "voice input download was incomplete ({received} of {MODEL_BYTES} bytes)"
        ));
    }
    Ok(())
}

fn verify_hash(path: &Path) -> Result<(), String> {
    if !hash_matches(path)? {
        return Err("voice input model failed integrity verification".to_string());
    }
    Ok(())
}

fn hash_matches(path: &Path) -> Result<bool, String> {
    let mut file = File::open(path)
        .map_err(|error| format!("voice input model could not be verified: {error}"))?;
    let mut digest = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|error| format!("voice input model could not be verified: {error}"))?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(format!("{:x}", digest.finalize()) == MODEL_SHA256)
}

fn remove_if_present(path: &Path, label: &str) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("{label} could not be replaced: {error}")),
    }
}

fn cleanup_legacy_downloads(directory: &Path) -> Result<(), String> {
    let prefix = format!("{MODEL_FILENAME}.part-");
    let entries = fs::read_dir(directory)
        .map_err(|error| format!("voice input cache could not be inspected: {error}"))?;
    for entry in entries {
        let entry =
            entry.map_err(|error| format!("voice input cache could not be inspected: {error}"))?;
        if !entry
            .file_name()
            .to_str()
            .is_some_and(|name| name.starts_with(&prefix))
        {
            continue;
        }
        let file_type = entry.file_type().map_err(|error| {
            format!("incomplete voice input download could not be inspected: {error}")
        })?;
        if file_type.is_file() || file_type.is_symlink() {
            remove_if_present(&entry.path(), "incomplete voice input download")?;
        }
    }
    Ok(())
}

struct TemporaryModel {
    path: PathBuf,
}

impl TemporaryModel {
    fn new(path: PathBuf) -> Result<Self, String> {
        remove_if_present(&path, "incomplete voice input download")?;
        Ok(Self { path })
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TemporaryModel {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_contract_is_pinned_and_bounded() {
        assert_eq!(MODEL_BYTES, 559_647_200);
        assert_eq!(MODEL_SHA256.len(), 64);
        assert!(MODEL_URL.contains(MODEL_REVISION));
        assert!(MODEL_URL.starts_with("https://huggingface.co/handy-computer/"));
        assert!(MODEL_FILENAME.ends_with("Q5_K_M.gguf"));
        assert_eq!(MODEL_PART_FILENAME, format!("{MODEL_FILENAME}.part"));
        assert_eq!(MODEL_LOCK_FILENAME, format!("{MODEL_FILENAME}.lock"));
    }

    #[test]
    fn temporary_download_is_removed_on_every_exit_path() {
        let directory = std::env::temp_dir().join(format!(
            "gsv-transcribe-model-test-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        fs::create_dir_all(&directory).expect("test cache directory should be created");
        let path = directory.join(MODEL_PART_FILENAME);
        {
            let temporary = TemporaryModel::new(path.clone())
                .expect("temporary download should be initialized");
            fs::write(temporary.path(), b"partial")
                .expect("test partial download should be written");
            assert!(path.is_file());
        }
        assert!(!path.exists());
        fs::remove_dir_all(directory).expect("test cache directory should be removed");
    }

    #[test]
    fn legacy_pid_download_cleanup_is_exactly_scoped() {
        let directory = std::env::temp_dir().join(format!(
            "gsv-transcribe-legacy-test-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        fs::create_dir_all(&directory).expect("test cache directory should be created");
        let legacy = directory.join(format!("{MODEL_FILENAME}.part-1234"));
        let stable = directory.join(MODEL_PART_FILENAME);
        let unrelated = directory.join(format!("other-{MODEL_FILENAME}.part-1234"));
        fs::write(&legacy, b"legacy").expect("legacy download should be written");
        fs::write(&stable, b"stable").expect("stable download should be written");
        fs::write(&unrelated, b"unrelated").expect("unrelated file should be written");

        cleanup_legacy_downloads(&directory).expect("legacy downloads should be cleaned");

        assert!(!legacy.exists());
        assert!(stable.is_file());
        assert!(unrelated.is_file());
        fs::remove_dir_all(directory).expect("test cache directory should be removed");
    }
}
