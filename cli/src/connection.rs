use crate::build_info;
use crate::protocol::{
    AuthInfo, ClientInfo, ConnectArgs, ConnectResult, DriverInfo, ErrorShape, Frame, RequestFrame,
    ResponseFrame,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use std::collections::HashMap;
use std::error::Error as StdError;
use std::fmt::{self, Display, Formatter};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, oneshot, Mutex, RwLock};
use tokio_tungstenite::{connect_async, tungstenite::Message};

pub type PendingRequests = Arc<Mutex<HashMap<String, oneshot::Sender<ResponseFrame>>>>;
pub type FrameHandler = Arc<RwLock<Option<Box<dyn Fn(Frame) + Send + Sync>>>>;
pub type BinaryHandler = Arc<RwLock<Option<Box<dyn Fn(Vec<u8>) + Send + Sync>>>>;
pub type DisconnectFlag = Arc<AtomicBool>;

use std::sync::atomic::{AtomicBool, Ordering};

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone)]
pub struct GatewayRpcError {
    pub call: String,
    pub code: i32,
    pub message: String,
    pub details: Option<Value>,
}

impl GatewayRpcError {
    pub fn new(
        call: impl Into<String>,
        code: i32,
        message: impl Into<String>,
        details: Option<Value>,
    ) -> Self {
        Self {
            call: call.into(),
            code,
            message: message.into(),
            details,
        }
    }

    pub fn is_setup_required(&self) -> bool {
        if self.code == 425 {
            return true;
        }
        self.details
            .as_ref()
            .and_then(|d| d.get("setupMode"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
    }
}

impl Display for GatewayRpcError {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        if let Some(details) = &self.details {
            write!(
                f,
                "{} failed (code {}): {} [details: {}]",
                self.call, self.code, self.message, details
            )
        } else {
            write!(
                f,
                "{} failed (code {}): {}",
                self.call, self.code, self.message
            )
        }
    }
}

impl StdError for GatewayRpcError {}

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
            data: None,
            error: Some(ErrorShape {
                code,
                message: message.clone(),
                details: None,
                retryable: Some(true),
            }),
        });
    }
}

/// Options for connecting to the gateway.
pub struct ConnectOptions {
    pub url: String,
    pub role: String,
    pub client_id: Option<String>,
    pub implements: Option<Vec<String>>,
    pub auth_username: Option<String>,
    pub auth_password: Option<String>,
    pub auth_token: Option<String>,
}

pub struct Connection {
    tx: mpsc::Sender<Message>,
    pending: PendingRequests,
    frame_handler: FrameHandler,
    binary_handler: BinaryHandler,
    disconnected: DisconnectFlag,
    pub connect_result: Option<ConnectResult>,
}

impl Connection {
    pub async fn connect(
        opts: ConnectOptions,
        on_frame: impl Fn(Frame) + Send + 'static + Sync,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        let mut conn = Self::open_socket(&opts.url, on_frame).await?;
        conn.handshake(&opts).await?;
        Ok(conn)
    }

    pub async fn connect_without_handshake(
        url: &str,
        on_frame: impl Fn(Frame) + Send + 'static + Sync,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        Self::open_socket(url, on_frame).await
    }

    async fn open_socket(
        url: &str,
        on_frame: impl Fn(Frame) + Send + 'static + Sync,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        let (ws_stream, _) = connect_async(url).await?;
        let (mut write, mut read) = ws_stream.split();

        let (tx, mut rx) = mpsc::channel::<Message>(32);
        let tx_for_read = tx.clone();
        let pending: PendingRequests = Arc::new(Mutex::new(HashMap::new()));
        let frame_handler: FrameHandler = Arc::new(RwLock::new(Some(Box::new(on_frame))));
        let binary_handler: BinaryHandler = Arc::new(RwLock::new(None));
        let disconnected: DisconnectFlag = Arc::new(AtomicBool::new(false));

        let pending_for_write = pending.clone();
        let disconnected_for_write = disconnected.clone();

        tokio::spawn(async move {
            while let Some(msg) = rx.recv().await {
                if write.send(msg).await.is_err() {
                    disconnected_for_write.store(true, Ordering::SeqCst);
                    fail_all_pending_requests(
                        &pending_for_write,
                        503,
                        "Connection closed while sending",
                    )
                    .await;
                    break;
                }
            }
        });

        let pending_clone = pending.clone();
        let frame_handler_clone = frame_handler.clone();
        let binary_handler_clone = binary_handler.clone();
        let disconnected_clone = disconnected.clone();

        tokio::spawn(async move {
            while let Some(Ok(msg)) = read.next().await {
                match msg {
                    Message::Text(text) => {
                        if let Ok(frame) = serde_json::from_str::<Frame>(&text) {
                            match &frame {
                                Frame::Res(res) => {
                                    let mut pending = pending_clone.lock().await;
                                    if let Some(sender) = pending.remove(&res.id) {
                                        let _ = sender.send(res.clone());
                                    }
                                }
                                _ => {
                                    let handler = frame_handler_clone.read().await;
                                    if let Some(ref h) = *handler {
                                        h(frame);
                                    }
                                }
                            }
                        }
                    }
                    Message::Binary(data) => {
                        let handler = binary_handler_clone.read().await;
                        if let Some(ref h) = *handler {
                            h(data);
                        }
                    }
                    Message::Ping(payload) => {
                        let _ = tx_for_read.send(Message::Pong(payload)).await;
                    }
                    Message::Pong(_) => {}
                    _ => {}
                }
            }
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
            frame_handler,
            binary_handler,
            disconnected,
            connect_result: None,
        };
        Ok(conn)
    }

    pub async fn set_frame_handler(&self, handler: impl Fn(Frame) + Send + Sync + 'static) {
        let mut h = self.frame_handler.write().await;
        *h = Some(Box::new(handler));
    }

    pub async fn set_binary_handler(&self, handler: impl Fn(Vec<u8>) + Send + Sync + 'static) {
        let mut h = self.binary_handler.write().await;
        *h = Some(Box::new(handler));
    }

    pub async fn send_binary(&self, data: Vec<u8>) -> Result<(), Box<dyn std::error::Error>> {
        self.tx.send(Message::Binary(data)).await?;
        Ok(())
    }

    /// Send a raw JSON string as a text frame.
    pub async fn send_raw(&self, text: String) -> Result<(), Box<dyn std::error::Error>> {
        self.tx.send(Message::Text(text)).await?;
        Ok(())
    }

    pub fn is_disconnected(&self) -> bool {
        self.disconnected.load(Ordering::SeqCst)
    }

    async fn handshake(&mut self, opts: &ConnectOptions) -> Result<(), Box<dyn std::error::Error>> {
        let id = opts.client_id.clone().unwrap_or_else(|| {
            if opts.role == "driver" {
                let hostname = hostname::get()
                    .map(|h| h.to_string_lossy().to_string())
                    .unwrap_or_else(|_| "unknown".to_string());
                format!("node-{}", hostname)
            } else {
                format!("client-{}", uuid::Uuid::new_v4())
            }
        });

        let auth = if opts.auth_username.is_some() {
            Some(AuthInfo {
                username: opts.auth_username.clone().unwrap_or_default(),
                password: opts.auth_password.clone(),
                token: opts.auth_token.clone(),
            })
        } else {
            None
        };

        let driver = if opts.role == "driver" {
            Some(DriverInfo {
                implements: opts
                    .implements
                    .clone()
                    .unwrap_or_else(|| vec!["fs.*".to_string(), "shell.*".to_string()]),
            })
        } else {
            None
        };

        let connect_args = ConnectArgs {
            protocol: 1,
            client: ClientInfo {
                id,
                version: build_info::BUILD_VERSION.to_string(),
                platform: std::env::consts::OS.to_string(),
                role: opts.role.clone(),
                channel: None,
            },
            driver,
            auth,
        };

        let res = self
            .request_with_timeout(
                "sys.connect",
                Some(serde_json::to_value(connect_args)?),
                HANDSHAKE_TIMEOUT,
            )
            .await?;

        if !res.ok {
            let rpc_error = if let Some(error) = res.error {
                GatewayRpcError::new("sys.connect", error.code, error.message, error.details)
            } else {
                GatewayRpcError::new("sys.connect", 500, "Unknown handshake failure", None)
            };
            return Err(Box::new(rpc_error));
        }

        if let Some(ref data) = res.data {
            self.connect_result = serde_json::from_value(data.clone()).ok();
        }

        Ok(())
    }

    pub async fn request_with_timeout(
        &self,
        call: &str,
        args: Option<Value>,
        timeout: Duration,
    ) -> Result<ResponseFrame, Box<dyn std::error::Error>> {
        if self.is_disconnected() {
            return Err("Connection is disconnected".into());
        }

        let req = RequestFrame::new(call, args);
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
                Err(format!("Request timed out after {:?}: {}", timeout, call).into())
            }
        }
    }

    pub async fn request(
        &self,
        call: &str,
        args: Option<Value>,
    ) -> Result<ResponseFrame, Box<dyn std::error::Error>> {
        if self.is_disconnected() {
            return Err("Connection is disconnected".into());
        }

        let req = RequestFrame::new(call, args);
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
