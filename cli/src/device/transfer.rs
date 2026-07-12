use gsv::connection::Connection;
use gsv::protocol::{
    build_binary_frame, parse_binary_frame, FrameBodyDescriptor, BINARY_FRAME_CANCEL,
    BINARY_FRAME_DATA, BINARY_FRAME_END, BINARY_FRAME_ERROR,
};
use gsv::tools::ToolBody;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fmt::Display;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::sync::{watch, Notify};

const MAX_TRANSFER_CHUNK_BYTES: usize = 1024 * 1024;
const MAX_BUFFERED_BINARY_BYTES: usize = 32 * 1024 * 1024;
const MAX_BUFFERED_BINARY_FRAMES: usize = 1024;
const BINARY_TRANSFER_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone)]
pub struct BinaryFrameInbox {
    state: Arc<Mutex<BinaryInboxState>>,
    notify: Arc<Notify>,
    next_outgoing_stream_id: Arc<AtomicU32>,
    send_frame: Option<Arc<dyn Fn(Vec<u8>) + Send + Sync>>,
}

#[derive(Default)]
struct BinaryInboxState {
    frames: HashMap<u32, VecDeque<QueuedBinaryFrame>>,
    active: HashSet<u32>,
    outgoing: HashMap<u32, watch::Sender<bool>>,
    buffered_bytes: usize,
    buffered_frames: usize,
}

#[derive(Clone)]
struct QueuedBinaryFrame {
    flags: u8,
    payload: Vec<u8>,
}

impl BinaryFrameInbox {
    pub fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(BinaryInboxState::default())),
            notify: Arc::new(Notify::new()),
            next_outgoing_stream_id: Arc::new(AtomicU32::new(1)),
            send_frame: None,
        }
    }

    pub fn with_sender(send_frame: impl Fn(Vec<u8>) + Send + Sync + 'static) -> Self {
        Self {
            send_frame: Some(Arc::new(send_frame)),
            ..Self::new()
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

    fn register_outgoing(&self) -> (u32, watch::Receiver<bool>) {
        let stream_id = self.allocate_outgoing_stream_id();
        let (sender, receiver) = watch::channel(false);
        self.lock_state().outgoing.insert(stream_id, sender);
        (stream_id, receiver)
    }

    fn lock_state(&self) -> std::sync::MutexGuard<'_, BinaryInboxState> {
        self.state
            .lock()
            .expect("binary frame inbox mutex poisoned")
    }

    pub fn register(&self, body: Option<FrameBodyDescriptor>) {
        if let Some(body) = body.filter(|body| body.stream_id != 0) {
            self.lock_state().active.insert(body.stream_id);
        }
    }

    pub fn push(&self, data: Vec<u8>) {
        let Some((stream_id, flags, payload)) = parse_binary_frame(&data) else {
            return;
        };
        if stream_id == 0 {
            return;
        }
        if flags & BINARY_FRAME_CANCEL != 0 {
            if let Some(sender) = self.lock_state().outgoing.remove(&stream_id) {
                let _ = sender.send(true);
            }
            return;
        }
        {
            let mut state = self.lock_state();
            if !state.active.contains(&stream_id) {
                return;
            }
            if state.buffered_bytes.saturating_add(payload.len()) > MAX_BUFFERED_BINARY_BYTES
                || state.buffered_frames >= MAX_BUFFERED_BINARY_FRAMES
            {
                if let Some(queued) = state.frames.remove(&stream_id) {
                    state.buffered_bytes = state
                        .buffered_bytes
                        .saturating_sub(queued.iter().map(|frame| frame.payload.len()).sum());
                    state.buffered_frames = state.buffered_frames.saturating_sub(queued.len());
                }
                state.active.remove(&stream_id);
                self.send_cancel(stream_id, "Binary transfer buffer limit exceeded");
                if state.buffered_frames >= MAX_BUFFERED_BINARY_FRAMES {
                    return;
                }
                let payload = b"Binary transfer buffer limit exceeded".to_vec();
                state.buffered_bytes += payload.len();
                state.buffered_frames += 1;
                state
                    .frames
                    .entry(stream_id)
                    .or_default()
                    .push_back(QueuedBinaryFrame {
                        flags: BINARY_FRAME_ERROR | BINARY_FRAME_END,
                        payload,
                    });
                self.notify.notify_waiters();
                return;
            }
            state.buffered_bytes += payload.len();
            state.buffered_frames += 1;
            state
                .frames
                .entry(stream_id)
                .or_default()
                .push_back(QueuedBinaryFrame { flags, payload });
            if flags & BINARY_FRAME_END != 0 {
                state.active.remove(&stream_id);
            }
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
                .map_err(|_elapsed| {
                    format!("Timed out waiting for binary transfer stream {}", stream_id)
                })?;
        }
    }

    pub(super) async fn read_body(
        &self,
        body: FrameBodyDescriptor,
        max_bytes: usize,
    ) -> Result<Vec<u8>, String> {
        if body.stream_id == 0 {
            return Err("Request body requires a non-zero streamId".to_string());
        }
        let mut guard = IncomingStreamGuard::new(self, body.stream_id);
        let expected_length = body.length;
        if expected_length.is_some_and(|length| length > max_bytes as u64) {
            return Err(format!(
                "Request body exceeds limit (max {} bytes)",
                max_bytes
            ));
        }

        let mut bytes = Vec::with_capacity(expected_length.unwrap_or(0) as usize);
        loop {
            let frame = self.take(body.stream_id).await?;
            if frame.flags & BINARY_FRAME_ERROR != 0 {
                self.discard(body.stream_id);
                guard.complete();
                return Err(String::from_utf8(frame.payload)
                    .unwrap_or_else(|_| "Binary transfer failed".to_string()));
            }
            if frame.flags & BINARY_FRAME_DATA != 0 {
                let next_len = bytes.len() + frame.payload.len();
                if next_len > max_bytes {
                    return Err(format!(
                        "Request body exceeds limit (max {} bytes)",
                        max_bytes
                    ));
                }
                if let Some(length) = expected_length.filter(|length| next_len as u64 > *length) {
                    return Err(format!("Request body exceeded declared length {}", length));
                }
                bytes.extend_from_slice(&frame.payload);
            }
            if frame.flags & BINARY_FRAME_END != 0 {
                break;
            }
        }

        if let Some(length) = expected_length.filter(|length| bytes.len() as u64 != *length) {
            return Err(format!(
                "Request body length {} did not match declared length {}",
                bytes.len(),
                length
            ));
        }
        guard.complete();
        Ok(bytes)
    }

    fn pop(&self, stream_id: u32) -> Option<QueuedBinaryFrame> {
        let mut state = self.lock_state();
        let queue = state.frames.get_mut(&stream_id)?;
        let frame = queue.pop_front();
        if queue.is_empty() {
            state.frames.remove(&stream_id);
        }
        if let Some(frame) = &frame {
            state.buffered_bytes = state.buffered_bytes.saturating_sub(frame.payload.len());
            state.buffered_frames = state.buffered_frames.saturating_sub(1);
        }
        frame
    }

    pub(super) fn discard(&self, stream_id: u32) -> bool {
        let mut state = self.lock_state();
        let queued = state.frames.remove(&stream_id);
        if let Some(queued) = &queued {
            state.buffered_bytes = state
                .buffered_bytes
                .saturating_sub(queued.iter().map(|frame| frame.payload.len()).sum());
            state.buffered_frames = state.buffered_frames.saturating_sub(queued.len());
        }
        state.active.remove(&stream_id) || queued.is_some()
    }

    pub(super) fn cancel_incoming(&self, stream_id: u32, reason: &str) {
        if self.discard(stream_id) {
            self.send_cancel(stream_id, reason);
        }
    }

    fn send_cancel(&self, stream_id: u32, reason: &str) {
        if stream_id == 0 {
            return;
        }
        if let Some(send_frame) = &self.send_frame {
            send_frame(build_binary_frame(
                stream_id,
                BINARY_FRAME_CANCEL | BINARY_FRAME_END,
                reason.as_bytes(),
            ));
        }
    }

    fn send_error(&self, stream_id: u32, reason: &str) {
        if stream_id == 0 {
            return;
        }
        if let Some(send_frame) = &self.send_frame {
            send_frame(build_binary_frame(
                stream_id,
                BINARY_FRAME_ERROR | BINARY_FRAME_END,
                reason.as_bytes(),
            ));
        }
    }

    fn unregister_outgoing(&self, stream_id: u32) {
        self.lock_state().outgoing.remove(&stream_id);
    }
}

struct IncomingStreamGuard<'a> {
    inbox: &'a BinaryFrameInbox,
    stream_id: u32,
    complete: bool,
}

impl<'a> IncomingStreamGuard<'a> {
    fn new(inbox: &'a BinaryFrameInbox, stream_id: u32) -> Self {
        Self {
            inbox,
            stream_id,
            complete: false,
        }
    }

    fn complete(&mut self) {
        self.complete = true;
    }
}

impl Drop for IncomingStreamGuard<'_> {
    fn drop(&mut self) {
        if !self.complete {
            self.inbox
                .cancel_incoming(self.stream_id, "Binary body cancelled");
        }
    }
}

pub(super) struct OutgoingBody {
    inbox: BinaryFrameInbox,
    stream_id: u32,
    length: Option<u64>,
    max_length: Option<u64>,
    deadline: Option<tokio::time::Instant>,
    reader: Box<dyn AsyncRead + Send + Unpin>,
    source: String,
    cancellation: watch::Receiver<bool>,
    finished: bool,
}

impl OutgoingBody {
    fn new(
        binary_inbox: &BinaryFrameInbox,
        length: Option<u64>,
        max_length: Option<u64>,
        reader: impl AsyncRead + Send + Unpin + 'static,
        source: String,
    ) -> Self {
        let (stream_id, cancellation) = binary_inbox.register_outgoing();
        Self {
            inbox: binary_inbox.clone(),
            stream_id,
            length,
            max_length,
            deadline: None,
            reader: Box::new(reader),
            source,
            cancellation,
            finished: false,
        }
    }

    pub(super) fn tool_body(binary_inbox: &BinaryFrameInbox, body: ToolBody) -> Self {
        let (stream_id, cancellation) = binary_inbox.register_outgoing();
        Self {
            inbox: binary_inbox.clone(),
            stream_id,
            length: body.length,
            max_length: body.max_length,
            deadline: body.deadline,
            reader: body.reader,
            source: body.source,
            cancellation,
            finished: false,
        }
    }

    pub(super) fn descriptor(&self) -> FrameBodyDescriptor {
        FrameBodyDescriptor {
            stream_id: self.stream_id,
            length: self.length,
        }
    }

    pub(super) async fn send(mut self, conn: &Connection) -> Result<(), String> {
        let stream_id = self.stream_id;
        let result = self.send_frames(|frame| conn.send_binary(frame)).await;
        if let Err(error) = &result {
            let frame = build_binary_frame(
                stream_id,
                BINARY_FRAME_ERROR | BINARY_FRAME_END,
                error.as_bytes(),
            );
            tokio::select! {
                biased;
                _ = wait_for_cancel(&mut self.cancellation) => {}
                _ = conn.send_binary(frame) => {}
            }
        }
        self.finished = true;
        result
    }

    async fn send_frames<F, Fut, E>(&mut self, send_frame: F) -> Result<(), String>
    where
        F: FnMut(Vec<u8>) -> Fut,
        Fut: Future<Output = Result<(), E>>,
        E: Display,
    {
        let source = self.source.clone();
        match self.deadline {
            Some(deadline) => tokio::time::timeout_at(deadline, self.send_inner(send_frame))
                .await
                .unwrap_or_else(|_| Err(format!("Timed out sending '{}'", source))),
            None => self.send_inner(send_frame).await,
        }
    }

    async fn send_inner<F, Fut, E>(&mut self, mut send_frame: F) -> Result<(), String>
    where
        F: FnMut(Vec<u8>) -> Fut,
        Fut: Future<Output = Result<(), E>>,
        E: Display,
    {
        let mut bytes_sent = 0u64;
        let mut buffer = vec![0u8; MAX_TRANSFER_CHUNK_BYTES];

        loop {
            let bytes_read = tokio::select! {
                biased;
                _ = wait_for_cancel(&mut self.cancellation) => return Ok(()),
                result = self.reader.read(&mut buffer) => result
                    .map_err(|e| format!("Failed to read '{}': {}", self.source, e))?,
            };
            if bytes_read == 0 {
                break;
            }

            let next_bytes_sent = bytes_sent
                .checked_add(bytes_read as u64)
                .ok_or_else(|| format!("Transfer size overflow for '{}'", self.source))?;
            if let Some(max_length) = self
                .max_length
                .filter(|max_length| next_bytes_sent > *max_length)
            {
                return Err(format!(
                    "Body from '{}' exceeds limit ({} bytes, max {})",
                    self.source, next_bytes_sent, max_length
                ));
            }
            if let Some(length) = self.length.filter(|length| next_bytes_sent > *length) {
                return Err(format!(
                    "Transfer size changed for '{}': expected {}, got more than {}",
                    self.source, length, next_bytes_sent
                ));
            }

            let frame =
                build_binary_frame(self.stream_id, BINARY_FRAME_DATA, &buffer[..bytes_read]);
            tokio::select! {
                biased;
                _ = wait_for_cancel(&mut self.cancellation) => return Ok(()),
                result = send_frame(frame) => result
                    .map_err(|e| format!("Failed to send binary transfer data: {}", e))?,
            }
            bytes_sent = next_bytes_sent;
        }

        if *self.cancellation.borrow() {
            return Ok(());
        }
        if let Some(length) = self.length.filter(|length| bytes_sent != *length) {
            return Err(format!(
                "Transfer size changed for '{}': expected {}, got {}",
                self.source, length, bytes_sent
            ));
        }

        let frame = build_binary_frame(self.stream_id, BINARY_FRAME_END, &[]);
        tokio::select! {
            biased;
            _ = wait_for_cancel(&mut self.cancellation) => {}
            result = send_frame(frame) => result
                .map_err(|e| format!("Failed to finish binary transfer: {}", e))?,
        }
        Ok(())
    }
}

impl Drop for OutgoingBody {
    fn drop(&mut self) {
        self.inbox.unregister_outgoing(self.stream_id);
        if !self.finished {
            self.inbox.send_error(self.stream_id, "Request cancelled");
        }
    }
}

async fn wait_for_cancel(cancellation: &mut watch::Receiver<bool>) {
    if !*cancellation.borrow() {
        let _ = cancellation.changed().await;
    }
}

pub async fn handle_transfer_syscall(
    call: &str,
    args: Value,
    request_body: Option<FrameBodyDescriptor>,
    workspace: &Path,
    binary_inbox: &BinaryFrameInbox,
) -> Option<Result<(Value, Option<OutgoingBody>), String>> {
    if matches!(call, "fs.transfer.stat" | "fs.transfer.send") {
        if let Some(body) = request_body {
            binary_inbox.cancel_incoming(body.stream_id, "Request body not accepted");
            return Some(Err(format!("{} does not accept a request body", call)));
        }
    }

    match call {
        "fs.transfer.stat" => Some(handle_stat(args, workspace).await.map(|data| (data, None))),
        "fs.transfer.send" => Some(handle_send(args, workspace, binary_inbox).await),
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
    binary_inbox: &BinaryFrameInbox,
) -> Result<(Value, Option<OutgoingBody>), String> {
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
        Some(OutgoingBody::new(
            binary_inbox,
            Some(length),
            None,
            file,
            path.display().to_string(),
        )),
    ))
}

async fn handle_receive(
    args: Value,
    request_body: Option<FrameBodyDescriptor>,
    workspace: &Path,
    binary_inbox: &BinaryFrameInbox,
) -> Result<Value, String> {
    let body =
        request_body.ok_or_else(|| "fs.transfer.receive requires a request body".to_string())?;
    if body.stream_id == 0 {
        return Err("fs.transfer.receive body requires a non-zero streamId".to_string());
    }
    let mut stream_guard = IncomingStreamGuard::new(binary_inbox, body.stream_id);
    let expected_length = body
        .length
        .ok_or_else(|| "fs.transfer.receive requires a request body length".to_string())?;
    let args: TransferReceiveArgs =
        serde_json::from_value(args).map_err(|e| format!("Invalid arguments: {}", e))?;

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
    let _temp_file = TempFileGuard(temp_path.clone());
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
                binary_inbox.discard(body.stream_id);
                stream_guard.complete();
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
    receive_result?;
    if let Err(error) = tokio::fs::rename(&temp_path, &path).await {
        return Err(format!("Failed to replace '{}': {}", path.display(), error));
    }
    stream_guard.complete();

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

struct TempFileGuard(PathBuf);

impl Drop for TempFileGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

#[cfg(test)]
mod tests {
    use super::{
        build_binary_frame, handle_receive, handle_send, parse_binary_frame, BinaryFrameInbox,
        FrameBodyDescriptor, OutgoingBody, TransferReceiveArgs, TransferSendArgs,
        BINARY_FRAME_CANCEL, BINARY_FRAME_DATA, BINARY_FRAME_END, BINARY_FRAME_ERROR,
    };
    use serde_json::json;
    use std::io::Cursor;
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;
    use tokio::io::AsyncWriteExt;

    fn test_workspace(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "gsv-cli-transfer-{}-{}",
            label,
            uuid::Uuid::new_v4()
        ))
    }

    fn recording_inbox() -> (BinaryFrameInbox, Arc<Mutex<Vec<Vec<u8>>>>) {
        let frames = Arc::new(Mutex::new(Vec::new()));
        let sent = Arc::clone(&frames);
        (
            BinaryFrameInbox::with_sender(move |frame| sent.lock().unwrap().push(frame)),
            frames,
        )
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

    #[test]
    fn dropping_outgoing_body_errors_its_stream() {
        let (inbox, sent) = recording_inbox();
        let body = OutgoingBody::new(
            &inbox,
            Some(1),
            None,
            Cursor::new(vec![1]),
            "response".to_string(),
        );
        let stream_id = body.stream_id;

        drop(body);

        let sent = sent.lock().unwrap();
        let (actual_stream_id, flags, payload) = parse_binary_frame(&sent[0]).unwrap();
        assert_eq!(actual_stream_id, stream_id);
        assert_eq!(flags, BINARY_FRAME_ERROR | BINARY_FRAME_END);
        assert_eq!(payload, b"Request cancelled");
    }

    #[tokio::test]
    async fn read_body_collects_registered_frames() {
        let inbox = BinaryFrameInbox::new();
        let body = FrameBodyDescriptor {
            stream_id: 13,
            length: Some(4),
        };
        inbox.register(Some(body));
        inbox.push(build_binary_frame(13, BINARY_FRAME_DATA, &[0, 1]));
        inbox.push(build_binary_frame(
            13,
            BINARY_FRAME_DATA | BINARY_FRAME_END,
            &[2, 3],
        ));

        assert_eq!(inbox.read_body(body, 4).await.unwrap(), vec![0, 1, 2, 3]);
    }

    #[tokio::test]
    async fn read_body_cancels_sender_on_error_or_timeout() {
        let (inbox, sent) = recording_inbox();
        let body = FrameBodyDescriptor {
            stream_id: 15,
            length: Some(4),
        };
        inbox.register(Some(body));
        inbox.push(build_binary_frame(
            15,
            BINARY_FRAME_DATA | BINARY_FRAME_END,
            &[1, 2, 3],
        ));

        let error = inbox.read_body(body, 4).await.unwrap_err();

        assert_eq!(
            error,
            "Request body length 3 did not match declared length 4"
        );

        let body = FrameBodyDescriptor {
            stream_id: 16,
            length: Some(5),
        };
        inbox.register(Some(body));
        assert_eq!(
            inbox.read_body(body, 4).await.unwrap_err(),
            "Request body exceeds limit (max 4 bytes)"
        );

        assert_eq!(sent.lock().unwrap().len(), 1);

        let body = FrameBodyDescriptor {
            stream_id: 18,
            length: Some(1),
        };
        inbox.register(Some(body));
        tokio::time::timeout(Duration::from_millis(1), inbox.read_body(body, 1))
            .await
            .expect_err("read unexpectedly completed");

        let sent = sent.lock().unwrap();
        assert_eq!(sent.len(), 2);
        for frame in &*sent {
            assert_eq!(
                parse_binary_frame(frame).unwrap().1,
                BINARY_FRAME_CANCEL | BINARY_FRAME_END
            );
        }
    }

    #[tokio::test]
    async fn send_prepares_response_body_with_file_length() {
        let workspace = test_workspace("send");
        tokio::fs::create_dir_all(&workspace).await.unwrap();
        tokio::fs::write(workspace.join("source.bin"), [0, 1, 0xff])
            .await
            .unwrap();

        let inbox = BinaryFrameInbox::new();
        let (data, body) = handle_send(json!({ "path": "source.bin" }), &workspace, &inbox)
            .await
            .unwrap();
        let descriptor = body.as_ref().unwrap().descriptor();

        assert_eq!(descriptor.stream_id, 1);
        assert_eq!(descriptor.length, Some(3));
        assert_eq!(data["size"], 3);
        assert!(data.get("bytesSent").is_none());

        drop(body);
        tokio::fs::remove_dir_all(workspace).await.unwrap();
    }

    #[tokio::test]
    async fn outgoing_pump_stops_on_cancel_without_an_end_frame() {
        let inbox = BinaryFrameInbox::new();
        let (reader, mut writer) = tokio::io::duplex(1);
        writer.write_all(&[1]).await.unwrap();
        let mut body = OutgoingBody::new(&inbox, Some(2), None, reader, "test body".to_string());
        let stream_id = body.stream_id;
        let sent = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&sent);
        let data_sent = Arc::new(tokio::sync::Notify::new());
        let notify_data_sent = Arc::clone(&data_sent);

        let pump = body.send_inner(move |frame| {
            recorded.lock().unwrap().push(frame);
            notify_data_sent.notify_one();
            std::future::ready(Ok::<(), std::io::Error>(()))
        });
        let cancel = async {
            data_sent.notified().await;
            inbox.push(build_binary_frame(
                stream_id,
                BINARY_FRAME_CANCEL | BINARY_FRAME_END,
                &[],
            ));
        };

        let (result, ()) = tokio::time::timeout(Duration::from_millis(100), async {
            tokio::join!(pump, cancel)
        })
        .await
        .expect("outgoing pump did not stop");
        result.unwrap();
        let sent = sent.lock().unwrap();
        assert_eq!(sent.len(), 1);
        assert_eq!(parse_binary_frame(&sent[0]).unwrap().1, BINARY_FRAME_DATA);
    }

    #[tokio::test]
    async fn outgoing_pump_supports_unknown_lengths_and_enforces_limits() {
        let inbox = BinaryFrameInbox::new();
        let mut body = OutgoingBody::new(
            &inbox,
            None,
            Some(3),
            Cursor::new(vec![1, 2, 3]),
            "stream".to_string(),
        );
        assert_eq!(body.descriptor().length, None);
        let sent = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&sent);
        body.send_inner(move |frame| {
            recorded.lock().unwrap().push(frame);
            std::future::ready(Ok::<(), std::io::Error>(()))
        })
        .await
        .unwrap();
        assert_eq!(sent.lock().unwrap().len(), 2);

        let mut oversized = OutgoingBody::new(
            &inbox,
            None,
            Some(3),
            Cursor::new(vec![1, 2, 3, 4]),
            "stream".to_string(),
        );
        let error = oversized
            .send_inner(|_frame| std::future::ready(Ok::<(), std::io::Error>(())))
            .await
            .unwrap_err();
        assert_eq!(error, "Body from 'stream' exceeds limit (4 bytes, max 3)");

        let mut truncated = OutgoingBody::new(
            &inbox,
            Some(4),
            None,
            Cursor::new(vec![1, 2, 3]),
            "stream".to_string(),
        );
        let error = truncated
            .send_inner(|_frame| std::future::ready(Ok::<(), std::io::Error>(())))
            .await
            .unwrap_err();
        assert_eq!(
            error,
            "Transfer size changed for 'stream': expected 4, got 3"
        );
    }

    #[tokio::test]
    async fn outgoing_pump_honors_the_original_tool_deadline() {
        let inbox = BinaryFrameInbox::new();
        let (reader, _writer) = tokio::io::duplex(1);
        let mut body = OutgoingBody::new(&inbox, None, None, reader, "net.fetch".to_string());
        body.deadline = Some(tokio::time::Instant::now() + Duration::from_millis(5));

        let error = body
            .send_frames(|_frame| std::future::ready(Ok::<(), std::io::Error>(())))
            .await
            .unwrap_err();

        assert_eq!(error, "Timed out sending 'net.fetch'");
    }

    #[tokio::test]
    async fn receive_consumes_request_body_descriptor() {
        let workspace = test_workspace("receive");
        tokio::fs::create_dir_all(&workspace).await.unwrap();
        let inbox = BinaryFrameInbox::new();
        let body = FrameBodyDescriptor {
            stream_id: 23,
            length: Some(4),
        };
        inbox.register(Some(body));
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
            Some(body),
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
        let (inbox, sent) = recording_inbox();
        let body = FrameBodyDescriptor {
            stream_id: 29,
            length: Some(4),
        };
        inbox.register(Some(body));
        inbox.push(build_binary_frame(
            29,
            BINARY_FRAME_DATA | BINARY_FRAME_END,
            &[1, 2, 3],
        ));

        let error = handle_receive(
            json!({ "path": "destination.bin" }),
            Some(body),
            &workspace,
            &inbox,
        )
        .await
        .unwrap_err();

        assert!(error.contains("expected 4, got 3"));
        assert!(sent.lock().unwrap().is_empty());
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
    async fn cancelled_receive_removes_temp_file() {
        let workspace = test_workspace("cancelled");
        tokio::fs::create_dir_all(&workspace).await.unwrap();
        let inbox = BinaryFrameInbox::new();
        let body = FrameBodyDescriptor {
            stream_id: 30,
            length: Some(1),
        };
        inbox.register(Some(body));
        let receive_workspace = workspace.clone();
        let receive_inbox = inbox.clone();
        let receive = tokio::spawn(async move {
            handle_receive(
                json!({ "path": "destination.bin" }),
                Some(body),
                &receive_workspace,
                &receive_inbox,
            )
            .await
        });
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if tokio::fs::read_dir(&workspace)
                    .await
                    .unwrap()
                    .next_entry()
                    .await
                    .unwrap()
                    .is_some()
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("transfer temp file was not created");

        receive.abort();
        assert!(receive.await.unwrap_err().is_cancelled());
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

    #[test]
    fn cancelled_streams_notify_peer_and_drop_late_frames() {
        let (inbox, sent) = recording_inbox();
        inbox.register(Some(FrameBodyDescriptor {
            stream_id: 37,
            length: Some(3),
        }));
        inbox.cancel_incoming(37, "body ignored");
        inbox.cancel_incoming(37, "duplicate cancellation");

        let sent = sent.lock().unwrap();
        assert_eq!(sent.len(), 1);
        let cancel = parse_binary_frame(&sent[0]).unwrap();
        assert_eq!(cancel.0, 37);
        assert_eq!(cancel.1, BINARY_FRAME_CANCEL | BINARY_FRAME_END);
        drop(sent);

        inbox.push(build_binary_frame(37, BINARY_FRAME_DATA, &[1, 2, 3]));
        assert!(inbox.state.lock().unwrap().frames.is_empty());

        inbox.push(build_binary_frame(37, BINARY_FRAME_END, &[]));
        let state = inbox.state.lock().unwrap();
        assert!(!state.active.contains(&37));
    }
}
