use std::fs::{self, File, OpenOptions};
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};

use crate::content::MediaKind;

pub(crate) const MAX_ATTACHMENTS: usize = 20;
pub(crate) const MAX_ATTACHMENT_BYTES: u64 = 48 * 1024 * 1024;
pub(crate) const MAX_ATTACHMENT_TOTAL_BYTES: u64 = 48 * 1024 * 1024;

const COPY_BUFFER_BYTES: usize = 128 * 1024;
const SNIFF_BYTES: usize = 8 * 1024;

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct DraftAttachment {
    pub(crate) id: u64,
    pub(crate) media_id: String,
    pub(crate) snapshot: PathBuf,
    pub(crate) filename: String,
    pub(crate) mime_type: String,
    pub(crate) kind: MediaKind,
    pub(crate) size: u64,
}

#[derive(Debug)]
pub(crate) struct AttachmentStore {
    directory: tempfile::TempDir,
    instance_id: uuid::Uuid,
    next_id: u64,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum AttachmentError {
    TooMany { count: usize, maximum: usize },
    NotAFile { filename: String },
    FileTooLarge { filename: String },
    TotalTooLarge,
    Unreadable { filename: String },
    SnapshotUnavailable,
}

impl AttachmentError {
    pub(crate) fn user_message(&self) -> String {
        match self {
            Self::TooMany { maximum, .. } => {
                format!("You can attach up to {maximum} files to one thought.")
            }
            Self::NotAFile { filename } => format!("{filename} is not a regular file."),
            Self::FileTooLarge { filename } => {
                format!("{filename} is larger than the 48 MiB attachment limit.")
            }
            Self::TotalTooLarge => {
                "Those files are larger than the 48 MiB attachment limit together.".to_string()
            }
            Self::Unreadable { filename } => format!("{filename} could not be read."),
            Self::SnapshotUnavailable => {
                "The attachment workspace could not be prepared.".to_string()
            }
        }
    }
}

impl AttachmentStore {
    pub(crate) fn new() -> Result<Self, AttachmentError> {
        let directory = tempfile::Builder::new()
            .prefix("gsv-desktop-attachments-")
            .tempdir()
            .map_err(|_| AttachmentError::SnapshotUnavailable)?;
        restrict_directory(directory.path())?;
        Ok(Self {
            directory,
            instance_id: uuid::Uuid::new_v4(),
            next_id: 1,
        })
    }

    pub(crate) fn reserve_batch(
        &mut self,
        paths: Vec<PathBuf>,
    ) -> Result<AttachmentBatch, AttachmentError> {
        if paths.len() > MAX_ATTACHMENTS {
            return Err(AttachmentError::TooMany {
                count: paths.len(),
                maximum: MAX_ATTACHMENTS,
            });
        }
        let start_id = self.next_id;
        self.next_id = self.next_id.saturating_add(paths.len() as u64).max(1);
        Ok(AttachmentBatch {
            root: self.directory.path().to_path_buf(),
            instance_id: self.instance_id,
            start_id,
            paths,
        })
    }
}

#[derive(Debug)]
pub(crate) struct AttachmentBatch {
    root: PathBuf,
    instance_id: uuid::Uuid,
    start_id: u64,
    paths: Vec<PathBuf>,
}

impl AttachmentBatch {
    /// Copies selected files into an app-owned, private snapshot. Call this on a background
    /// executor: opening a filesystem path is intentionally never part of GPUI event handling.
    pub(crate) fn prepare(self) -> Result<Vec<DraftAttachment>, AttachmentError> {
        let mut prepared = Vec::with_capacity(self.paths.len());
        let mut total = 0_u64;

        for (index, source) in self.paths.iter().enumerate() {
            let id = self.start_id.saturating_add(index as u64);
            match snapshot_one(&self.root, self.instance_id, id, source, &mut total) {
                Ok(attachment) => prepared.push(attachment),
                Err(error) => {
                    remove_snapshots(&prepared);
                    return Err(error);
                }
            }
        }
        Ok(prepared)
    }
}

fn snapshot_one(
    root: &Path,
    instance_id: uuid::Uuid,
    id: u64,
    source: &Path,
    total: &mut u64,
) -> Result<DraftAttachment, AttachmentError> {
    let filename = display_filename(source);
    let input = File::open(source).map_err(|_| AttachmentError::Unreadable {
        filename: filename.clone(),
    })?;
    let metadata = input.metadata().map_err(|_| AttachmentError::Unreadable {
        filename: filename.clone(),
    })?;
    if !metadata.is_file() {
        return Err(AttachmentError::NotAFile { filename });
    }
    if metadata.len() > MAX_ATTACHMENT_BYTES {
        return Err(AttachmentError::FileTooLarge { filename });
    }
    if total
        .checked_add(metadata.len())
        .is_none_or(|size| size > MAX_ATTACHMENT_TOTAL_BYTES)
    {
        return Err(AttachmentError::TotalTooLarge);
    }

    let extension = safe_extension(source);
    let snapshot = root.join(match extension.as_deref() {
        Some(extension) => format!("{id}.{extension}"),
        None => id.to_string(),
    });
    let output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&snapshot)
        .map_err(|_| AttachmentError::SnapshotUnavailable)?;
    restrict_file(&snapshot)?;

    let copy_result = copy_bounded(input, output);
    let (size, prefix) = match copy_result {
        Ok(result) => result,
        Err(CopyFailure::TooLarge) => {
            let _ = fs::remove_file(&snapshot);
            return Err(AttachmentError::FileTooLarge { filename });
        }
        Err(CopyFailure::Io) => {
            let _ = fs::remove_file(&snapshot);
            return Err(AttachmentError::Unreadable { filename });
        }
    };
    if total
        .checked_add(size)
        .is_none_or(|next| next > MAX_ATTACHMENT_TOTAL_BYTES)
    {
        let _ = fs::remove_file(&snapshot);
        return Err(AttachmentError::TotalTooLarge);
    }
    *total += size;

    let mime_type = infer::get(&prefix)
        .map(|kind| kind.mime_type().to_string())
        .or_else(|| {
            mime_guess::from_path(source)
                .first_raw()
                .map(str::to_string)
        })
        .unwrap_or_else(|| "application/octet-stream".to_string());
    let kind = media_kind(&mime_type);
    Ok(DraftAttachment {
        id,
        media_id: format!("native-{instance_id}-{id}"),
        snapshot,
        filename,
        mime_type,
        kind,
        size,
    })
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CopyFailure {
    TooLarge,
    Io,
}

fn copy_bounded(input: File, output: File) -> Result<(u64, Vec<u8>), CopyFailure> {
    let mut input = BufReader::with_capacity(COPY_BUFFER_BYTES, input);
    let mut output = BufWriter::with_capacity(COPY_BUFFER_BYTES, output);
    let mut buffer = vec![0_u8; COPY_BUFFER_BYTES];
    let mut prefix = Vec::with_capacity(SNIFF_BYTES);
    let mut size = 0_u64;

    loop {
        let read = input.read(&mut buffer).map_err(|_| CopyFailure::Io)?;
        if read == 0 {
            break;
        }
        size = size.checked_add(read as u64).ok_or(CopyFailure::TooLarge)?;
        if size > MAX_ATTACHMENT_BYTES {
            return Err(CopyFailure::TooLarge);
        }
        let prefix_remaining = SNIFF_BYTES.saturating_sub(prefix.len());
        prefix.extend_from_slice(&buffer[..read.min(prefix_remaining)]);
        output
            .write_all(&buffer[..read])
            .map_err(|_| CopyFailure::Io)?;
    }
    output.flush().map_err(|_| CopyFailure::Io)?;
    output.get_ref().sync_all().map_err(|_| CopyFailure::Io)?;
    Ok((size, prefix))
}

fn display_filename(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| "attachment".to_string())
}

fn safe_extension(path: &Path) -> Option<String> {
    let extension = path.extension()?.to_string_lossy().to_ascii_lowercase();
    (!extension.is_empty()
        && extension.len() <= 16
        && extension.bytes().all(|byte| byte.is_ascii_alphanumeric()))
    .then_some(extension)
}

pub(crate) fn media_kind(mime_type: &str) -> MediaKind {
    let mime_type = mime_type
        .split(';')
        .next()
        .unwrap_or(mime_type)
        .trim()
        .to_ascii_lowercase();
    if mime_type.starts_with("image/") {
        MediaKind::Image
    } else if mime_type.starts_with("audio/") {
        MediaKind::Audio
    } else if mime_type.starts_with("video/") {
        MediaKind::Video
    } else {
        MediaKind::Document
    }
}

fn remove_snapshots(attachments: &[DraftAttachment]) {
    for attachment in attachments {
        let _ = fs::remove_file(&attachment.snapshot);
    }
}

#[cfg(unix)]
fn restrict_directory(path: &Path) -> Result<(), AttachmentError> {
    use std::os::unix::fs::PermissionsExt as _;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|_| AttachmentError::SnapshotUnavailable)
}

#[cfg(not(unix))]
fn restrict_directory(_: &Path) -> Result<(), AttachmentError> {
    Ok(())
}

#[cfg(unix)]
fn restrict_file(path: &Path) -> Result<(), AttachmentError> {
    use std::os::unix::fs::PermissionsExt as _;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|_| AttachmentError::SnapshotUnavailable)
}

#[cfg(not(unix))]
fn restrict_file(_: &Path) -> Result<(), AttachmentError> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input_file(directory: &Path, name: &str, bytes: &[u8]) -> PathBuf {
        let path = directory.join(name);
        fs::write(&path, bytes).expect("write fixture");
        path
    }

    #[test]
    fn snapshots_selected_files_with_stable_owned_metadata() {
        let sources = tempfile::tempdir().expect("source directory");
        let source = input_file(sources.path(), "tiny.png", b"\x89PNG\r\n\x1a\nfixture");
        let mut store = AttachmentStore::new().expect("attachment store");
        let batch = store.reserve_batch(vec![source.clone()]).expect("batch");
        let attachments = batch.prepare().expect("prepared attachments");

        fs::write(source, b"changed after selection").expect("replace source");
        assert_eq!(attachments.len(), 1);
        assert_eq!(attachments[0].filename, "tiny.png");
        assert_eq!(attachments[0].mime_type, "image/png");
        assert_eq!(attachments[0].kind, MediaKind::Image);
        assert_eq!(attachments[0].size, 15);
        assert_eq!(
            fs::read(&attachments[0].snapshot).expect("snapshot"),
            b"\x89PNG\r\n\x1a\nfixture"
        );
        assert!(attachments[0].media_id.starts_with("native-"));
    }

    #[test]
    fn rejects_a_batch_above_the_gateway_item_limit() {
        let mut store = AttachmentStore::new().expect("attachment store");
        let error = store
            .reserve_batch(vec![PathBuf::from("file"); MAX_ATTACHMENTS + 1])
            .expect_err("too many attachments");
        assert_eq!(
            error,
            AttachmentError::TooMany {
                count: MAX_ATTACHMENTS + 1,
                maximum: MAX_ATTACHMENTS,
            }
        );
    }

    #[test]
    fn rejects_directories_without_leaving_snapshots() {
        let sources = tempfile::tempdir().expect("source directory");
        let mut store = AttachmentStore::new().expect("attachment store");
        let batch = store
            .reserve_batch(vec![sources.path().to_path_buf()])
            .expect("batch");
        let error = batch.prepare().expect_err("directory is not a file");
        assert!(matches!(error, AttachmentError::NotAFile { .. }));
        assert_eq!(
            fs::read_dir(store.directory.path())
                .expect("snapshot directory")
                .count(),
            0
        );
    }

    #[test]
    fn classifies_non_visual_content_as_a_document() {
        assert_eq!(media_kind("audio/ogg"), MediaKind::Audio);
        assert_eq!(media_kind("video/mp4"), MediaKind::Video);
        assert_eq!(media_kind("application/pdf"), MediaKind::Document);
    }
}
