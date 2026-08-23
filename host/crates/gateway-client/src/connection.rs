use crate::body::{BinaryBody, BinaryBodyChannel, BinaryBodyLimits, BodyError, RpcResponse};
use crate::protocol::{
    AuthInfo, ConnectArgs, ConnectResult, ErrorShape, Frame, PeerInfo, RequestFrame, ResponseFrame,
    SignalFrame, PROTOCOL_VERSION, REQUEST_CANCEL_SIGNAL,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use std::collections::HashMap;
use std::error::Error as StdError;
use std::fmt::{self, Display, Formatter};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{mpsc, oneshot, RwLock};
use tokio_tungstenite::{connect_async, tungstenite::Message};

type PendingRequests = Arc<Mutex<HashMap<String, PendingRequestEntry>>>;
pub type FrameHandler = Arc<RwLock<Option<Box<dyn Fn(Frame) + Send + Sync>>>>;
pub type DisconnectFlag = Arc<AtomicBool>;

struct PendingRequestEntry {
    sender: oneshot::Sender<DeliveredResponse>,
}

struct DeliveredResponse {
    frame: ResponseFrame,
    body: Result<Option<crate::body::IncomingBody>, BodyError>,
}

struct PendingResponse {
    id: String,
    receiver: oneshot::Receiver<DeliveredResponse>,
    pending: PendingRequests,
    tx: mpsc::Sender<Message>,
    complete: bool,
}

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);
impl PendingResponse {
    fn complete(&mut self) {
        self.complete = true;
    }
}

impl Drop for PendingResponse {
    fn drop(&mut self) {
        if self.complete {
            return;
        }

        let removed = self
            .pending
            .lock()
            .ok()
            .and_then(|mut pending| pending.remove(&self.id))
            .is_some();
        if removed {
            if let Ok(frame) = serde_json::to_string(&Frame::Sig(SignalFrame {
                signal: REQUEST_CANCEL_SIGNAL.to_string(),
                payload: Some(serde_json::json!({
                    "id": self.id,
                    "reason": "Request future was cancelled",
                })),
                seq: None,
            })) {
                send_detached(&self.tx, Message::Text(frame));
            }
        }
    }
}

fn send_detached(tx: &mpsc::Sender<Message>, message: Message) {
    // Cancellation is advisory and must never create an unowned task behind a
    // saturated transport. A closed/full writer is already fenced by local
    // request removal and connection/body ownership.
    let _ = tx.try_send(message);
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

fn fail_all_pending_requests(pending: &PendingRequests, code: i32, message: &str) {
    let Ok(mut pending) = pending.lock() else {
        return;
    };
    if pending.is_empty() {
        return;
    }

    let message = message.to_string();
    for (id, entry) in pending.drain() {
        let _ = entry.sender.send(DeliveredResponse {
            frame: ResponseFrame {
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
            },
            body: Ok(None),
        });
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerIdentity {
    pub id: String,
    pub version: String,
    pub platform: String,
}

impl PeerIdentity {
    pub fn new(id: impl Into<String>, version: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            version: version.into(),
            platform: std::env::consts::OS.to_string(),
        }
    }

    pub fn with_platform(mut self, platform: impl Into<String>) -> Self {
        self.platform = platform.into();
        self
    }
}

/// Application-owned connection metadata. Transport code never invents an
/// application version or identity.
#[derive(Debug, Clone)]
pub struct ConnectionOptions {
    pub url: String,
    pub peer: PeerIdentity,
    pub implements: Vec<String>,
    pub auth_username: Option<String>,
    pub auth_password: Option<String>,
    pub auth_token: Option<String>,
    pub limits: crate::body::BinaryBodyLimits,
}

pub struct Connection {
    tx: mpsc::Sender<Message>,
    pending: PendingRequests,
    frame_handler: FrameHandler,
    body_channel: BinaryBodyChannel,
    disconnected: DisconnectFlag,
    shutdown: tokio_util::sync::CancellationToken,
    pub connect_result: Option<ConnectResult>,
}

impl Connection {
    pub async fn connect_with_options(
        opts: ConnectionOptions,
        on_frame: impl Fn(Frame) + Send + 'static + Sync,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        let mut conn =
            Self::open_socket_with_limits(&opts.url, opts.limits.clone(), on_frame).await?;
        conn.handshake_with_options(&opts).await?;
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
        Self::open_socket_with_limits(url, BinaryBodyLimits::default(), on_frame).await
    }

    async fn open_socket_with_limits(
        url: &str,
        limits: BinaryBodyLimits,
        on_frame: impl Fn(Frame) + Send + 'static + Sync,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        let (ws_stream, _) = connect_async(url).await?;
        let (mut write, mut read) = ws_stream.split();

        let (tx, mut rx) = mpsc::channel::<Message>(32);
        let body_tx = tx.clone();
        let body_channel = BinaryBodyChannel::new(limits, move |frame| {
            let body_tx = body_tx.clone();
            async move {
                body_tx.send(Message::Binary(frame)).await.map_err(|error| {
                    BodyError::Transport(format!("Connection closed while sending body: {error}"))
                })
            }
        })?;
        let tx_for_read = tx.clone();
        let pending: PendingRequests = Arc::new(Mutex::new(HashMap::new()));
        let frame_handler: FrameHandler = Arc::new(RwLock::new(Some(Box::new(on_frame))));
        let disconnected: DisconnectFlag = Arc::new(AtomicBool::new(false));
        let shutdown = tokio_util::sync::CancellationToken::new();

        let pending_for_write = pending.clone();
        let disconnected_for_write = disconnected.clone();
        let shutdown_write = shutdown.clone();

        tokio::spawn(async move {
            loop {
                let message = tokio::select! {
                    _ = shutdown_write.cancelled() => break,
                    message = rx.recv() => message,
                };
                let Some(message) = message else {
                    break;
                };
                let send_result = tokio::select! {
                    _ = shutdown_write.cancelled() => break,
                    result = write.send(message) => result,
                };
                if send_result.is_err() {
                    disconnected_for_write.store(true, Ordering::SeqCst);
                    fail_all_pending_requests(
                        &pending_for_write,
                        503,
                        "Connection closed while sending",
                    );
                    break;
                }
            }
            shutdown_write.cancel();
        });

        let pending_clone = pending.clone();
        let frame_handler_clone = frame_handler.clone();
        let body_channel_clone = body_channel.clone();
        let disconnected_clone = disconnected.clone();
        let shutdown_read = shutdown.clone();

        tokio::spawn(async move {
            loop {
                let message = tokio::select! {
                    biased;
                    _ = shutdown_read.cancelled() => break,
                    message = read.next() => message,
                };
                let Some(Ok(msg)) = message else {
                    break;
                };
                if shutdown_read.is_cancelled() {
                    break;
                }
                match msg {
                    Message::Text(text) => {
                        if let Ok(frame) = serde_json::from_str::<Frame>(&text) {
                            match &frame {
                                Frame::Res(res) => {
                                    let entry = pending_clone
                                        .lock()
                                        .ok()
                                        .and_then(|mut pending| pending.remove(&res.id));
                                    match entry {
                                        Some(entry) => {
                                            let body = res
                                                .body
                                                .map(|descriptor| {
                                                    body_channel_clone.receive(descriptor)
                                                })
                                                .transpose();
                                            let _ = entry.sender.send(DeliveredResponse {
                                                frame: res.clone(),
                                                body,
                                            });
                                        }
                                        None => {
                                            if let Some(descriptor) = res.body {
                                                if let Ok(body) =
                                                    body_channel_clone.receive(descriptor)
                                                {
                                                    drop(body);
                                                }
                                            }
                                        }
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
                        let _ = body_channel_clone.handle_frame(&data);
                    }
                    Message::Ping(payload) => {
                        tokio::select! {
                            _ = shutdown_read.cancelled() => break,
                            _ = tx_for_read.send(Message::Pong(payload)) => {}
                        }
                    }
                    Message::Pong(_) => {}
                    _ => {}
                }
            }
            shutdown_read.cancel();
            disconnected_clone.store(true, Ordering::SeqCst);
            body_channel_clone.close("Connection closed while receiving a binary body");
            fail_all_pending_requests(
                &pending_clone,
                503,
                "Connection closed while waiting for response",
            );
        });

        let conn = Self {
            tx,
            pending,
            frame_handler,
            body_channel,
            disconnected,
            shutdown,
            connect_result: None,
        };
        Ok(conn)
    }

    pub async fn set_frame_handler(&self, handler: impl Fn(Frame) + Send + Sync + 'static) {
        let mut h = self.frame_handler.write().await;
        *h = Some(Box::new(handler));
    }

    pub fn body_channel(&self) -> &BinaryBodyChannel {
        &self.body_channel
    }

    /// Send a raw JSON string as a text frame.
    pub async fn send_raw(&self, text: String) -> Result<(), Box<dyn std::error::Error>> {
        if self.is_disconnected() {
            return Err("Connection is disconnected".into());
        }
        tokio::select! {
            biased;
            _ = self.shutdown.cancelled() => return Err("Connection is disconnected".into()),
            result = self.tx.send(Message::Text(text)) => result?,
        }
        Ok(())
    }

    pub async fn send_ping(&self, payload: Vec<u8>) -> Result<(), Box<dyn std::error::Error>> {
        if self.is_disconnected() {
            return Err("Connection is disconnected".into());
        }
        tokio::select! {
            biased;
            _ = self.shutdown.cancelled() => return Err("Connection is disconnected".into()),
            result = self.tx.send(Message::Ping(payload)) => result?,
        }
        Ok(())
    }

    pub fn is_disconnected(&self) -> bool {
        self.disconnected.load(Ordering::SeqCst)
    }

    /// Cancel both transport tasks and every request/body owned by this
    /// connection. This is synchronous so a reconnect owner can fence an old
    /// socket before starting the replacement.
    pub fn close(&self) {
        self.disconnected.store(true, Ordering::SeqCst);
        self.body_channel
            .close("Connection was closed by its owner");
        fail_all_pending_requests(&self.pending, 503, "Connection was closed by its owner");
        self.shutdown.cancel();
    }

    async fn handshake_with_options(
        &mut self,
        opts: &ConnectionOptions,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let auth = opts.auth_username.as_ref().map(|username| AuthInfo {
            username: username.clone(),
            password: opts.auth_password.clone(),
            token: opts.auth_token.clone(),
        });
        let connect_args = ConnectArgs {
            protocol: PROTOCOL_VERSION,
            peer: PeerInfo {
                id: opts.peer.id.clone(),
                version: opts.peer.version.clone(),
                platform: opts.peer.platform.clone(),
                implements: opts.implements.clone(),
            },
            auth,
        };
        let response = self
            .request_with_timeout(
                "sys.connect",
                Some(serde_json::to_value(connect_args)?),
                HANDSHAKE_TIMEOUT,
            )
            .await?;
        if !response.ok {
            let error = response.error.unwrap_or(ErrorShape {
                code: 500,
                message: "Unknown handshake failure".to_string(),
                details: None,
                retryable: None,
            });
            return Err(Box::new(GatewayRpcError::new(
                "sys.connect",
                error.code,
                error.message,
                error.details,
            )));
        }
        self.connect_result = Some(parse_connect_result(response.data)?);
        Ok(())
    }

    pub async fn request_with_timeout(
        &self,
        call: &str,
        args: Option<Value>,
        timeout: Duration,
    ) -> Result<ResponseFrame, Box<dyn std::error::Error>> {
        let deadline = tokio::time::Instant::now() + timeout;
        let mut request =
            tokio::time::timeout_at(deadline, self.send_request_frame(call, args, None))
                .await
                .map_err(|_| format!("Request timed out after {timeout:?}: {call}"))??;

        match tokio::time::timeout_at(deadline, &mut request.receiver).await {
            Ok(Ok(res)) => {
                request.complete();
                drop(res.body);
                Ok(res.frame)
            }
            Ok(Err(_)) => Err("Connection closed while waiting for response".into()),
            Err(_) => Err(format!("Request timed out after {:?}: {}", timeout, call).into()),
        }
    }

    pub async fn request(
        &self,
        call: &str,
        args: Option<Value>,
    ) -> Result<ResponseFrame, Box<dyn std::error::Error>> {
        let mut request = self.send_request_frame(call, args, None).await?;
        let res = (&mut request.receiver)
            .await
            .map_err(|error| format!("Connection closed while waiting for response: {}", error))?;
        request.complete();
        drop(res.body);
        Ok(res.frame)
    }

    pub async fn request_response(
        &self,
        call: &str,
        args: Option<Value>,
        timeout: Duration,
    ) -> Result<RpcResponse, Box<dyn std::error::Error>> {
        let deadline = tokio::time::Instant::now() + timeout;
        let mut request =
            tokio::time::timeout_at(deadline, self.send_request_frame(call, args, None))
                .await
                .map_err(|_| format!("Request timed out after {timeout:?}: {call}"))??;
        let delivered = tokio::time::timeout_at(deadline, &mut request.receiver)
            .await
            .map_err(|_| format!("Request timed out after {timeout:?}: {call}"))?
            .map_err(|error| format!("Connection closed while waiting for response: {error}"))?;
        request.complete();
        response_to_rpc(call, delivered)
    }

    pub async fn request_with_body(
        &self,
        call: &str,
        args: Option<Value>,
        body: BinaryBody,
        timeout: Duration,
    ) -> Result<RpcResponse, Box<dyn std::error::Error>> {
        let outgoing = self.body_channel.prepare(body)?;
        let descriptor = outgoing.descriptor();
        let deadline = tokio::time::Instant::now() + timeout;
        let mut request = tokio::time::timeout_at(
            deadline,
            self.send_request_frame(call, args, Some(descriptor)),
        )
        .await
        .map_err(|_| format!("Request timed out after {timeout:?}: {call}"))??;
        let send = outgoing.send();
        tokio::pin!(send);
        let delivered = tokio::select! {
            response = &mut request.receiver => {
                let delivered = response
                    .map_err(|error| format!("Connection closed while waiting for response: {error}"))?;
                tokio::time::timeout_at(deadline, &mut send)
                    .await
                    .map_err(|_| format!("Request body timed out after {timeout:?}: {call}"))??;
                delivered
            }
            send_result = &mut send => {
                send_result?;
                tokio::time::timeout_at(deadline, &mut request.receiver)
                    .await
                    .map_err(|_| format!("Request timed out after {timeout:?}: {call}"))?
                    .map_err(|error| format!("Connection closed while waiting for response: {error}"))?
            }
            _ = tokio::time::sleep_until(deadline) => {
                return Err(format!("Request timed out after {timeout:?}: {call}").into());
            }
        };
        request.complete();
        response_to_rpc(call, delivered)
    }

    async fn send_request_frame(
        &self,
        call: &str,
        args: Option<Value>,
        body: Option<crate::protocol::FrameBodyDescriptor>,
    ) -> Result<PendingResponse, Box<dyn std::error::Error>> {
        if self.is_disconnected() {
            return Err("Connection is disconnected".into());
        }

        let mut req = RequestFrame::new(call, args);
        req.body = body;
        let id = req.id.clone();

        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self
                .pending
                .lock()
                .map_err(|error| format!("Pending request registry is unavailable: {error}"))?;
            // `close` publishes disconnected before taking this same lock to
            // drain requests. This recheck makes registration linearizable:
            // the request is either present for that drain or rejected here.
            if self.is_disconnected() {
                return Err("Connection is disconnected".into());
            }
            pending.insert(id.clone(), PendingRequestEntry { sender: tx });
        }

        let mut pending_response = PendingResponse {
            id,
            receiver: rx,
            pending: self.pending.clone(),
            tx: self.tx.clone(),
            complete: false,
        };

        let frame = Frame::Req(req);
        let msg = Message::Text(serde_json::to_string(&frame)?);
        let send_result: Result<(), Box<dyn std::error::Error>> = tokio::select! {
            biased;
            _ = self.shutdown.cancelled() => Err("Connection is disconnected".into()),
            result = self.tx.send(msg) => result.map_err(|error| error.into()),
        };
        if let Err(error) = send_result {
            pending_response.complete();
            if let Ok(mut pending) = self.pending.lock() {
                pending.remove(&pending_response.id);
            }
            return Err(error);
        }

        Ok(pending_response)
    }
}

impl Drop for Connection {
    fn drop(&mut self) {
        self.close();
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

fn response_to_rpc(
    call: &str,
    delivered: DeliveredResponse,
) -> Result<RpcResponse, Box<dyn std::error::Error>> {
    if !delivered.frame.ok {
        drop(delivered.body);
        let error = delivered.frame.error.unwrap_or(ErrorShape {
            code: 500,
            message: "Unknown RPC failure".to_string(),
            details: None,
            retryable: None,
        });
        return Err(Box::new(GatewayRpcError::new(
            call,
            error.code,
            error.message,
            error.details,
        )));
    }
    Ok(RpcResponse {
        data: delivered
            .frame
            .data
            .unwrap_or_else(|| serde_json::json!({})),
        body: delivered.body?,
    })
}

#[cfg(test)]
#[allow(clippy::panic)]
mod tests {
    use super::*;
    use crate::protocol::{parse_binary_frame, BINARY_FRAME_END, BINARY_FRAME_ERROR};

    fn test_connection(
        limits: BinaryBodyLimits,
    ) -> (Connection, mpsc::Receiver<Message>, PendingRequests) {
        let (wire_tx, wire_rx) = mpsc::channel(16);
        let pending: PendingRequests = Arc::new(Mutex::new(HashMap::new()));
        let body_channel = BinaryBodyChannel::new(limits, {
            let wire_tx = wire_tx.clone();
            move |frame| {
                let wire_tx = wire_tx.clone();
                async move {
                    wire_tx
                        .send(Message::Binary(frame))
                        .await
                        .map_err(|error| BodyError::Transport(error.to_string()))
                }
            }
        })
        .expect("body channel");
        (
            Connection {
                tx: wire_tx,
                pending: pending.clone(),
                frame_handler: Arc::new(RwLock::new(None)),
                body_channel,
                disconnected: Arc::new(AtomicBool::new(false)),
                shutdown: tokio_util::sync::CancellationToken::new(),
                connect_result: None,
            },
            wire_rx,
            pending,
        )
    }

    fn request_body_stream_id(message: Message) -> u32 {
        let Message::Text(message) = message else {
            panic!("expected text request frame");
        };
        let frame: Frame = serde_json::from_str(&message).expect("valid request frame");
        let Frame::Req(request) = frame else {
            panic!("expected request frame");
        };
        request.body.expect("request body descriptor").stream_id
    }

    async fn expect_body_error_end(wire_rx: &mut mpsc::Receiver<Message>, stream_id: u32) {
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let message = wire_rx.recv().await.expect("wire frame");
                let Message::Binary(data) = message else {
                    continue;
                };
                let (received_stream_id, flags, _) =
                    parse_binary_frame(&data).expect("valid binary frame");
                if received_stream_id == stream_id {
                    assert_eq!(flags, BINARY_FRAME_ERROR | BINARY_FRAME_END);
                    return;
                }
            }
        })
        .await
        .expect("terminal body frame");
    }

    #[tokio::test]
    async fn fail_all_pending_requests_resolves_waiters() {
        let pending: PendingRequests = Arc::new(Mutex::new(HashMap::new()));
        let (tx, rx) = oneshot::channel();
        pending
            .lock()
            .expect("pending mutex")
            .insert("req-1".to_string(), PendingRequestEntry { sender: tx });

        fail_all_pending_requests(&pending, 503, "Connection closed");

        let response = rx.await.expect("response should be delivered");
        assert!(!response.frame.ok);
        assert_eq!(response.frame.id, "req-1");

        let error = response
            .frame
            .error
            .expect("error details should be present");
        assert_eq!(error.code, 503);
        assert_eq!(error.message, "Connection closed");
        assert!(pending.lock().expect("pending mutex").is_empty());
    }

    #[tokio::test]
    async fn owner_close_fences_transport_and_resolves_pending_requests() {
        let (connection, _wire, pending) = test_connection(BinaryBodyLimits::default());
        let (response_tx, response_rx) = oneshot::channel();
        pending.lock().expect("pending mutex").insert(
            "req-close".to_string(),
            PendingRequestEntry {
                sender: response_tx,
            },
        );

        connection.close();

        assert!(connection.is_disconnected());
        assert!(connection.shutdown.is_cancelled());
        assert!(pending.lock().expect("pending mutex").is_empty());
        let response = response_rx.await.expect("close should resolve request");
        assert!(!response.frame.ok);
        assert_eq!(response.frame.id, "req-close");
        assert_eq!(
            response.frame.error.expect("close error").message,
            "Connection was closed by its owner"
        );
    }

    #[tokio::test]
    async fn dropping_a_pending_request_removes_it_and_sends_request_cancel() {
        let pending: PendingRequests = Arc::new(Mutex::new(HashMap::new()));
        let (response_tx, response_rx) = oneshot::channel();
        pending.lock().expect("pending mutex").insert(
            "req-cancel".to_string(),
            PendingRequestEntry {
                sender: response_tx,
            },
        );
        let (wire_tx, mut wire_rx) = mpsc::channel(2);
        let request = PendingResponse {
            id: "req-cancel".to_string(),
            receiver: response_rx,
            pending: pending.clone(),
            tx: wire_tx.clone(),
            complete: false,
        };

        drop(request);

        assert!(pending.lock().expect("pending mutex").is_empty());
        let message = wire_rx.recv().await.expect("request.cancel frame");
        let Message::Text(message) = message else {
            panic!("expected text cancellation frame");
        };
        assert_eq!(
            serde_json::from_str::<Value>(&message).expect("valid cancellation frame"),
            serde_json::json!({
                "type": "sig",
                "signal": "request.cancel",
                "payload": {
                    "id": "req-cancel",
                    "reason": "Request future was cancelled",
                },
            })
        );
    }

    #[tokio::test]
    async fn request_timeout_cancels_the_registered_request() {
        let (wire_tx, mut wire_rx) = mpsc::channel(4);
        let pending: PendingRequests = Arc::new(Mutex::new(HashMap::new()));
        let connection = Connection {
            tx: wire_tx.clone(),
            pending: pending.clone(),
            frame_handler: Arc::new(RwLock::new(None)),
            body_channel: BinaryBodyChannel::new(BinaryBodyLimits::default(), {
                let wire_tx = wire_tx.clone();
                move |frame| {
                    let wire_tx = wire_tx.clone();
                    async move {
                        wire_tx
                            .send(Message::Binary(frame))
                            .await
                            .map_err(|error| BodyError::Transport(error.to_string()))
                    }
                }
            })
            .expect("body channel"),
            disconnected: Arc::new(AtomicBool::new(false)),
            shutdown: tokio_util::sync::CancellationToken::new(),
            connect_result: None,
        };

        let result = connection
            .request_with_timeout("test.slow", None, Duration::from_millis(1))
            .await;
        let Err(error) = result else {
            panic!("request should time out");
        };
        assert!(error.to_string().contains("timed out"));
        assert!(pending.lock().expect("pending mutex").is_empty());

        let request = wire_rx.recv().await.expect("request frame");
        assert!(matches!(request, Message::Text(_)));
        let cancellation = wire_rx.recv().await.expect("request.cancel frame");
        let Message::Text(cancellation) = cancellation else {
            panic!("expected text cancellation frame");
        };
        let frame: Frame = serde_json::from_str(&cancellation).expect("valid cancellation frame");
        assert!(matches!(
            frame,
            Frame::Sig(SignalFrame { ref signal, .. }) if signal == REQUEST_CANCEL_SIGNAL
        ));
    }

    #[tokio::test]
    async fn request_timeout_includes_a_backpressured_frame_enqueue() {
        let (wire_tx, _wire_rx) = mpsc::channel(1);
        wire_tx
            .send(Message::Text("occupied".to_string()))
            .await
            .expect("fill wire queue");
        let pending: PendingRequests = Arc::new(Mutex::new(HashMap::new()));
        let connection = Connection {
            tx: wire_tx.clone(),
            pending: pending.clone(),
            frame_handler: Arc::new(RwLock::new(None)),
            body_channel: BinaryBodyChannel::new(BinaryBodyLimits::default(), move |_| async {
                Ok(())
            })
            .expect("body channel"),
            disconnected: Arc::new(AtomicBool::new(false)),
            shutdown: tokio_util::sync::CancellationToken::new(),
            connect_result: None,
        };

        let result = connection
            .request_with_timeout("test.backpressure", None, Duration::from_millis(5))
            .await;

        let error = result.expect_err("full transport queue must respect request deadline");
        assert!(error.to_string().contains("timed out"));
        assert!(pending.lock().expect("pending mutex").is_empty());
        assert_eq!(wire_tx.capacity(), 0, "no detached cancellation was queued");
    }

    #[tokio::test]
    async fn dropping_request_with_body_terminates_outgoing_ownership() {
        let limits = BinaryBodyLimits {
            max_active_streams: 1,
            ..BinaryBodyLimits::default()
        };
        let (connection, mut wire_rx, pending) = test_connection(limits);
        let (_writer, reader) = tokio::io::duplex(1);

        let stream_id = {
            let request = connection.request_with_body(
                "test.upload",
                None,
                BinaryBody::from_reader(reader, None),
                Duration::from_secs(5),
            );
            tokio::pin!(request);
            let request_frame = tokio::select! {
                message = wire_rx.recv() => message.expect("request frame"),
                _ = &mut request => panic!("request completed before cancellation"),
            };
            request_body_stream_id(request_frame)
        };

        assert!(pending.lock().expect("pending mutex").is_empty());
        let replacement = connection
            .body_channel()
            .prepare(BinaryBody::from_bytes(Vec::new()))
            .expect("cancelled body released its stream slot");
        expect_body_error_end(&mut wire_rx, stream_id).await;
        drop(replacement);
    }

    #[tokio::test]
    async fn request_with_body_timeout_terminates_outgoing_ownership() {
        let limits = BinaryBodyLimits {
            max_active_streams: 1,
            ..BinaryBodyLimits::default()
        };
        let (connection, mut wire_rx, pending) = test_connection(limits);
        let (_writer, reader) = tokio::io::duplex(1);

        let result = connection
            .request_with_body(
                "test.upload",
                None,
                BinaryBody::from_reader(reader, None),
                Duration::from_millis(5),
            )
            .await;

        let Err(error) = result else {
            panic!("request should time out");
        };
        assert!(error.to_string().contains("timed out"));
        assert!(pending.lock().expect("pending mutex").is_empty());
        let stream_id = request_body_stream_id(wire_rx.recv().await.expect("request frame"));
        let replacement = connection
            .body_channel()
            .prepare(BinaryBody::from_bytes(Vec::new()))
            .expect("timed out body released its stream slot");
        expect_body_error_end(&mut wire_rx, stream_id).await;
        drop(replacement);
    }

    #[test]
    fn connect_result_requires_protocol_3() {
        let data = serde_json::json!({
            "protocol": 1,
            "server": { "version": "test", "connectionId": "conn-1" },
            "peer": {
                "id": "test-peer",
                "sessionId": "conn-1",
                "principal": {
                    "kind": "human",
                    "account": {
                        "uid": 1000,
                        "gid": 1000,
                        "gids": [1000],
                        "username": "test",
                        "home": "/home/test",
                        "cwd": "/home/test"
                    }
                },
                "grant": { "calls": [], "signals": [], "implements": [] }
            }
        });

        let error = parse_connect_result(Some(data)).expect_err("protocol 1 must be rejected");
        assert_eq!(error, "Gateway selected protocol 1, expected 3");
    }
}
