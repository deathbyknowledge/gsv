use crate::protocol::{
    AuthParams, ClientInfo, ConnectParams, Frame, NodeRuntimeInfo, RequestFrame, ResponseFrame,
    ToolDefinition,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{mpsc, oneshot, Mutex, RwLock};
use tokio_tungstenite::{connect_async, tungstenite::Message};

pub type PendingRequests = Arc<Mutex<HashMap<String, oneshot::Sender<ResponseFrame>>>>;
pub type EventHandler = Arc<RwLock<Option<Box<dyn Fn(Frame) + Send + Sync>>>>;
pub type DisconnectFlag = Arc<AtomicBool>;

use std::sync::atomic::{AtomicBool, Ordering};

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

        let pending_clone = pending.clone();
        let event_handler_clone = event_handler.clone();
        let disconnected_clone = disconnected.clone();

        tokio::spawn(async move {
            while let Some(msg) = rx.recv().await {
                if write.send(msg).await.is_err() {
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
            .request("connect", Some(serde_json::to_value(params)?))
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

    pub async fn request(
        &self,
        method: &str,
        params: Option<Value>,
    ) -> Result<ResponseFrame, Box<dyn std::error::Error>> {
        let req = RequestFrame::new(method, params);
        let id = req.id.clone();

        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self.pending.lock().await;
            pending.insert(id, tx);
        }

        let frame = Frame::Req(req);
        let msg = Message::Text(serde_json::to_string(&frame)?);
        self.tx.send(msg).await?;

        let res = rx.await?;
        Ok(res)
    }
}
