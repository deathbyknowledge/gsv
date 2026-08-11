use crate::build_info;
use crate::protocol::{
    build_binary_frame, AuthInfo, ClientInfo, ConnectArgs, ConnectResult, DriverInfo, ErrorShape,
    Frame, RequestFrame, ResponseFrame, SignalFrame, BINARY_FRAME_CANCEL, BINARY_FRAME_END,
    BINARY_FRAME_HEADER_BYTES, PROTOCOL_VERSION, REQUEST_CANCEL_SIGNAL,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};
use std::error::Error as StdError;
use std::fmt::{self, Display, Formatter};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{mpsc, oneshot, RwLock};
use tokio_tungstenite::{connect_async, tungstenite::Message};

type PendingRequests = Arc<Mutex<HashMap<String, PendingRequestEntry>>>;
pub type FrameHandler = Arc<RwLock<Option<Box<dyn Fn(Frame) + Send + Sync>>>>;
pub type BinaryHandler = Arc<RwLock<Option<Box<dyn Fn(Vec<u8>) + Send + Sync>>>>;
pub type DisconnectFlag = Arc<AtomicBool>;

struct PendingRequestEntry {
    sender: oneshot::Sender<ResponseFrame>,
    state: Arc<PendingRequestState>,
}

#[derive(Default)]
struct PendingRequestState {
    response_body_stream_id: AtomicU32,
}

struct PendingResponse {
    id: String,
    receiver: oneshot::Receiver<ResponseFrame>,
    state: Arc<PendingRequestState>,
    pending: PendingRequests,
    abandoned_bodies: Arc<Mutex<AbandonedBodyStreams>>,
    tx: mpsc::Sender<Message>,
    complete: bool,
}

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_ABANDONED_BODY_STREAMS: usize = 256;

#[derive(Default)]
struct AbandonedBodyStreams {
    stream_ids: HashSet<u32>,
    insertion_order: VecDeque<u32>,
}

impl AbandonedBodyStreams {
    fn insert(&mut self, stream_id: u32) {
        if stream_id == 0 || !self.stream_ids.insert(stream_id) {
            return;
        }
        while self.insertion_order.len() >= MAX_ABANDONED_BODY_STREAMS {
            if let Some(evicted) = self.insertion_order.pop_front() {
                self.stream_ids.remove(&evicted);
            }
        }
        self.insertion_order.push_back(stream_id);
    }

    fn accept_reused(&mut self, stream_id: u32) {
        self.stream_ids.remove(&stream_id);
        self.insertion_order.retain(|queued| *queued != stream_id);
    }

    fn should_discard(&mut self, stream_id: u32, flags: u8) -> bool {
        let should_discard = self.stream_ids.contains(&stream_id);
        if should_discard && flags & BINARY_FRAME_END != 0 {
            self.stream_ids.remove(&stream_id);
            self.insertion_order.retain(|queued| *queued != stream_id);
        }
        should_discard
    }
}

fn should_discard_abandoned_frame(
    abandoned: &mut AbandonedBodyStreams,
    stream_id: u32,
    flags: u8,
) -> bool {
    flags & BINARY_FRAME_CANCEL == 0 && abandoned.should_discard(stream_id, flags)
}

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

        let stream_id = self.state.response_body_stream_id.load(Ordering::Acquire);
        if stream_id != 0 {
            if let Ok(mut abandoned) = self.abandoned_bodies.lock() {
                abandoned.insert(stream_id);
            }
            send_body_cancel(&self.tx, stream_id, "Response body was no longer needed");
        }
    }
}

fn send_detached(tx: &mpsc::Sender<Message>, message: Message) {
    match tx.try_send(message) {
        Ok(()) => {}
        Err(mpsc::error::TrySendError::Full(message)) => {
            let tx = tx.clone();
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                runtime.spawn(async move {
                    let _ = tx.send(message).await;
                });
            }
        }
        Err(mpsc::error::TrySendError::Closed(_)) => {}
    }
}

fn send_body_cancel(tx: &mpsc::Sender<Message>, stream_id: u32, reason: &str) {
    if stream_id == 0 {
        return;
    }
    send_detached(
        tx,
        Message::Binary(build_binary_frame(
            stream_id,
            BINARY_FRAME_CANCEL | BINARY_FRAME_END,
            reason.as_bytes(),
        )),
    );
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
    let Ok(mut pending) = pending.lock() else {
        return;
    };
    if pending.is_empty() {
        return;
    }

    let message = message.to_string();
    for (id, entry) in pending.drain() {
        let _ = entry.sender.send(ResponseFrame {
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
    abandoned_bodies: Arc<Mutex<AbandonedBodyStreams>>,
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
        let abandoned_bodies = Arc::new(Mutex::new(AbandonedBodyStreams::default()));
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
        let abandoned_bodies_clone = abandoned_bodies.clone();
        let disconnected_clone = disconnected.clone();

        tokio::spawn(async move {
            while let Some(Ok(msg)) = read.next().await {
                match msg {
                    Message::Text(text) => {
                        if let Ok(frame) = serde_json::from_str::<Frame>(&text) {
                            match &frame {
                                Frame::Res(res) => {
                                    let entry =
                                        pending_clone.lock().ok().and_then(|mut pending| {
                                            if let Some(entry) = pending.get(&res.id) {
                                                if let Some(body) = res.body {
                                                    entry
                                                        .state
                                                        .response_body_stream_id
                                                        .store(body.stream_id, Ordering::Release);
                                                }
                                            }
                                            pending.remove(&res.id)
                                        });
                                    if entry.is_some() {
                                        if let Some(body) = res.body {
                                            if let Ok(mut abandoned) = abandoned_bodies_clone.lock()
                                            {
                                                abandoned.accept_reused(body.stream_id);
                                            }
                                        }
                                    }
                                    let abandoned_body = match entry {
                                        Some(entry) => entry
                                            .sender
                                            .send(res.clone())
                                            .err()
                                            .and_then(|response| response.body),
                                        None => res.body,
                                    };
                                    if let Some(body) = abandoned_body {
                                        if let Ok(mut abandoned) = abandoned_bodies_clone.lock() {
                                            abandoned.insert(body.stream_id);
                                        }
                                        send_body_cancel(
                                            &tx_for_read,
                                            body.stream_id,
                                            "Response body had no receiver",
                                        );
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
                        let cancelled = if data.len() >= BINARY_FRAME_HEADER_BYTES {
                            let stream_id =
                                u32::from_le_bytes([data[0], data[1], data[2], data[3]]);
                            let flags = data[4];
                            abandoned_bodies_clone
                                .lock()
                                .ok()
                                .map(|mut abandoned| {
                                    should_discard_abandoned_frame(&mut abandoned, stream_id, flags)
                                })
                                .unwrap_or(false)
                        } else {
                            false
                        };
                        if cancelled {
                            continue;
                        }
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
            abandoned_bodies,
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
        let mut request = self.send_request_frame(call, args).await?;

        match tokio::time::timeout(timeout, &mut request.receiver).await {
            Ok(Ok(res)) => {
                request.complete();
                Ok(res)
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
        let mut request = self.send_request_frame(call, args).await?;
        let res = (&mut request.receiver)
            .await
            .map_err(|error| format!("Connection closed while waiting for response: {}", error))?;
        request.complete();
        Ok(res)
    }

    async fn send_request_frame(
        &self,
        call: &str,
        args: Option<Value>,
    ) -> Result<PendingResponse, Box<dyn std::error::Error>> {
        if self.is_disconnected() {
            return Err("Connection is disconnected".into());
        }

        let req = RequestFrame::new(call, args);
        let id = req.id.clone();

        let (tx, rx) = oneshot::channel();
        let state = Arc::new(PendingRequestState::default());
        {
            let mut pending = self
                .pending
                .lock()
                .map_err(|error| format!("Pending request registry is unavailable: {error}"))?;
            pending.insert(
                id.clone(),
                PendingRequestEntry {
                    sender: tx,
                    state: state.clone(),
                },
            );
        }

        let mut pending_response = PendingResponse {
            id,
            receiver: rx,
            state,
            pending: self.pending.clone(),
            abandoned_bodies: self.abandoned_bodies.clone(),
            tx: self.tx.clone(),
            complete: false,
        };

        let frame = Frame::Req(req);
        let msg = Message::Text(serde_json::to_string(&frame)?);
        if let Err(error) = self.tx.send(msg).await {
            pending_response.complete();
            if let Ok(mut pending) = self.pending.lock() {
                pending.remove(&pending_response.id);
            }
            return Err(error.into());
        }

        Ok(pending_response)
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
    use crate::protocol::BINARY_FRAME_DATA;

    #[tokio::test]
    async fn fail_all_pending_requests_resolves_waiters() {
        let pending: PendingRequests = Arc::new(Mutex::new(HashMap::new()));
        let (tx, rx) = oneshot::channel();
        pending.lock().expect("pending mutex").insert(
            "req-1".to_string(),
            PendingRequestEntry {
                sender: tx,
                state: Arc::new(PendingRequestState::default()),
            },
        );

        fail_all_pending_requests(&pending, 503, "Connection closed").await;

        let response = rx.await.expect("response should be delivered");
        assert!(!response.ok);
        assert_eq!(response.id, "req-1");

        let error = response.error.expect("error details should be present");
        assert_eq!(error.code, 503);
        assert_eq!(error.message, "Connection closed");
        assert!(pending.lock().expect("pending mutex").is_empty());
    }

    #[tokio::test]
    async fn dropping_a_pending_request_removes_it_and_sends_request_cancel() {
        let pending: PendingRequests = Arc::new(Mutex::new(HashMap::new()));
        let state = Arc::new(PendingRequestState::default());
        let (response_tx, response_rx) = oneshot::channel();
        pending.lock().expect("pending mutex").insert(
            "req-cancel".to_string(),
            PendingRequestEntry {
                sender: response_tx,
                state: state.clone(),
            },
        );
        let (wire_tx, mut wire_rx) = mpsc::channel(2);
        let request = PendingResponse {
            id: "req-cancel".to_string(),
            receiver: response_rx,
            state,
            pending: pending.clone(),
            abandoned_bodies: Arc::new(Mutex::new(AbandonedBodyStreams::default())),
            tx: wire_tx,
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
            tx: wire_tx,
            pending: pending.clone(),
            frame_handler: Arc::new(RwLock::new(None)),
            binary_handler: Arc::new(RwLock::new(None)),
            abandoned_bodies: Arc::new(Mutex::new(AbandonedBodyStreams::default())),
            disconnected: Arc::new(AtomicBool::new(false)),
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
    async fn dropping_a_delivered_body_sends_body_cancel_and_discards_late_chunks() {
        let state = Arc::new(PendingRequestState::default());
        state.response_body_stream_id.store(42, Ordering::Release);
        let (_response_tx, response_rx) = oneshot::channel();
        let (wire_tx, mut wire_rx) = mpsc::channel(2);
        let abandoned_bodies = Arc::new(Mutex::new(AbandonedBodyStreams::default()));
        let request = PendingResponse {
            id: "req-body".to_string(),
            receiver: response_rx,
            state,
            pending: Arc::new(Mutex::new(HashMap::new())),
            abandoned_bodies: abandoned_bodies.clone(),
            tx: wire_tx,
            complete: false,
        };

        drop(request);

        assert!(abandoned_bodies
            .lock()
            .expect("abandoned body mutex")
            .stream_ids
            .contains(&42));
        let message = wire_rx.recv().await.expect("body cancellation frame");
        let Message::Binary(message) = message else {
            panic!("expected binary cancellation frame");
        };
        let (stream_id, flags, _) =
            crate::protocol::parse_binary_frame(&message).expect("valid binary cancellation frame");
        assert_eq!(stream_id, 42);
        assert_eq!(flags, BINARY_FRAME_CANCEL | BINARY_FRAME_END);
    }

    #[test]
    fn abandoned_body_tracking_is_bounded_and_forgets_terminal_streams() {
        let mut streams = AbandonedBodyStreams::default();
        for stream_id in 1..=(MAX_ABANDONED_BODY_STREAMS as u32 + 1) {
            streams.insert(stream_id);
        }

        assert_eq!(streams.stream_ids.len(), MAX_ABANDONED_BODY_STREAMS);
        assert!(!streams.stream_ids.contains(&1));
        let newest = MAX_ABANDONED_BODY_STREAMS as u32 + 1;
        assert!(streams.should_discard(newest, BINARY_FRAME_END));
        assert!(!streams.stream_ids.contains(&newest));
        assert!(!streams.should_discard(newest, BINARY_FRAME_END));

        streams.insert(42);
        streams.accept_reused(42);
        assert!(!streams.should_discard(42, BINARY_FRAME_DATA));
        streams.insert(42);
        assert!(streams.should_discard(42, BINARY_FRAME_END));
        assert!(!streams.should_discard(42, BINARY_FRAME_DATA));

        streams.insert(99);
        assert!(!should_discard_abandoned_frame(
            &mut streams,
            99,
            BINARY_FRAME_CANCEL | BINARY_FRAME_END,
        ));
        assert!(should_discard_abandoned_frame(
            &mut streams,
            99,
            BINARY_FRAME_DATA,
        ));
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
}
