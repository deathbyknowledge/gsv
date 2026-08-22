use crate::file_revision::file_revision;
use crate::tools::{ToolBody, ToolOutput};
use gateway_client::IncomingBody;
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::io::AsyncWriteExt;

pub enum TransferDispatch {
    Handled(Result<ToolOutput, String>),
    NotHandled(Option<IncomingBody>),
}

pub async fn handle_transfer_syscall(
    call: &str,
    args: Value,
    request_body: Option<IncomingBody>,
    workspace: &Path,
) -> TransferDispatch {
    match call {
        "fs.transfer.stat" => {
            if let Err(error) = reject_body(call, request_body) {
                return TransferDispatch::Handled(Err(error));
            }
            TransferDispatch::Handled(handle_stat(args, workspace).await)
        }
        "fs.transfer.send" => {
            if let Err(error) = reject_body(call, request_body) {
                return TransferDispatch::Handled(Err(error));
            }
            TransferDispatch::Handled(handle_send(args, workspace).await)
        }
        "fs.transfer.receive" => {
            TransferDispatch::Handled(handle_receive(args, request_body, workspace).await)
        }
        _ => TransferDispatch::NotHandled(request_body),
    }
}

fn reject_body(call: &str, body: Option<IncomingBody>) -> Result<(), String> {
    match body {
        Some(mut body) => {
            body.cancel("Request body not accepted");
            Err(format!("{call} does not accept a request body"))
        }
        None => Ok(()),
    }
}

#[derive(Deserialize)]
struct TransferStatArgs {
    path: String,
}

#[derive(Deserialize)]
struct TransferSendArgs {
    path: String,
    #[serde(default)]
    revision: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TransferReceiveArgs {
    path: String,
    #[serde(default)]
    content_type: Option<String>,
}

async fn handle_stat(args: Value, workspace: &Path) -> Result<ToolOutput, String> {
    let args: TransferStatArgs =
        serde_json::from_value(args).map_err(|error| format!("Invalid arguments: {error}"))?;
    let path = resolve_path(&args.path, workspace);
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|error| format!("Failed to stat '{}': {error}", path.display()))?;
    let content_type = metadata.is_file().then(|| {
        mime_guess::from_path(&path)
            .first()
            .map(|mime| mime.essence_str().to_string())
    });

    Ok(ToolOutput::json(json!({
        "ok": true,
        "path": path.display().to_string(),
        "size": metadata.len(),
        "isFile": metadata.is_file(),
        "isDirectory": metadata.is_dir(),
        "contentType": content_type.flatten(),
        "revision": metadata.is_file().then(|| file_revision(&metadata)),
    })))
}

async fn handle_send(args: Value, workspace: &Path) -> Result<ToolOutput, String> {
    let args: TransferSendArgs =
        serde_json::from_value(args).map_err(|error| format!("Invalid arguments: {error}"))?;
    let path = resolve_path(&args.path, workspace);
    let file = tokio::fs::File::open(&path)
        .await
        .map_err(|error| format!("Failed to open '{}': {error}", path.display()))?;
    let metadata = file
        .metadata()
        .await
        .map_err(|error| format!("Failed to stat '{}': {error}", path.display()))?;
    if !metadata.is_file() {
        return Err(format!("Not a file: '{}'", path.display()));
    }
    let revision = file_revision(&metadata);
    if args
        .revision
        .as_ref()
        .is_some_and(|expected| expected != &revision)
    {
        return Err(format!(
            "Source revision is no longer available: '{}'",
            path.display()
        ));
    }

    let content_type = mime_guess::from_path(&path)
        .first()
        .map(|mime| mime.essence_str().to_string());
    let length = metadata.len();
    let source = path.display().to_string();
    Ok(ToolOutput::with_body(
        json!({
            "ok": true,
            "path": source,
            "size": length,
            "contentType": content_type,
            "revision": revision
        }),
        ToolBody::reader(file, Some(length), Some(length), source),
    ))
}

async fn handle_receive(
    args: Value,
    request_body: Option<IncomingBody>,
    workspace: &Path,
) -> Result<ToolOutput, String> {
    let mut body =
        request_body.ok_or_else(|| "fs.transfer.receive requires a request body".to_string())?;
    let stream_id = body.stream_id();
    let expected_length = body
        .length()
        .ok_or_else(|| "fs.transfer.receive requires a request body length".to_string())?;
    let args: TransferReceiveArgs =
        serde_json::from_value(args).map_err(|error| format!("Invalid arguments: {error}"))?;

    let path = resolve_path(&args.path, workspace);
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| format!("Failed to create '{}': {error}", parent.display()))?;
    }
    if tokio::fs::metadata(&path)
        .await
        .is_ok_and(|metadata| metadata.is_dir())
    {
        return Err(format!("Destination is a directory: '{}'", path.display()));
    }

    let temp_path = transfer_temp_path(&path, stream_id);
    let _temp_file = TempFileGuard(temp_path.clone());
    let mut file = tokio::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temp_path)
        .await
        .map_err(|error| format!("Failed to open '{}': {error}", temp_path.display()))?;

    let mut bytes_written = 0_u64;
    while let Some(chunk) = body
        .recv()
        .await
        .map_err(|error| format!("Failed to receive '{}': {error}", path.display()))?
    {
        bytes_written = bytes_written
            .checked_add(chunk.len() as u64)
            .ok_or_else(|| format!("Transfer size overflow for '{}'", path.display()))?;
        file.write_all(&chunk)
            .await
            .map_err(|error| format!("Failed to write '{}': {error}", temp_path.display()))?;
    }
    file.flush()
        .await
        .map_err(|error| format!("Failed to flush '{}': {error}", temp_path.display()))?;
    drop(file);

    if bytes_written != expected_length {
        return Err(format!(
            "Transfer size mismatch for '{}': expected {expected_length}, got {bytes_written}",
            path.display()
        ));
    }
    tokio::fs::rename(&temp_path, &path)
        .await
        .map_err(|error| format!("Failed to replace '{}': {error}", path.display()))?;

    Ok(ToolOutput::json(json!({
        "ok": true,
        "path": path.display().to_string(),
        "bytesWritten": bytes_written,
        "contentType": args.content_type
    })))
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
    parent.join(format!(".{file_name}.gsv-transfer-{stream_id}-{now}"))
}

struct TempFileGuard(PathBuf);

impl Drop for TempFileGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gateway_client::protocol::{
        build_binary_frame, FrameBodyDescriptor, BINARY_FRAME_DATA, BINARY_FRAME_END,
    };
    use gateway_client::{BinaryBodyChannel, BinaryBodyLimits, BodyError};
    use std::sync::{Arc, Mutex};

    fn test_workspace(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("gsvd-transfer-{label}-{}", uuid::Uuid::new_v4()))
    }

    fn body_channel() -> BinaryBodyChannel {
        BinaryBodyChannel::new(BinaryBodyLimits::default(), |_frame| async { Ok(()) })
            .expect("body channel")
    }

    #[test]
    fn transfer_args_do_not_embed_stream_fields() {
        let send: TransferSendArgs =
            serde_json::from_value(json!({ "path": "source.txt" })).unwrap();
        assert_eq!(send.path, "source.txt");
        let receive: TransferReceiveArgs = serde_json::from_value(json!({
            "path": "dest.txt",
            "contentType": "application/octet-stream"
        }))
        .unwrap();
        assert_eq!(
            receive.content_type.as_deref(),
            Some("application/octet-stream")
        );
    }

    #[tokio::test]
    async fn send_returns_a_declared_file_body() {
        let workspace = test_workspace("send");
        tokio::fs::create_dir_all(&workspace).await.unwrap();
        tokio::fs::write(workspace.join("source.bin"), [0, 1, 0xff])
            .await
            .unwrap();

        let output = handle_send(json!({ "path": "source.bin" }), &workspace)
            .await
            .unwrap();
        let body = output.body.unwrap();
        assert_eq!(body.length, Some(3));
        assert_eq!(body.max_length, Some(3));
        assert_eq!(output.data["size"], 3);
        assert!(output.data["revision"].is_string());

        let error = handle_send(
            json!({ "path": "source.bin", "revision": "stale" }),
            &workspace,
        )
        .await
        .unwrap_err();
        assert!(error.contains("Source revision is no longer available"));

        tokio::fs::remove_dir_all(workspace).await.unwrap();
    }

    #[tokio::test]
    async fn receive_streams_to_an_atomic_temp_file() {
        let workspace = test_workspace("receive");
        tokio::fs::create_dir_all(&workspace).await.unwrap();
        let channel = body_channel();
        let descriptor = FrameBodyDescriptor {
            stream_id: 23,
            length: Some(4),
        };
        let body = channel.receive(descriptor).unwrap();
        channel.handle_frame(&build_binary_frame(23, BINARY_FRAME_DATA, &[0, 0xff]));
        channel.handle_frame(&build_binary_frame(
            23,
            BINARY_FRAME_DATA | BINARY_FRAME_END,
            &[1, 2],
        ));

        let output = handle_receive(
            json!({
                "path": "nested/destination.bin",
                "contentType": "application/octet-stream"
            }),
            Some(body),
            &workspace,
        )
        .await
        .unwrap();
        assert_eq!(output.data["bytesWritten"], 4);
        assert_eq!(
            tokio::fs::read(workspace.join("nested/destination.bin"))
                .await
                .unwrap(),
            vec![0, 0xff, 1, 2]
        );

        tokio::fs::remove_dir_all(workspace).await.unwrap();
    }

    #[tokio::test]
    async fn cancelled_receive_removes_its_temp_file() {
        let workspace = test_workspace("cancelled");
        tokio::fs::create_dir_all(&workspace).await.unwrap();
        let channel = body_channel();
        let body = channel
            .receive(FrameBodyDescriptor {
                stream_id: 30,
                length: Some(1),
            })
            .unwrap();
        let receive_workspace = workspace.clone();
        let receive = tokio::spawn(async move {
            handle_receive(
                json!({ "path": "destination.bin" }),
                Some(body),
                &receive_workspace,
            )
            .await
        });
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
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

    #[test]
    fn shared_body_channel_cancels_rejected_bodies() {
        let sent = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&sent);
        let channel = BinaryBodyChannel::new(BinaryBodyLimits::default(), move |frame| {
            let recorded = Arc::clone(&recorded);
            async move {
                recorded.lock().unwrap().push(frame);
                Ok::<_, BodyError>(())
            }
        })
        .unwrap();
        let body = channel
            .receive(FrameBodyDescriptor {
                stream_id: 41,
                length: Some(1),
            })
            .unwrap();
        assert!(reject_body("fs.transfer.stat", Some(body)).is_err());
    }
}
