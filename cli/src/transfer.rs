use crate::connection::Connection;
use crate::logger::NodeLogger;
use crate::protocol::{
    build_transfer_binary_frame, parse_transfer_binary_frame, TransferAcceptParams,
    TransferCompleteParams, TransferDoneParams, TransferMetaParams, TransferReceivePayload,
    TransferSendPayload,
};
use serde_json::json;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot};

const TRANSFER_CHUNK_SIZE: usize = 256 * 1024;

pub struct TransferCoordinator {
    start_signals: std::sync::Mutex<HashMap<u32, oneshot::Sender<()>>>,
    chunk_senders: std::sync::Mutex<HashMap<u32, mpsc::UnboundedSender<Vec<u8>>>>,
}

impl TransferCoordinator {
    pub fn new() -> Self {
        Self {
            start_signals: std::sync::Mutex::new(HashMap::new()),
            chunk_senders: std::sync::Mutex::new(HashMap::new()),
        }
    }

    pub fn register_start_signal(&self, transfer_id: u32) -> oneshot::Receiver<()> {
        let (tx, rx) = oneshot::channel();
        self.start_signals.lock().unwrap().insert(transfer_id, tx);
        rx
    }

    pub fn fire_start_signal(&self, transfer_id: u32) {
        if let Some(tx) = self.start_signals.lock().unwrap().remove(&transfer_id) {
            let _ = tx.send(());
        }
    }

    pub fn register_chunk_receiver(&self, transfer_id: u32) -> mpsc::UnboundedReceiver<Vec<u8>> {
        let (tx, rx) = mpsc::unbounded_channel();
        self.chunk_senders.lock().unwrap().insert(transfer_id, tx);
        rx
    }

    pub fn close_chunk_sender(&self, transfer_id: u32) {
        self.chunk_senders.lock().unwrap().remove(&transfer_id);
    }

    pub fn cleanup(&self, transfer_id: u32) {
        self.start_signals.lock().unwrap().remove(&transfer_id);
        self.chunk_senders.lock().unwrap().remove(&transfer_id);
    }

    pub fn route_binary_frame(&self, data: &[u8]) {
        if let Some((transfer_id, chunk)) = parse_transfer_binary_frame(data) {
            let senders = self.chunk_senders.lock().unwrap();
            if let Some(tx) = senders.get(&transfer_id) {
                let _ = tx.send(chunk.to_vec());
            }
        }
    }
}

fn resolve_transfer_path(path: &str, workspace: &Path) -> PathBuf {
    let p = PathBuf::from(path);
    if p.is_absolute() {
        p
    } else {
        workspace.join(p)
    }
}

pub async fn handle_transfer_send(
    conn: Arc<Connection>,
    payload: TransferSendPayload,
    workspace: PathBuf,
    coordinator: Arc<TransferCoordinator>,
    logger: NodeLogger,
) {
    let transfer_id = payload.transfer_id;
    let resolved_path = resolve_transfer_path(&payload.path, &workspace);

    logger.info(
        "transfer.send.start",
        json!({
            "transferId": transfer_id,
            "path": resolved_path.display().to_string(),
        }),
    );

    let metadata = match tokio::fs::metadata(&resolved_path).await {
        Ok(m) => m,
        Err(e) => {
            logger.error(
                "transfer.send.file_error",
                json!({
                    "transferId": transfer_id,
                    "path": resolved_path.display().to_string(),
                    "error": e.to_string(),
                }),
            );
            let params = TransferMetaParams {
                transfer_id,
                size: 0,
                mime: None,
                error: Some(format!(
                    "Failed to read file {}: {}",
                    resolved_path.display(),
                    e
                )),
            };
            let _ = conn
                .request(
                    "transfer.meta",
                    Some(serde_json::to_value(&params).unwrap()),
                )
                .await;
            coordinator.cleanup(transfer_id);
            return;
        }
    };

    let size = metadata.len();
    let mime = detect_mime(&resolved_path).await;

    logger.info(
        "transfer.send.meta",
        json!({
            "transferId": transfer_id,
            "size": size,
            "mime": mime,
        }),
    );

    let params = TransferMetaParams {
        transfer_id,
        size,
        mime,
        error: None,
    };
    if let Err(e) = conn
        .request(
            "transfer.meta",
            Some(serde_json::to_value(&params).unwrap()),
        )
        .await
    {
        logger.error(
            "transfer.send.meta_rpc_failed",
            json!({
                "transferId": transfer_id,
                "error": e.to_string(),
            }),
        );
        coordinator.cleanup(transfer_id);
        return;
    }

    logger.info(
        "transfer.send.waiting_for_start",
        json!({ "transferId": transfer_id }),
    );

    let start_rx = coordinator.register_start_signal(transfer_id);
    if start_rx.await.is_err() {
        logger.error(
            "transfer.send.start_signal_dropped",
            json!({ "transferId": transfer_id }),
        );
        coordinator.cleanup(transfer_id);
        return;
    }

    logger.info(
        "transfer.send.streaming",
        json!({ "transferId": transfer_id }),
    );

    let mut file = match tokio::fs::File::open(&resolved_path).await {
        Ok(f) => f,
        Err(e) => {
            logger.error(
                "transfer.send.open_failed",
                json!({
                    "transferId": transfer_id,
                    "error": e.to_string(),
                }),
            );
            coordinator.cleanup(transfer_id);
            return;
        }
    };

    let mut buf = vec![0u8; TRANSFER_CHUNK_SIZE];
    let mut total_sent: u64 = 0;
    loop {
        let bytes_read = match file.read(&mut buf).await {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) => {
                logger.error(
                    "transfer.send.read_error",
                    json!({
                        "transferId": transfer_id,
                        "bytesSent": total_sent,
                        "error": e.to_string(),
                    }),
                );
                break;
            }
        };
        let frame = build_transfer_binary_frame(transfer_id, &buf[..bytes_read]);
        if conn.send_binary(frame).await.is_err() {
            logger.error(
                "transfer.send.ws_send_failed",
                json!({
                    "transferId": transfer_id,
                    "bytesSent": total_sent,
                }),
            );
            coordinator.cleanup(transfer_id);
            return;
        }
        total_sent += bytes_read as u64;
    }

    logger.info(
        "transfer.send.complete",
        json!({
            "transferId": transfer_id,
            "bytesSent": total_sent,
        }),
    );

    let params = TransferCompleteParams { transfer_id };
    if let Err(e) = conn
        .request(
            "transfer.complete",
            Some(serde_json::to_value(&params).unwrap()),
        )
        .await
    {
        logger.error(
            "transfer.send.complete_rpc_failed",
            json!({
                "transferId": transfer_id,
                "error": e.to_string(),
            }),
        );
    }

    coordinator.cleanup(transfer_id);
}

pub async fn handle_transfer_receive(
    conn: Arc<Connection>,
    payload: TransferReceivePayload,
    workspace: PathBuf,
    coordinator: Arc<TransferCoordinator>,
    logger: NodeLogger,
) {
    let transfer_id = payload.transfer_id;
    let resolved_path = resolve_transfer_path(&payload.path, &workspace);

    logger.info(
        "transfer.receive.start",
        json!({
            "transferId": transfer_id,
            "path": resolved_path.display().to_string(),
            "size": payload.size,
            "mime": payload.mime,
        }),
    );

    if let Some(parent) = resolved_path.parent() {
        if let Err(e) = tokio::fs::create_dir_all(parent).await {
            logger.error(
                "transfer.receive.mkdir_failed",
                json!({
                    "transferId": transfer_id,
                    "dir": parent.display().to_string(),
                    "error": e.to_string(),
                }),
            );
            let params = TransferAcceptParams {
                transfer_id,
                error: Some(format!(
                    "Failed to create directory {}: {}",
                    parent.display(),
                    e
                )),
            };
            let _ = conn
                .request(
                    "transfer.accept",
                    Some(serde_json::to_value(&params).unwrap()),
                )
                .await;
            coordinator.cleanup(transfer_id);
            return;
        }
    }

    let mut file = match tokio::fs::File::create(&resolved_path).await {
        Ok(f) => f,
        Err(e) => {
            logger.error(
                "transfer.receive.create_failed",
                json!({
                    "transferId": transfer_id,
                    "path": resolved_path.display().to_string(),
                    "error": e.to_string(),
                }),
            );
            let params = TransferAcceptParams {
                transfer_id,
                error: Some(format!(
                    "Failed to create file {}: {}",
                    resolved_path.display(),
                    e
                )),
            };
            let _ = conn
                .request(
                    "transfer.accept",
                    Some(serde_json::to_value(&params).unwrap()),
                )
                .await;
            coordinator.cleanup(transfer_id);
            return;
        }
    };

    let mut chunk_rx = coordinator.register_chunk_receiver(transfer_id);

    let params = TransferAcceptParams {
        transfer_id,
        error: None,
    };
    if let Err(e) = conn
        .request(
            "transfer.accept",
            Some(serde_json::to_value(&params).unwrap()),
        )
        .await
    {
        logger.error(
            "transfer.receive.accept_rpc_failed",
            json!({
                "transferId": transfer_id,
                "error": e.to_string(),
            }),
        );
        coordinator.cleanup(transfer_id);
        return;
    }

    logger.info(
        "transfer.receive.accepted",
        json!({ "transferId": transfer_id }),
    );

    let mut bytes_written: u64 = 0;
    let mut write_error: Option<String> = None;

    while let Some(data) = chunk_rx.recv().await {
        match file.write_all(&data).await {
            Ok(_) => {
                bytes_written += data.len() as u64;
            }
            Err(e) => {
                logger.error(
                    "transfer.receive.write_error",
                    json!({
                        "transferId": transfer_id,
                        "bytesWritten": bytes_written,
                        "error": e.to_string(),
                    }),
                );
                write_error = Some(format!("Write error: {}", e));
                break;
            }
        }
    }

    let _ = file.flush().await;

    logger.info(
        "transfer.receive.done",
        json!({
            "transferId": transfer_id,
            "bytesWritten": bytes_written,
            "error": write_error,
        }),
    );

    let params = TransferDoneParams {
        transfer_id,
        bytes_written,
        error: write_error,
    };
    if let Err(e) = conn
        .request(
            "transfer.done",
            Some(serde_json::to_value(&params).unwrap()),
        )
        .await
    {
        logger.error(
            "transfer.receive.done_rpc_failed",
            json!({
                "transferId": transfer_id,
                "error": e.to_string(),
            }),
        );
    }

    coordinator.cleanup(transfer_id);
}

async fn detect_mime(path: &Path) -> Option<String> {
    let mut file = tokio::fs::File::open(path).await.ok()?;
    let mut buf = vec![0u8; 8192];
    let bytes_read = file.read(&mut buf).await.ok()?;
    infer::get(&buf[..bytes_read]).map(|kind| kind.mime_type().to_string())
}
