use crate::build_info;
use crate::protocol::{
    AuthInfo, ClientInfo, ConnectArgs, ConnectResult, DriverInfo, ErrorShape, Frame, RequestFrame,
    ResponseFrame, PROTOCOL_VERSION,
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
const ACCOUNT_USERNAME_MAX_CHARACTERS: usize = 32;
const ACCOUNT_USERNAME_INPUT_MAX_CHARACTERS: usize = 64;

pub fn canonicalize_gateway_username(value: &str) -> Result<String, String> {
    if value.chars().count() > ACCOUNT_USERNAME_INPUT_MAX_CHARACTERS {
        return Err("Username must match ^[a-z_][a-z0-9_-]{0,31}$".to_string());
    }

    let username = value.trim();
    if username.chars().count() > ACCOUNT_USERNAME_MAX_CHARACTERS {
        return Err("Username must match ^[a-z_][a-z0-9_-]{0,31}$".to_string());
    }
    let mut chars = username.chars();
    let valid_start = chars
        .next()
        .map(|character| character.is_ascii_alphabetic() || character == '_')
        .unwrap_or(false);
    let valid_rest = chars.all(|character| {
        character.is_ascii_alphabetic()
            || character.is_ascii_digit()
            || character == '_'
            || character == '-'
    });
    if !valid_start || !valid_rest {
        return Err("Username must match ^[a-z_][a-z0-9_-]{0,31}$".to_string());
    }
    Ok(username.to_ascii_lowercase())
}

fn user_websocket_url(gateway_url: &str, username: &str) -> Result<String, String> {
    let mut url =
        url::Url::parse(gateway_url).map_err(|error| format!("Invalid gateway URL: {error}"))?;
    if !matches!(url.scheme(), "ws" | "wss") {
        return Err("Gateway URL must use ws:// or wss://".to_string());
    }
    url.set_path(&format!("/ws/{username}"));
    Ok(url.into())
}

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
            body: None,
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
        mut opts: ConnectOptions,
        on_frame: impl Fn(Frame) + Send + 'static + Sync,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        let socket_url = if let Some(raw_username) = opts.auth_username.as_deref() {
            let username = canonicalize_gateway_username(raw_username)?;
            let socket_url = user_websocket_url(&opts.url, &username)?;
            opts.auth_username = Some(username);
            socket_url
        } else {
            opts.url.clone()
        };
        let mut conn = Self::open_socket(&socket_url, on_frame).await?;
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

    pub async fn send_ping(&self, payload: Vec<u8>) -> Result<(), Box<dyn std::error::Error>> {
        self.tx.send(Message::Ping(payload)).await?;
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
                format!("device-{}", hostname)
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
            protocol: PROTOCOL_VERSION,
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

        self.connect_result = Some(parse_connect_result(res.data)?);

        Ok(())
    }

    pub async fn request_with_timeout(
        &self,
        call: &str,
        args: Option<Value>,
        timeout: Duration,
    ) -> Result<ResponseFrame, Box<dyn std::error::Error>> {
        let (id, rx) = self.send_request_frame(call, args).await?;

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
        let (_id, rx) = self.send_request_frame(call, args).await?;
        let res = rx
            .await
            .map_err(|error| format!("Connection closed while waiting for response: {}", error))?;
        Ok(res)
    }

    async fn send_request_frame(
        &self,
        call: &str,
        args: Option<Value>,
    ) -> Result<(String, oneshot::Receiver<ResponseFrame>), Box<dyn std::error::Error>> {
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

        Ok((id, rx))
    }
}

fn parse_connect_result(data: Option<Value>) -> Result<ConnectResult, String> {
    let result: ConnectResult =
        serde_json::from_value(data.ok_or_else(|| "sys.connect returned no data".to_string())?)
            .map_err(|error| format!("Invalid sys.connect response: {}", error))?;
    if result.protocol != PROTOCOL_VERSION {
        return Err(format!(
            "Gateway selected protocol {}, expected {}",
            result.protocol, PROTOCOL_VERSION
        ));
    }
    Ok(result)
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

    #[test]
    fn connect_result_requires_protocol_2() {
        let data = serde_json::json!({
            "protocol": 1,
            "server": { "version": "test", "connectionId": "conn-1" },
            "identity": {},
            "syscalls": [],
            "signals": []
        });

        let error = parse_connect_result(Some(data)).unwrap_err();
        assert_eq!(error, "Gateway selected protocol 1, expected 2");
    }

    #[test]
    fn builds_canonical_user_websocket_routes() {
        let username = canonicalize_gateway_username(" Alice ").unwrap();
        assert_eq!(username, "alice");
        assert_eq!(
            user_websocket_url("wss://gsv.example/ws?source=cli", &username).unwrap(),
            "wss://gsv.example/ws/alice?source=cli",
        );
    }

    #[test]
    fn rejects_unsafe_routing_usernames() {
        assert!(canonicalize_gateway_username("../singleton").is_err());
        assert!(canonicalize_gateway_username("a".repeat(33).as_str()).is_err());
        assert!(canonicalize_gateway_username("K").is_err());
        assert!(canonicalize_gateway_username("Ａlice").is_err());
    }

    #[test]
    fn bounds_raw_username_input_after_allowing_canonical_whitespace() {
        let canonical = format!("A{}", "B".repeat(31));
        let padded = format!("{}{}{}", " ".repeat(16), canonical, " ".repeat(16));
        assert_eq!(
            canonicalize_gateway_username(&padded).unwrap(),
            canonical.to_ascii_lowercase(),
        );

        let oversized = format!("{}{}{}", " ".repeat(17), canonical, " ".repeat(16));
        assert!(canonicalize_gateway_username(&oversized).is_err());
    }
}
