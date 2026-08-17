use std::fs::{self, OpenOptions};
use std::io::{self, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

const MAX_MATERIALIZED_MEDIA_BYTES: usize = 48 * 1024 * 1024;

#[derive(Debug)]
pub(crate) struct MediaFileStore {
    directory: tempfile::TempDir,
    next_id: u64,
}

#[derive(Debug)]
pub(crate) struct MediaMaterialization {
    directory: PathBuf,
    id: u64,
    bytes: Arc<[u8]>,
    filename: Option<String>,
    mime_type: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct MaterializedMedia {
    pub(crate) path: PathBuf,
    pub(crate) display_name: String,
}

impl MediaFileStore {
    pub(crate) fn new() -> io::Result<Self> {
        let directory = tempfile::Builder::new()
            .prefix("gsv-native-open-")
            .tempdir()?;
        restrict_directory(directory.path())?;
        Ok(Self {
            directory,
            next_id: 1,
        })
    }

    pub(crate) fn reserve(
        &mut self,
        bytes: Arc<[u8]>,
        filename: Option<String>,
        mime_type: Option<String>,
    ) -> io::Result<MediaMaterialization> {
        if bytes.len() > MAX_MATERIALIZED_MEDIA_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "media exceeds materialization limit",
            ));
        }
        let id = self.next_id;
        self.next_id = self.next_id.saturating_add(1).max(1);
        Ok(MediaMaterialization {
            directory: self.directory.path().to_path_buf(),
            id,
            bytes,
            filename,
            mime_type,
        })
    }
}

impl MediaMaterialization {
    /// Writes fetched bytes to a private session directory for the operating system's registered
    /// viewer. This deliberately runs away from GPUI's foreground executor.
    pub(crate) fn write(self) -> io::Result<MaterializedMedia> {
        let display_name = safe_display_name(self.filename.as_deref());
        // Provider filenames are display metadata, not authority for how an operating system
        // opens fetched bytes. Prefer the declared MIME mapping and accept only a deliberately
        // inert set of fallback extensions.
        let extension = extension_for_mime(self.mime_type.as_deref())
            .map(str::to_string)
            .or_else(|| safe_extension(&display_name));
        let stem = format!("media-{}", self.id);
        let final_path = self.directory.join(match extension.as_deref() {
            Some(extension) => format!("{stem}.{extension}"),
            None => stem,
        });
        let partial_path = final_path.with_extension(match extension.as_deref() {
            Some(extension) => format!("{extension}.part"),
            None => "part".to_string(),
        });
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&partial_path)?;
        restrict_file(&partial_path)?;
        let mut writer = BufWriter::new(file);
        if let Err(error) = writer.write_all(&self.bytes).and_then(|_| writer.flush()) {
            let _ = fs::remove_file(&partial_path);
            return Err(error);
        }
        if let Err(error) = writer.get_ref().sync_all() {
            let _ = fs::remove_file(&partial_path);
            return Err(error);
        }
        if let Err(error) = fs::rename(&partial_path, &final_path) {
            let _ = fs::remove_file(&partial_path);
            return Err(error);
        }
        Ok(MaterializedMedia {
            path: final_path,
            display_name,
        })
    }
}

fn safe_display_name(filename: Option<&str>) -> String {
    let name = filename
        .map(Path::new)
        .and_then(Path::file_name)
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| "attachment".to_string());
    let sanitized = name
        .chars()
        .take(160)
        .map(|character| {
            if character.is_control() {
                '_'
            } else {
                character
            }
        })
        .collect::<String>();
    if sanitized.trim().is_empty() {
        "attachment".to_string()
    } else {
        sanitized
    }
}

fn safe_extension(filename: &str) -> Option<String> {
    let extension = Path::new(filename)
        .extension()?
        .to_string_lossy()
        .to_ascii_lowercase();
    matches!(
        extension.as_str(),
        "pdf"
            | "txt"
            | "csv"
            | "json"
            | "png"
            | "jpg"
            | "jpeg"
            | "gif"
            | "webp"
            | "svg"
            | "mp3"
            | "m4a"
            | "ogg"
            | "wav"
            | "flac"
            | "mp4"
            | "webm"
            | "mov"
    )
    .then_some(extension)
}

fn extension_for_mime(mime_type: Option<&str>) -> Option<&'static str> {
    match mime_type?
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "application/pdf" => Some("pdf"),
        "audio/mpeg" => Some("mp3"),
        "audio/mp4" => Some("m4a"),
        "audio/ogg" => Some("ogg"),
        "audio/wav" | "audio/x-wav" => Some("wav"),
        "video/mp4" => Some("mp4"),
        "video/webm" => Some("webm"),
        "video/quicktime" => Some("mov"),
        "image/png" => Some("png"),
        "image/jpeg" => Some("jpg"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        "image/svg+xml" => Some("svg"),
        "text/plain" => Some("txt"),
        "text/csv" => Some("csv"),
        "application/json" => Some("json"),
        _ => None,
    }
}

#[cfg(unix)]
fn restrict_directory(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt as _;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
}

#[cfg(not(unix))]
fn restrict_directory(_: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(unix)]
fn restrict_file(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt as _;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn restrict_file(_: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn materializes_bytes_under_a_private_random_session_path() {
        let mut store = MediaFileStore::new().expect("media store");
        let task = store
            .reserve(
                Arc::from(b"pdf fixture".as_slice()),
                Some("../report.pdf".to_string()),
                Some("application/pdf".to_string()),
            )
            .expect("reserve");
        let materialized = task.write().expect("write media");

        assert_eq!(materialized.display_name, "report.pdf");
        assert_eq!(
            materialized
                .path
                .extension()
                .and_then(|value| value.to_str()),
            Some("pdf")
        );
        assert_eq!(
            fs::read(&materialized.path).expect("read media"),
            b"pdf fixture"
        );
    }

    #[test]
    fn ignores_hostile_filename_extensions_and_uses_known_mime() {
        let mut store = MediaFileStore::new().expect("media store");
        let materialized = store
            .reserve(
                Arc::from(b"video".as_slice()),
                Some("movie.evil-extension-that-is-way-too-long".to_string()),
                Some("video/mp4".to_string()),
            )
            .expect("reserve")
            .write()
            .expect("write media");
        assert_eq!(
            materialized
                .path
                .extension()
                .and_then(|value| value.to_str()),
            Some("mp4")
        );

        let unknown = store
            .reserve(
                Arc::from(b"untrusted".as_slice()),
                Some("launch.desktop".to_string()),
                Some("application/octet-stream".to_string()),
            )
            .expect("reserve unknown media")
            .write()
            .expect("write unknown media");
        assert!(unknown.path.extension().is_none());
    }
}
