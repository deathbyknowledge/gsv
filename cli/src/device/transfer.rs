use gsv::connection::Connection;
use gsv::protocol::{
    build_binary_frame, parse_binary_frame, BINARY_FRAME_DATA, BINARY_FRAME_END, BINARY_FRAME_ERROR,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::sync::Notify;

const MAX_TRANSFER_READ_BYTES: u64 = 1024 * 1024;
const BINARY_TRANSFER_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone)]
pub struct BinaryFrameInbox {
    frames: Arc<Mutex<HashMap<u32, VecDeque<QueuedBinaryFrame>>>>,
    notify: Arc<Notify>,
}

#[derive(Clone)]
struct QueuedBinaryFrame {
    flags: u8,
    payload: Vec<u8>,
}

impl BinaryFrameInbox {
    pub fn new() -> Self {
        Self {
            frames: Arc::new(Mutex::new(HashMap::new())),
            notify: Arc::new(Notify::new()),
        }
    }

    pub fn push(&self, data: Vec<u8>) {
        let Some((stream_id, flags, payload)) = parse_binary_frame(&data) else {
            return;
        };
        {
            let mut frames = self.frames.lock().unwrap();
            frames
                .entry(stream_id)
                .or_default()
                .push_back(QueuedBinaryFrame { flags, payload });
        }
        self.notify.notify_waiters();
    }

    async fn take(&self, stream_id: u32) -> Result<QueuedBinaryFrame, String> {
        let deadline = tokio::time::Instant::now() + BINARY_TRANSFER_TIMEOUT;
        loop {
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();

            if let Some(frame) = self.pop(stream_id) {
                return Ok(frame);
            }

            tokio::time::timeout_at(deadline, notified.as_mut())
                .await
                .map_err(|_| {
                    format!("Timed out waiting for binary transfer stream {}", stream_id)
                })?;
        }
    }

    fn pop(&self, stream_id: u32) -> Option<QueuedBinaryFrame> {
        let mut frames = self.frames.lock().unwrap();
        let queue = frames.get_mut(&stream_id)?;
        let frame = queue.pop_front();
        if queue.is_empty() {
            frames.remove(&stream_id);
        }
        frame
    }
}

pub async fn handle_transfer_syscall(
    call: &str,
    args: Value,
    workspace: &Path,
    conn: &Connection,
    binary_inbox: &BinaryFrameInbox,
) -> Option<Result<Value, String>> {
    match call {
        "fs.transfer.stat" => Some(handle_stat(args, workspace).await),
        "fs.transfer.read" => Some(handle_read(args, workspace, conn).await),
        "fs.transfer.write" => Some(handle_write(args, workspace, binary_inbox).await),
        _ => None,
    }
}

#[derive(Deserialize)]
struct TransferStatArgs {
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TransferReadArgs {
    path: String,
    offset: u64,
    length: u64,
    stream_id: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TransferWriteArgs {
    path: String,
    offset: u64,
    stream_id: u32,
    expected_size: u64,
    #[serde(default)]
    content_type: Option<String>,
    #[serde(default)]
    done: bool,
}

async fn handle_stat(args: Value, workspace: &Path) -> Result<Value, String> {
    let args: TransferStatArgs =
        serde_json::from_value(args).map_err(|e| format!("Invalid arguments: {}", e))?;
    let path = resolve_path(&args.path, workspace);
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|e| format!("Failed to stat '{}': {}", path.display(), e))?;
    let content_type = if metadata.is_file() {
        mime_guess::from_path(&path)
            .first()
            .map(|mime| mime.essence_str().to_string())
    } else {
        None
    };

    Ok(json!({
        "ok": true,
        "path": path.display().to_string(),
        "size": metadata.len(),
        "isFile": metadata.is_file(),
        "isDirectory": metadata.is_dir(),
        "contentType": content_type
    }))
}

async fn handle_read(args: Value, workspace: &Path, conn: &Connection) -> Result<Value, String> {
    let args: TransferReadArgs =
        serde_json::from_value(args).map_err(|e| format!("Invalid arguments: {}", e))?;
    let (path, bytes, eof) = read_transfer_bytes(&args, workspace).await?;
    conn.send_binary(build_binary_frame(
        args.stream_id,
        BINARY_FRAME_DATA | BINARY_FRAME_END,
        &bytes,
    ))
    .await
    .map_err(|e| format!("Failed to send binary transfer data: {}", e))?;

    Ok(json!({
        "ok": true,
        "path": path.display().to_string(),
        "offset": args.offset,
        "bytesRead": bytes.len(),
        "eof": eof
    }))
}

async fn handle_write(
    args: Value,
    workspace: &Path,
    binary_inbox: &BinaryFrameInbox,
) -> Result<Value, String> {
    let args: TransferWriteArgs =
        serde_json::from_value(args).map_err(|e| format!("Invalid arguments: {}", e))?;
    let frame = binary_inbox.take(args.stream_id).await?;
    if frame.flags & BINARY_FRAME_ERROR != 0 {
        return Err(String::from_utf8(frame.payload)
            .unwrap_or_else(|_| "Binary transfer failed".to_string()));
    }
    if frame.flags & BINARY_FRAME_DATA == 0 {
        return Err(format!(
            "Binary transfer stream {} did not include data",
            args.stream_id
        ));
    }
    write_transfer_bytes(&args, workspace, &frame.payload).await
}

async fn write_transfer_bytes(
    args: &TransferWriteArgs,
    workspace: &Path,
    bytes: &[u8],
) -> Result<Value, String> {
    let path = resolve_path(&args.path, workspace);
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Failed to create '{}': {}", parent.display(), e))?;
    }

    let mut options = tokio::fs::OpenOptions::new();
    options.create(true).write(true);
    if args.offset == 0 {
        options.truncate(true);
    }
    let mut file = options
        .open(&path)
        .await
        .map_err(|e| format!("Failed to open '{}': {}", path.display(), e))?;
    file.seek(std::io::SeekFrom::Start(args.offset))
        .await
        .map_err(|e| format!("Failed to seek '{}': {}", path.display(), e))?;
    file.write_all(bytes)
        .await
        .map_err(|e| format!("Failed to write '{}': {}", path.display(), e))?;
    file.flush()
        .await
        .map_err(|e| format!("Failed to flush '{}': {}", path.display(), e))?;
    drop(file);

    if args.done {
        let metadata = tokio::fs::metadata(&path)
            .await
            .map_err(|e| format!("Failed to stat '{}': {}", path.display(), e))?;
        if metadata.len() != args.expected_size {
            return Err(format!(
                "Transfer size mismatch for '{}': expected {}, got {}",
                path.display(),
                args.expected_size,
                metadata.len()
            ));
        }
    }

    Ok(json!({
        "ok": true,
        "path": path.display().to_string(),
        "offset": args.offset,
        "bytesWritten": bytes.len(),
        "done": args.done,
        "contentType": args.content_type
    }))
}

async fn read_transfer_bytes(
    args: &TransferReadArgs,
    workspace: &Path,
) -> Result<(PathBuf, Vec<u8>, bool), String> {
    let path = resolve_path(&args.path, workspace);
    let length = args.length.min(MAX_TRANSFER_READ_BYTES) as usize;
    let mut file = tokio::fs::File::open(&path)
        .await
        .map_err(|e| format!("Failed to open '{}': {}", path.display(), e))?;
    file.seek(std::io::SeekFrom::Start(args.offset))
        .await
        .map_err(|e| format!("Failed to seek '{}': {}", path.display(), e))?;

    let mut bytes = vec![0u8; length];
    let bytes_read = file
        .read(&mut bytes)
        .await
        .map_err(|e| format!("Failed to read '{}': {}", path.display(), e))?;
    bytes.truncate(bytes_read);
    let total_size = tokio::fs::metadata(&path)
        .await
        .map_err(|e| format!("Failed to stat '{}': {}", path.display(), e))?
        .len();
    let eof = args.offset + bytes_read as u64 >= total_size;
    Ok((path, bytes, eof))
}

fn resolve_path(path: &str, workspace: &Path) -> PathBuf {
    let path = PathBuf::from(path);
    if path.is_absolute() {
        path
    } else {
        workspace.join(path)
    }
}

#[cfg(test)]
mod tests {
    use super::{read_transfer_bytes, write_transfer_bytes, TransferReadArgs, TransferWriteArgs};
    use serde_json::json;
    use std::path::PathBuf;

    fn test_root() -> PathBuf {
        std::env::temp_dir().join(format!("gsv-transfer-test-{}", uuid::Uuid::new_v4()))
    }

    #[tokio::test]
    async fn reads_file_chunks() {
        let root = test_root();
        tokio::fs::create_dir_all(&root).await.unwrap();
        tokio::fs::write(root.join("source.txt"), "hello world")
            .await
            .unwrap();

        let (_path, bytes, eof) = read_transfer_bytes(
            &TransferReadArgs {
                path: "source.txt".to_string(),
                offset: 6,
                length: 5,
                stream_id: 1,
            },
            &root,
        )
        .await
        .unwrap();
        assert_eq!(bytes, b"world");
        assert!(eof);

        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[test]
    fn deserializes_transfer_stream_ids_from_camel_case_json() {
        let read: TransferReadArgs = serde_json::from_value(json!({
            "path": "source.txt",
            "offset": 0,
            "length": 10,
            "streamId": 123
        }))
        .unwrap();
        assert_eq!(read.stream_id, 123);

        let write: TransferWriteArgs = serde_json::from_value(json!({
            "path": "dest.txt",
            "offset": 0,
            "streamId": 456,
            "expectedSize": 10,
            "done": true
        }))
        .unwrap();
        assert_eq!(write.stream_id, 456);
        assert_eq!(write.expected_size, 10);
    }

    #[tokio::test]
    async fn writes_chunks_and_validates_size() {
        let root = test_root();
        tokio::fs::create_dir_all(&root).await.unwrap();

        write_transfer_bytes(
            &TransferWriteArgs {
                path: "dest.txt".to_string(),
                offset: 0,
                stream_id: 1,
                expected_size: 11,
                content_type: None,
                done: false,
            },
            &root,
            b"hello ",
        )
        .await
        .unwrap();
        write_transfer_bytes(
            &TransferWriteArgs {
                path: "dest.txt".to_string(),
                offset: 6,
                stream_id: 2,
                expected_size: 11,
                content_type: None,
                done: true,
            },
            &root,
            b"world",
        )
        .await
        .unwrap();

        assert_eq!(
            tokio::fs::read_to_string(root.join("dest.txt"))
                .await
                .unwrap(),
            "hello world"
        );

        tokio::fs::remove_dir_all(root).await.unwrap();
    }
}
