use gsv::connection::Connection;
use gsv::protocol::{
    build_binary_frame, parse_binary_frame, FrameBodyDescriptor, BINARY_FRAME_DATA,
    BINARY_FRAME_END, BINARY_FRAME_ERROR,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Notify;

const MAX_TRANSFER_CHUNK_BYTES: usize = 1024 * 1024;
const BINARY_TRANSFER_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone)]
pub struct BinaryFrameInbox {
    frames: Arc<Mutex<HashMap<u32, VecDeque<QueuedBinaryFrame>>>>,
    notify: Arc<Notify>,
    next_outgoing_stream_id: Arc<AtomicU32>,
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
            next_outgoing_stream_id: Arc::new(AtomicU32::new(1)),
        }
    }

    fn allocate_outgoing_stream_id(&self) -> u32 {
        loop {
            let stream_id = self.next_outgoing_stream_id.fetch_add(1, Ordering::Relaxed);
            if stream_id != 0 {
                return stream_id;
            }
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

    fn discard(&self, stream_id: u32) {
        let mut frames = self.frames.lock().unwrap();
        frames.remove(&stream_id);
    }
}

pub(super) struct OutgoingTransferBody {
    stream_id: u32,
    length: u64,
    file: tokio::fs::File,
    path: PathBuf,
}

impl OutgoingTransferBody {
    pub(super) fn descriptor(&self) -> FrameBodyDescriptor {
        FrameBodyDescriptor {
            stream_id: self.stream_id,
            length: Some(self.length),
        }
    }

    pub(super) async fn send(mut self, conn: &Connection) -> Result<(), String> {
        let stream_id = self.stream_id;
        let result = self.send_inner(conn).await;
        if let Err(error) = &result {
            let _ = conn
                .send_binary(build_binary_frame(
                    stream_id,
                    BINARY_FRAME_ERROR | BINARY_FRAME_END,
                    error.as_bytes(),
                ))
                .await;
        }
        result
    }

    async fn send_inner(&mut self, conn: &Connection) -> Result<(), String> {
        let mut bytes_sent = 0u64;
        let mut buffer = vec![0u8; MAX_TRANSFER_CHUNK_BYTES];

        loop {
            let bytes_read = self
                .file
                .read(&mut buffer)
                .await
                .map_err(|e| format!("Failed to read '{}': {}", self.path.display(), e))?;
            if bytes_read == 0 {
                break;
            }

            let next_bytes_sent = bytes_sent
                .checked_add(bytes_read as u64)
                .ok_or_else(|| format!("Transfer size overflow for '{}'", self.path.display()))?;
            if next_bytes_sent > self.length {
                return Err(format!(
                    "Transfer size changed for '{}': expected {}, got more than {}",
                    self.path.display(),
                    self.length,
                    next_bytes_sent
                ));
            }

            conn.send_binary(build_binary_frame(
                self.stream_id,
                BINARY_FRAME_DATA,
                &buffer[..bytes_read],
            ))
            .await
            .map_err(|e| format!("Failed to send binary transfer data: {}", e))?;
            bytes_sent = next_bytes_sent;
        }

        if bytes_sent != self.length {
            return Err(format!(
                "Transfer size changed for '{}': expected {}, got {}",
                self.path.display(),
                self.length,
                bytes_sent
            ));
        }

        conn.send_binary(build_binary_frame(self.stream_id, BINARY_FRAME_END, &[]))
            .await
            .map_err(|e| format!("Failed to finish binary transfer: {}", e))?;
        Ok(())
    }
}

pub async fn handle_transfer_syscall(
    call: &str,
    args: Value,
    request_body: Option<FrameBodyDescriptor>,
    workspace: &Path,
    binary_inbox: &BinaryFrameInbox,
) -> Option<Result<(Value, Option<OutgoingTransferBody>), String>> {
    match call {
        "fs.transfer.stat" => Some(handle_stat(args, workspace).await.map(|data| (data, None))),
        "fs.transfer.send" => {
            Some(handle_send(args, workspace, binary_inbox.allocate_outgoing_stream_id()).await)
        }
        "fs.transfer.receive" => Some(
            handle_receive(args, request_body, workspace, binary_inbox)
                .await
                .map(|data| (data, None)),
        ),
        _ => None,
    }
}

#[derive(Deserialize)]
struct TransferStatArgs {
    path: String,
}

#[derive(Deserialize)]
struct TransferSendArgs {
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TransferReceiveArgs {
    path: String,
    #[serde(default)]
    content_type: Option<String>,
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

async fn handle_send(
    args: Value,
    workspace: &Path,
    stream_id: u32,
) -> Result<(Value, Option<OutgoingTransferBody>), String> {
    let args: TransferSendArgs =
        serde_json::from_value(args).map_err(|e| format!("Invalid arguments: {}", e))?;
    let path = resolve_path(&args.path, workspace);
    let file = tokio::fs::File::open(&path)
        .await
        .map_err(|e| format!("Failed to open '{}': {}", path.display(), e))?;
    let metadata = file
        .metadata()
        .await
        .map_err(|e| format!("Failed to stat '{}': {}", path.display(), e))?;
    if !metadata.is_file() {
        return Err(format!("Not a file: '{}'", path.display()));
    }

    let content_type = mime_guess::from_path(&path)
        .first()
        .map(|mime| mime.essence_str().to_string());
    let length = metadata.len();

    Ok((
        json!({
            "ok": true,
            "path": path.display().to_string(),
            "size": length,
            "contentType": content_type
        }),
        Some(OutgoingTransferBody {
            stream_id,
            length,
            file,
            path,
        }),
    ))
}

async fn handle_receive(
    args: Value,
    request_body: Option<FrameBodyDescriptor>,
    workspace: &Path,
    binary_inbox: &BinaryFrameInbox,
) -> Result<Value, String> {
    let args: TransferReceiveArgs =
        serde_json::from_value(args).map_err(|e| format!("Invalid arguments: {}", e))?;
    let body =
        request_body.ok_or_else(|| "fs.transfer.receive requires a request body".to_string())?;
    if body.stream_id == 0 {
        return Err("fs.transfer.receive body requires a non-zero streamId".to_string());
    }
    let expected_length = body
        .length
        .ok_or_else(|| "fs.transfer.receive requires a request body length".to_string())?;

    let path = resolve_path(&args.path, workspace);
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Failed to create '{}': {}", parent.display(), e))?;
    }
    if let Ok(metadata) = tokio::fs::metadata(&path).await {
        if metadata.is_dir() {
            return Err(format!("Destination is a directory: '{}'", path.display()));
        }
    }

    let temp_path = transfer_temp_path(&path, body.stream_id);
    let mut file = tokio::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temp_path)
        .await
        .map_err(|e| format!("Failed to open '{}': {}", temp_path.display(), e))?;

    let mut bytes_written: u64 = 0;
    let receive_result: Result<(), String> = async {
        loop {
            let frame = binary_inbox.take(body.stream_id).await?;
            if frame.flags & BINARY_FRAME_ERROR != 0 {
                return Err(String::from_utf8(frame.payload)
                    .unwrap_or_else(|_| "Binary transfer failed".to_string()));
            }
            if frame.flags & BINARY_FRAME_DATA != 0 {
                bytes_written = bytes_written
                    .checked_add(frame.payload.len() as u64)
                    .ok_or_else(|| format!("Transfer size overflow for '{}'", path.display()))?;
                if bytes_written > expected_length {
                    return Err(format!(
                        "Transfer size mismatch for '{}': expected {}, got more than {}",
                        path.display(),
                        expected_length,
                        bytes_written
                    ));
                }
                file.write_all(&frame.payload)
                    .await
                    .map_err(|e| format!("Failed to write '{}': {}", temp_path.display(), e))?;
            }
            if frame.flags & BINARY_FRAME_END != 0 {
                break;
            }
        }

        file.flush()
            .await
            .map_err(|e| format!("Failed to flush '{}': {}", temp_path.display(), e))?;
        if bytes_written != expected_length {
            return Err(format!(
                "Transfer size mismatch for '{}': expected {}, got {}",
                path.display(),
                expected_length,
                bytes_written
            ));
        }
        Ok(())
    }
    .await;

    drop(file);
    if let Err(error) = receive_result {
        binary_inbox.discard(body.stream_id);
        let _ = tokio::fs::remove_file(&temp_path).await;
        return Err(error);
    }
    if let Err(error) = tokio::fs::rename(&temp_path, &path).await {
        let _ = tokio::fs::remove_file(&temp_path).await;
        return Err(format!("Failed to replace '{}': {}", path.display(), error));
    }

    Ok(json!({
        "ok": true,
        "path": path.display().to_string(),
        "bytesWritten": bytes_written,
        "contentType": args.content_type
    }))
}

fn resolve_path(path: &str, workspace: &Path) -> PathBuf {
    let path = PathBuf::from(path);
    if path.is_absolute() {
        path
    } else {
        workspace.join(path)
    }
}

fn transfer_temp_path(path: &Path, stream_id: u32) -> PathBuf {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("transfer");
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    parent.join(format!(".{}.gsv-transfer-{}-{}", file_name, stream_id, now))
}

#[cfg(test)]
mod tests {
    use super::{
        build_binary_frame, handle_receive, handle_send, BinaryFrameInbox, FrameBodyDescriptor,
        TransferReceiveArgs, TransferSendArgs, BINARY_FRAME_DATA, BINARY_FRAME_END,
    };
    use serde_json::json;
    use std::path::PathBuf;

    fn test_workspace(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "gsv-cli-transfer-{}-{}",
            label,
            uuid::Uuid::new_v4()
        ))
    }

    #[test]
    fn transfer_args_no_longer_require_stream_fields() {
        let send: TransferSendArgs = serde_json::from_value(json!({
            "path": "source.txt"
        }))
        .unwrap();
        assert_eq!(send.path, "source.txt");

        let receive: TransferReceiveArgs = serde_json::from_value(json!({
            "path": "dest.txt",
            "contentType": "application/octet-stream"
        }))
        .unwrap();
        assert_eq!(receive.path, "dest.txt");
        assert_eq!(
            receive.content_type.as_deref(),
            Some("application/octet-stream")
        );
    }

    #[test]
    fn outgoing_stream_ids_are_monotonic_per_inbox() {
        let inbox = BinaryFrameInbox::new();

        assert_eq!(inbox.allocate_outgoing_stream_id(), 1);
        assert_eq!(inbox.allocate_outgoing_stream_id(), 2);

        let next_connection = BinaryFrameInbox::new();
        assert_eq!(next_connection.allocate_outgoing_stream_id(), 1);
    }

    #[tokio::test]
    async fn send_prepares_response_body_with_file_length() {
        let workspace = test_workspace("send");
        tokio::fs::create_dir_all(&workspace).await.unwrap();
        tokio::fs::write(workspace.join("source.bin"), [0, 1, 0xff])
            .await
            .unwrap();

        let (data, body) = handle_send(json!({ "path": "source.bin" }), &workspace, 17)
            .await
            .unwrap();
        let descriptor = body.as_ref().unwrap().descriptor();

        assert_eq!(descriptor.stream_id, 17);
        assert_eq!(descriptor.length, Some(3));
        assert_eq!(data["size"], 3);
        assert!(data.get("bytesSent").is_none());

        drop(body);
        tokio::fs::remove_dir_all(workspace).await.unwrap();
    }

    #[tokio::test]
    async fn receive_consumes_request_body_descriptor() {
        let workspace = test_workspace("receive");
        tokio::fs::create_dir_all(&workspace).await.unwrap();
        let inbox = BinaryFrameInbox::new();
        inbox.push(build_binary_frame(23, BINARY_FRAME_DATA, &[0, 0xff]));
        inbox.push(build_binary_frame(
            23,
            BINARY_FRAME_DATA | BINARY_FRAME_END,
            &[1, 2],
        ));

        let result = handle_receive(
            json!({
                "path": "nested/destination.bin",
                "contentType": "application/octet-stream"
            }),
            Some(FrameBodyDescriptor {
                stream_id: 23,
                length: Some(4),
            }),
            &workspace,
            &inbox,
        )
        .await
        .unwrap();

        assert_eq!(result["bytesWritten"], 4);
        assert_eq!(result["contentType"], "application/octet-stream");
        assert_eq!(
            tokio::fs::read(workspace.join("nested/destination.bin"))
                .await
                .unwrap(),
            vec![0, 0xff, 1, 2]
        );

        tokio::fs::remove_dir_all(workspace).await.unwrap();
    }

    #[tokio::test]
    async fn receive_rejects_body_length_mismatch_and_removes_temp_file() {
        let workspace = test_workspace("mismatch");
        tokio::fs::create_dir_all(&workspace).await.unwrap();
        let inbox = BinaryFrameInbox::new();
        inbox.push(build_binary_frame(
            29,
            BINARY_FRAME_DATA | BINARY_FRAME_END,
            &[1, 2, 3],
        ));

        let error = handle_receive(
            json!({ "path": "destination.bin" }),
            Some(FrameBodyDescriptor {
                stream_id: 29,
                length: Some(4),
            }),
            &workspace,
            &inbox,
        )
        .await
        .unwrap_err();

        assert!(error.contains("expected 4, got 3"));
        assert!(!workspace.join("destination.bin").exists());
        assert!(tokio::fs::read_dir(&workspace)
            .await
            .unwrap()
            .next_entry()
            .await
            .unwrap()
            .is_none());

        tokio::fs::remove_dir_all(workspace).await.unwrap();
    }

    #[tokio::test]
    async fn receive_requires_length_on_request_body() {
        let workspace = test_workspace("missing-length");
        let error = handle_receive(
            json!({ "path": "destination.bin" }),
            Some(FrameBodyDescriptor {
                stream_id: 31,
                length: None,
            }),
            &workspace,
            &BinaryFrameInbox::new(),
        )
        .await
        .unwrap_err();

        assert_eq!(error, "fs.transfer.receive requires a request body length");
        assert!(!workspace.exists());
    }
}
