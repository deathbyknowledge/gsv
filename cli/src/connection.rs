use crate::protocol::{
    AuthParams, ClientInfo, ConnectParams, ErrorShape, Frame, NodeRuntimeInfo, RequestFrame,
    ResponseFrame, ToolDefinition,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, oneshot, Mutex, RwLock};
use tokio_tungstenite::{connect_async, tungstenite::Message};

pub type PendingRequests = Arc<Mutex<HashMap<String, oneshot::Sender<ResponseFrame>>>>;
pub type EventHandler = Arc<RwLock<Option<Box<dyn Fn(Frame) + Send + Sync>>>>;
pub type DisconnectFlag = Arc<AtomicBool>;

use std::sync::atomic::{AtomicBool, Ordering};

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);

async fn fail_all_pending_requests(pending: &PendingRequests, code: i32, message: &str) {
    let mut pending = pending.lock().await;
    if pending.is_empty() {
        return;
    }

    let message = message.to_string();
    for (id, sender) in pending.drain() {
        let _ = sender.send(ResponseFrame {
            id,
            ok: false,
            payload: None,
            error: Some(ErrorShape {
                code,
                message: message.clone(),
                details: None,
                retryable: Some(true),
            }),
        });
    }
}

pub struct Connection {
    tx: mpsc::Sender<Message>,
    pending: PendingRequests,
    event_handler: EventHandler,
    disconnected: DisconnectFlag,
}

impl Connection {
    pub async fn connect_with_options(
        url: &str,
        mode: &str,
        tools: Option<Vec<ToolDefinition>>,
        node_runtime: Option<NodeRuntimeInfo>,
        on_event: impl Fn(Frame) + Send + 'static + Sync,
        client_id: Option<String>,
        token: Option<String>,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        let (ws_stream, _) = connect_async(url).await?;
        let (mut write, mut read) = ws_stream.split();

        let (tx, mut rx) = mpsc::channel::<Message>(32);
        let pending: PendingRequests = Arc::new(Mutex::new(HashMap::new()));
        let event_handler: EventHandler = Arc::new(RwLock::new(Some(Box::new(on_event))));
        let disconnected: DisconnectFlag = Arc::new(AtomicBool::new(false));

        let pending_for_write = pending.clone();
        let disconnected_for_write = disconnected.clone();
        let pending_clone = pending.clone();
        let event_handler_clone = event_handler.clone();
        let disconnected_clone = disconnected.clone();

        tokio::spawn(async move {
            while let Some(msg) = rx.recv().await {
                if write.send(msg).await.is_err() {
                    disconnected_for_write.store(true, Ordering::SeqCst);
                    fail_all_pending_requests(
                        &pending_for_write,
                        503,
                        "Connection closed while sending request",
                    )
                    .await;
                    break;
                }
            }
        });

        tokio::spawn(async move {
            while let Some(Ok(msg)) = read.next().await {
                if let Message::Text(text) = msg {
                    if let Ok(frame) = serde_json::from_str::<Frame>(&text) {
                        match &frame {
                            Frame::Res(res) => {
                                let mut pending = pending_clone.lock().await;
                                if let Some(sender) = pending.remove(&res.id) {
                                    let _ = sender.send(res.clone());
                                }
                            }
                            _ => {
                                let handler = event_handler_clone.read().await;
                                if let Some(ref h) = *handler {
                                    h(frame);
                                }
                            }
                        }
                    }
                }
            }
            // Read loop ended - connection is dead
            disconnected_clone.store(true, Ordering::SeqCst);
            fail_all_pending_requests(
                &pending_clone,
                503,
                "Connection closed while waiting for response",
            )
            .await;
        });

        let conn = Self {
            tx,
            pending,
            event_handler,
            disconnected,
        };
        conn.handshake(mode, tools, node_runtime, client_id, token)
            .await?;
        Ok(conn)
    }

    pub async fn set_event_handler(&self, handler: impl Fn(Frame) + Send + Sync + 'static) {
        let mut h = self.event_handler.write().await;
        *h = Some(Box::new(handler));
    }

    pub fn is_disconnected(&self) -> bool {
        self.disconnected.load(Ordering::SeqCst)
    }

    async fn handshake(
        &self,
        mode: &str,
        tools: Option<Vec<ToolDefinition>>,
        node_runtime: Option<NodeRuntimeInfo>,
        client_id: Option<String>,
        token: Option<String>,
    ) -> Result<(), Box<dyn std::error::Error>> {
        // Use provided ID, or generate based on mode:
        // - nodes: use hostname (stable across reconnects)
        // - clients: use random UUID (ephemeral)
        let id = client_id.unwrap_or_else(|| {
            if mode == "node" {
                let hostname = hostname::get()
                    .map(|h| h.to_string_lossy().to_string())
                    .unwrap_or_else(|_| "unknown".to_string());
                format!("node-{}", hostname)
            } else {
                format!("client-{}", uuid::Uuid::new_v4())
            }
        });

        let params = ConnectParams {
            min_protocol: 1,
            max_protocol: 1,
            client: ClientInfo {
                id,
                version: env!("CARGO_PKG_VERSION").to_string(),
                platform: std::env::consts::OS.to_string(),
                mode: mode.to_string(),
            },
            tools,
            node_runtime,
            session_key: None,
            auth: token.map(|t| AuthParams { token: Some(t) }),
        };

        let res = self
            .request_with_timeout(
                "connect",
                Some(serde_json::to_value(params)?),
                HANDSHAKE_TIMEOUT,
            )
            .await?;

        if !res.ok {
            return Err(format!(
                "Handshake failed: {}",
                res.error.map(|e| e.message).unwrap_or_default()
            )
            .into());
        }

        Ok(())
    }

    pub async fn request_with_timeout(
        &self,
        method: &str,
        params: Option<Value>,
        timeout: Duration,
    ) -> Result<ResponseFrame, Box<dyn std::error::Error>> {
        if self.is_disconnected() {
            return Err("Connection is disconnected".into());
        }

        let req = RequestFrame::new(method, params);
        let id = req.id.clone();

        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self.pending.lock().await;
            pending.insert(id.clone(), tx);
        }

        let frame = Frame::Req(req);
        let msg = Message::Text(serde_json::to_string(&frame)?);
        if let Err(error) = self.tx.send(msg).await {
            let mut pending = self.pending.lock().await;
            pending.remove(&id);
            return Err(error.into());
        }

        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(res)) => Ok(res),
            Ok(Err(_)) => Err("Connection closed while waiting for response".into()),
            Err(_) => {
                let mut pending = self.pending.lock().await;
                pending.remove(&id);
                Err(format!("Request timed out after {:?}: {}", timeout, method).into())
            }
        }
    }

    pub async fn request(
        &self,
        method: &str,
        params: Option<Value>,
    ) -> Result<ResponseFrame, Box<dyn std::error::Error>> {
        if self.is_disconnected() {
            return Err("Connection is disconnected".into());
        }

        let req = RequestFrame::new(method, params);
        let id = req.id.clone();

        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self.pending.lock().await;
            pending.insert(id.clone(), tx);
        }

        let frame = Frame::Req(req);
        let msg = Message::Text(serde_json::to_string(&frame)?);
        if let Err(error) = self.tx.send(msg).await {
            let mut pending = self.pending.lock().await;
            pending.remove(&id);
            return Err(error.into());
        }

        let res = rx
            .await
            .map_err(|_| "Connection closed while waiting for response")?;
        Ok(res)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn fail_all_pending_requests_resolves_waiters() {
        let pending: PendingRequests = Arc::new(Mutex::new(HashMap::new()));
        let (tx, rx) = oneshot::channel();
        pending.lock().await.insert("req-1".to_string(), tx);

        fail_all_pending_requests(&pending, 503, "Connection closed").await;

        let response = rx.await.expect("response should be delivered");
        assert!(!response.ok);
        assert_eq!(response.id, "req-1");

        let error = response.error.expect("error details should be present");
        assert_eq!(error.code, 503);
        assert_eq!(error.message, "Connection closed");
        assert!(pending.lock().await.is_empty());
    }
}
