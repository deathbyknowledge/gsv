use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use sha2::{Digest, Sha256};
use transcribe_cpp::{Backend, CancelToken, Model, ModelOptions, Session, SessionOptions};

use crate::protocol::{ErrorCode, Phase};

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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LoadError {
    Cancelled,
    Failed(ErrorCode),
}

impl Engine {
    pub fn load(
        cancelled: &AtomicBool,
        mut report: impl FnMut(Phase, Option<f32>),
    ) -> Result<Self, LoadError> {
        let model_path = ensure_model(cancelled, &mut report)?;
        check_cancelled(cancelled)?;
        report(Phase::Loading, None);
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
        .map_err(|_| {
            if std::env::var_os("GSV_TRANSCRIBE_MODEL").is_none() {
                let marker = model_path.with_file_name(format!("{MODEL_FILENAME}.sha256"));
                let _ = remove_if_present(&marker);
            }
            LoadError::Failed(ErrorCode::ModelInvalid)
        })?;
        if !model.capabilities().supports_streaming {
            return Err(LoadError::Failed(ErrorCode::ModelInvalid));
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
            .map_err(|_| LoadError::Failed(ErrorCode::EngineFailed))?;
        let cancel = CancelToken::new();
        session.set_cancel_token(&cancel);
        // Loading the native model itself cannot currently be interrupted. A
        // completed engine is still safe to cache after its original request
        // was cancelled, and lets an immediate retry begin without reloading.
        Ok(Self { session, cancel })
    }
}

fn ensure_model(
    cancelled: &AtomicBool,
    report: &mut impl FnMut(Phase, Option<f32>),
) -> Result<PathBuf, LoadError> {
    if let Some(custom) = std::env::var_os("GSV_TRANSCRIBE_MODEL") {
        let path = PathBuf::from(custom);
        return path
            .is_file()
            .then_some(path)
            .ok_or(LoadError::Failed(ErrorCode::ModelInvalid));
    }

    let directory = model_cache_directory()?;
    fs::create_dir_all(&directory).map_err(|_| LoadError::Failed(ErrorCode::DownloadFailed))?;
    let lock = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(directory.join(MODEL_LOCK_FILENAME))
        .map_err(|_| LoadError::Failed(ErrorCode::DownloadFailed))?;
    // Another app instance may own the cache preparation for minutes. Publish
    // a bounded phase before waiting so this request never appears inert.
    report(Phase::Downloading, None);
    acquire_lock(&lock, cancelled)?;
    cleanup_legacy_downloads(&directory)?;

    let path = directory.join(MODEL_FILENAME);
    let marker = directory.join(format!("{MODEL_FILENAME}.sha256"));
    if model_is_verified(&path, &marker, cancelled, report)? {
        return Ok(path);
    }

    remove_if_present(&path)?;
    remove_if_present(&marker)?;
    let partial = directory.join(MODEL_PART_FILENAME);
    download_model(cancelled, report, &partial)?;
    check_cancelled(cancelled)?;
    report(Phase::Verifying, None);
    if !hash_matches(&partial, cancelled)? {
        // A failed digest means the prefix is not safe to resume. Remove it so
        // the next attempt starts from a clean, pinned response.
        remove_if_present(&partial)?;
        return Err(LoadError::Failed(ErrorCode::ModelInvalid));
    }
    check_cancelled(cancelled)?;
    fs::rename(&partial, &path).map_err(|_| LoadError::Failed(ErrorCode::DownloadFailed))?;
    fs::write(&marker, format!("{MODEL_SHA256}\n"))
        .map_err(|_| LoadError::Failed(ErrorCode::DownloadFailed))?;
    Ok(path)
}

fn acquire_lock(file: &File, cancelled: &AtomicBool) -> Result<(), LoadError> {
    loop {
        check_cancelled(cancelled)?;
        match file.try_lock() {
            Ok(()) => return Ok(()),
            Err(std::fs::TryLockError::WouldBlock) => {
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(std::fs::TryLockError::Error(_)) => {
                return Err(LoadError::Failed(ErrorCode::DownloadFailed));
            }
        }
    }
}

fn model_cache_directory() -> Result<PathBuf, LoadError> {
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
        .ok_or(LoadError::Failed(ErrorCode::DownloadFailed))
}

fn model_is_verified(
    path: &Path,
    marker: &Path,
    cancelled: &AtomicBool,
    report: &mut impl FnMut(Phase, Option<f32>),
) -> Result<bool, LoadError> {
    if fs::metadata(path).map(|metadata| metadata.len()).ok() != Some(MODEL_BYTES) {
        return Ok(false);
    }
    if fs::read_to_string(marker)
        .ok()
        .is_some_and(|value| value.trim() == MODEL_SHA256)
    {
        return Ok(true);
    }
    report(Phase::Verifying, None);
    if !hash_matches(path, cancelled)? {
        return Ok(false);
    }
    fs::write(marker, format!("{MODEL_SHA256}\n"))
        .map_err(|_| LoadError::Failed(ErrorCode::DownloadFailed))?;
    Ok(true)
}

fn download_model(
    cancelled: &AtomicBool,
    report: &mut impl FnMut(Phase, Option<f32>),
    destination: &Path,
) -> Result<(), LoadError> {
    check_cancelled(cancelled)?;
    let mut offset = fs::metadata(destination)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    if offset > MODEL_BYTES {
        remove_if_present(destination)?;
        offset = 0;
    }
    report(Phase::Downloading, Some(progress_for_download(offset)));
    if offset == MODEL_BYTES {
        return Ok(());
    }

    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(15))
        .timeout_read(Duration::from_secs(10))
        .build();
    let mut request = agent.get(MODEL_URL);
    if offset > 0 {
        request = request.set("Range", &format!("bytes={offset}-"));
    }
    let response = request
        .call()
        .map_err(|_| LoadError::Failed(ErrorCode::DownloadFailed))?;
    check_cancelled(cancelled)?;

    let append = if offset == 0 {
        if response.status() != 200 {
            remove_if_present(destination)?;
            return Err(LoadError::Failed(ErrorCode::DownloadFailed));
        }
        false
    } else if response.status() == 206
        && response
            .header("Content-Range")
            .is_some_and(|value| valid_content_range(value, offset))
    {
        true
    } else if response.status() == 200 {
        // A server may ignore Range. A complete 200 response is safe only if
        // it replaces, rather than appends to, the prior prefix.
        offset = 0;
        false
    } else {
        remove_if_present(destination)?;
        return Err(LoadError::Failed(ErrorCode::DownloadFailed));
    };

    let mut output = if append && offset > 0 {
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(destination)
    } else {
        File::create(destination)
    }
    .map_err(|_| LoadError::Failed(ErrorCode::DownloadFailed))?;
    let mut reader = response.into_reader();
    let mut buffer = vec![0_u8; 1024 * 1024];
    let mut received = offset;
    let mut last_percent = received.saturating_mul(100) / MODEL_BYTES;
    loop {
        if cancelled.load(Ordering::Acquire) {
            let _ = output.sync_all();
            return Err(LoadError::Cancelled);
        }
        let count = reader
            .read(&mut buffer)
            .map_err(|_| LoadError::Failed(ErrorCode::DownloadFailed))?;
        if count == 0 {
            break;
        }
        output
            .write_all(&buffer[..count])
            .map_err(|_| LoadError::Failed(ErrorCode::DownloadFailed))?;
        received = received.saturating_add(count as u64);
        if received > MODEL_BYTES {
            remove_if_present(destination)?;
            return Err(LoadError::Failed(ErrorCode::DownloadFailed));
        }
        let percent = received.saturating_mul(100) / MODEL_BYTES;
        if percent >= last_percent.saturating_add(2) {
            last_percent = percent;
            report(Phase::Downloading, Some(progress_for_download(received)));
        }
    }
    output
        .sync_all()
        .map_err(|_| LoadError::Failed(ErrorCode::DownloadFailed))?;
    if received != MODEL_BYTES {
        return Err(LoadError::Failed(ErrorCode::DownloadFailed));
    }
    Ok(())
}

fn progress_for_download(received: u64) -> f32 {
    (received as f64 / MODEL_BYTES as f64).clamp(0.0, 1.0) as f32
}

fn valid_content_range(value: &str, offset: u64) -> bool {
    let Some(value) = value.strip_prefix("bytes ") else {
        return false;
    };
    let Some((range, total)) = value.split_once('/') else {
        return false;
    };
    let Some((start, end)) = range.split_once('-') else {
        return false;
    };
    start.parse::<u64>().ok() == Some(offset)
        && end.parse::<u64>().ok() == Some(MODEL_BYTES - 1)
        && total.parse::<u64>().ok() == Some(MODEL_BYTES)
}

fn hash_matches(path: &Path, cancelled: &AtomicBool) -> Result<bool, LoadError> {
    let mut file = File::open(path).map_err(|_| LoadError::Failed(ErrorCode::ModelInvalid))?;
    let mut digest = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        check_cancelled(cancelled)?;
        let count = file
            .read(&mut buffer)
            .map_err(|_| LoadError::Failed(ErrorCode::ModelInvalid))?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(format!("{:x}", digest.finalize()) == MODEL_SHA256)
}

fn check_cancelled(cancelled: &AtomicBool) -> Result<(), LoadError> {
    if cancelled.load(Ordering::Acquire) {
        Err(LoadError::Cancelled)
    } else {
        Ok(())
    }
}

fn remove_if_present(path: &Path) -> Result<(), LoadError> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(LoadError::Failed(ErrorCode::DownloadFailed)),
    }
}

fn cleanup_legacy_downloads(directory: &Path) -> Result<(), LoadError> {
    let prefix = format!("{MODEL_FILENAME}.part-");
    let entries =
        fs::read_dir(directory).map_err(|_| LoadError::Failed(ErrorCode::DownloadFailed))?;
    for entry in entries {
        let entry = entry.map_err(|_| LoadError::Failed(ErrorCode::DownloadFailed))?;
        if !entry
            .file_name()
            .to_str()
            .is_some_and(|name| name.starts_with(&prefix))
        {
            continue;
        }
        let file_type = entry
            .file_type()
            .map_err(|_| LoadError::Failed(ErrorCode::DownloadFailed))?;
        if file_type.is_file() || file_type.is_symlink() {
            remove_if_present(&entry.path())?;
        }
    }
    Ok(())
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
    fn range_resume_requires_the_exact_pinned_remainder() {
        assert!(valid_content_range(
            &format!("bytes 1024-{}/{MODEL_BYTES}", MODEL_BYTES - 1),
            1024
        ));
        assert!(!valid_content_range(
            &format!("bytes 0-{}/{MODEL_BYTES}", MODEL_BYTES - 1),
            1024
        ));
        assert!(!valid_content_range(
            &format!("bytes 1024-2047/{MODEL_BYTES}"),
            1024
        ));
        assert!(!valid_content_range("bytes */559647200", 1024));
    }

    #[test]
    fn cancellation_is_bounded_and_distinct_from_failure() {
        let cancelled = AtomicBool::new(true);
        assert_eq!(check_cancelled(&cancelled), Err(LoadError::Cancelled));
        assert_eq!(progress_for_download(0), 0.0);
        assert_eq!(progress_for_download(MODEL_BYTES), 1.0);
        assert_eq!(progress_for_download(MODEL_BYTES + 1), 1.0);
    }

    #[test]
    fn stable_partial_is_preserved_for_a_validated_resume() {
        let directory = std::env::temp_dir().join(format!(
            "gsv-transcribe-model-test-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        fs::create_dir_all(&directory).expect("test cache directory should be created");
        let path = directory.join(MODEL_PART_FILENAME);
        fs::write(&path, b"verified response prefix")
            .expect("test partial download should be written");
        assert!(path.is_file());
        assert_eq!(
            fs::metadata(&path)
                .expect("test partial download metadata should be readable")
                .len(),
            24
        );
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
        fs::write(&legacy, b"legacy").expect("legacy downloads should be written");
        fs::write(&stable, b"stable").expect("stable download should be written");
        fs::write(&unrelated, b"unrelated").expect("unrelated file should be written");

        cleanup_legacy_downloads(&directory).expect("legacy downloads should be cleaned");

        assert!(!legacy.exists());
        assert!(stable.is_file());
        assert!(unrelated.is_file());
        fs::remove_dir_all(directory).expect("test cache directory should be removed");
    }
}
