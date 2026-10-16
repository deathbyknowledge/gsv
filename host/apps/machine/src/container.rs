//! Private instance transport for the same driver used by enrolled machines.

use std::collections::VecDeque;
use std::convert::Infallible;
use std::io;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use gateway_client::body::BinaryBodyRole;
use gateway_client::protocol::{
    DeviceExecEventParams, Frame, RequestFrame, ResponseFrame, SignalFrame, PROTOCOL_VERSION,
    REQUEST_CANCEL_SIGNAL,
};
use gateway_client::{BinaryBodyChannel, BodyError, IncomingBody};
use http_body_util::Full;
use hyper::body::{Bytes, Incoming};
use hyper::header::{AUTHORIZATION, CACHE_CONTROL, CONTENT_TYPE};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::{TokioIo, TokioTimer};
use serde_json::json;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpListener;
use tokio::sync::{mpsc, oneshot, Notify};
use tokio_tungstenite::tungstenite::handshake::server::create_response_with_body;
use tokio_tungstenite::tungstenite::protocol::{Role, WebSocketConfig};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use crate::driver::events::{
    flush_exec_event_outbox_with_sender, queue_exec_event_for_retry, ExecEventSendOutcome,
};
use crate::driver::requests::{ActiveRequests, RequestCancel};
use crate::driver::{
    daemon_body_limits, driver_error_frame, execute_request, prepare_response_body,
    DRIVER_IMPLEMENTS,
};
use crate::tools::{all_tools_with_workspace_for_device, subscribe_exec_events, Tool};

pub struct ContainerOptions {
    pub target_id: String,
    pub workspace: PathBuf,
    pub secret: String,
}

struct State {
    authorization: String,
    boot_id: String,
    health: Bytes,
    workspace: PathBuf,
    tools: Vec<Box<dyn Tool>>,
    connection: Mutex<Option<CancellationToken>>,
    events: Arc<Mutex<VecDeque<DeviceExecEventParams>>>,
    events_ready: Notify,
    events_flushing: tokio::sync::Mutex<()>,
}

pub struct ContainerServer {
    listener: TcpListener,
    state: Arc<State>,
}

impl ContainerServer {
    pub async fn bind(address: SocketAddr, options: ContainerOptions) -> io::Result<Self> {
        if options.secret.len() < 32 || !options.secret.bytes().all(|byte| byte.is_ascii_graphic())
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "GSV_INSTANCE_SECRET must contain at least 32 printable non-space ASCII characters",
            ));
        }
        if options.target_id.trim().is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "A target ID is required",
            ));
        }
        let workspace = options.workspace.canonicalize()?;
        if !workspace.is_dir() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "The workspace must be a directory",
            ));
        }
        let boot_id = uuid::Uuid::new_v4().to_string();
        let health = json!({
            "protocol": PROTOCOL_VERSION,
            "version": env!("CARGO_PKG_VERSION"),
            "targetId": options.target_id,
            "bootId": boot_id,
            "implements": DRIVER_IMPLEMENTS,
        });
        let state = Arc::new(State {
            authorization: format!("Bearer {}", options.secret),
            boot_id,
            health: Bytes::from(health.to_string()),
            tools: all_tools_with_workspace_for_device(workspace.clone(), options.target_id),
            workspace,
            connection: Mutex::new(None),
            events: Arc::new(Mutex::new(VecDeque::new())),
            events_ready: Notify::new(),
            events_flushing: tokio::sync::Mutex::new(()),
        });
        Ok(Self {
            listener: TcpListener::bind(address).await?,
            state,
        })
    }

    pub fn local_addr(&self) -> io::Result<SocketAddr> {
        self.listener.local_addr()
    }

    pub async fn run(self, shutdown: CancellationToken) -> io::Result<()> {
        let shutdown = shutdown.child_token();
        let _shutdown_guard = shutdown.clone().drop_guard();
        let tasks = TaskTracker::new();
        let mut events = subscribe_exec_events();
        tasks.spawn({
            let state = self.state.clone();
            let shutdown = shutdown.clone();
            async move {
                loop {
                    tokio::select! {
                        biased;
                        _ = shutdown.cancelled() => break,
                        event = events.recv() => match event {
                            Ok(event) => {
                                queue_exec_event_for_retry(&state.events, event);
                                state.events_ready.notify_one();
                            }
                            Err(tokio::sync::broadcast::error::RecvError::Lagged(count)) => {
                                tracing::warn!(event = "container.exec.events_lagged", count);
                            }
                            Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                        }
                    }
                }
            }
        });
        let result = loop {
            let accepted = tokio::select! {
                biased;
                _ = shutdown.cancelled() => break Ok(()),
                accepted = self.listener.accept() => accepted,
            };
            let (socket, _) = match accepted {
                Ok(accepted) => accepted,
                Err(error) => break Err(error),
            };
            let state = self.state.clone();
            let shutdown = shutdown.clone();
            let connections = tasks.clone();
            tasks.spawn(async move {
                let service_shutdown = shutdown.clone();
                let service = service_fn(move |request| {
                    serve_http(
                        request,
                        state.clone(),
                        service_shutdown.clone(),
                        connections.clone(),
                    )
                });
                tokio::select! {
                    _ = shutdown.cancelled() => {},
                    result = http1::Builder::new()
                        .timer(TokioTimer::new())
                        .header_read_timeout(Duration::from_secs(10))
                        .serve_connection(TokioIo::new(socket), service)
                        .with_upgrades() => {
                        if let Err(error) = result {
                            tracing::debug!(event = "container.http.closed", error = %error);
                        }
                    }
                }
            });
        };
        shutdown.cancel();
        tasks.close();
        tasks.wait().await;
        result
    }
}

type HttpResponse = Response<Full<Bytes>>;

fn response(status: StatusCode, body: impl Into<Bytes>) -> HttpResponse {
    let mut response = Response::new(Full::new(body.into()));
    *response.status_mut() = status;
    response
        .headers_mut()
        .insert(CACHE_CONTROL, "no-store".parse().expect("static header"));
    response
}

async fn serve_http(
    mut request: Request<Incoming>,
    state: Arc<State>,
    shutdown: CancellationToken,
    tasks: TaskTracker,
) -> Result<HttpResponse, Infallible> {
    let authorized = request
        .headers()
        .get(AUTHORIZATION)
        .is_some_and(|value| value.as_bytes() == state.authorization.as_bytes());
    if !authorized {
        return Ok(response(StatusCode::UNAUTHORIZED, "Unauthorized"));
    }
    if request.method() != Method::GET {
        return Ok(response(StatusCode::METHOD_NOT_ALLOWED, "GET required"));
    }
    match request.uri().path() {
        "/health" => {
            let mut response = response(StatusCode::OK, state.health.clone());
            response.headers_mut().insert(
                CONTENT_TYPE,
                "application/json".parse().expect("static header"),
            );
            Ok(response)
        }
        "/gsv" => {
            if !request
                .headers()
                .get("x-gsv-boot-id")
                .is_some_and(|value| value.as_bytes() == state.boot_id.as_bytes())
            {
                return Ok(response(StatusCode::CONFLICT, "Instance boot changed"));
            }
            let mut response = match create_response_with_body(&request, || Full::new(Bytes::new()))
            {
                Ok(response) => response,
                Err(_) => {
                    return Ok(response(
                        StatusCode::BAD_REQUEST,
                        "WebSocket upgrade required",
                    ))
                }
            };
            response
                .headers_mut()
                .insert("x-gsv-boot-id", state.boot_id.parse().expect("UUID header"));
            let upgrade = hyper::upgrade::on(&mut request);
            tasks.spawn(async move {
                let upgraded = tokio::select! {
                    _ = shutdown.cancelled() => return,
                    upgraded = upgrade => match upgraded {
                        Ok(upgraded) => upgraded,
                        Err(error) => {
                            tracing::warn!(event = "container.upgrade.failed", error = %error);
                            return;
                        }
                    }
                };
                let config = WebSocketConfig {
                    max_message_size: Some(16 * 1024 * 1024),
                    max_frame_size: Some(16 * 1024 * 1024),
                    ..WebSocketConfig::default()
                };
                let socket = WebSocketStream::from_raw_socket(
                    TokioIo::new(upgraded),
                    Role::Server,
                    Some(config),
                )
                .await;
                let cancellation = shutdown.child_token();
                if let Some(previous) = state
                    .connection
                    .lock()
                    .expect("connection mutex poisoned")
                    .replace(cancellation.clone())
                {
                    previous.cancel();
                }
                if let Err(error) = serve_socket(socket, state, cancellation).await {
                    tracing::warn!(event = "container.connection.failed", error = %error);
                }
            });
            Ok(response)
        }
        _ => Ok(response(StatusCode::NOT_FOUND, "Not found")),
    }
}

struct Outbound {
    message: Message,
    sent: oneshot::Sender<Result<(), String>>,
}

#[derive(Clone)]
struct SocketSender(mpsc::Sender<Outbound>);

impl SocketSender {
    async fn send(&self, message: Message) -> Result<(), String> {
        let (sent, received) = oneshot::channel();
        self.0
            .send(Outbound { message, sent })
            .await
            .map_err(|_| "Connection closed".to_string())?;
        received
            .await
            .map_err(|_| "Connection closed".to_string())?
    }

    async fn frame(&self, frame: &Frame) -> Result<(), String> {
        self.send(Message::Text(
            serde_json::to_string(frame).map_err(|error| error.to_string())?,
        ))
        .await
    }
}

async fn serve_socket<S>(
    socket: WebSocketStream<S>,
    state: Arc<State>,
    cancellation: CancellationToken,
) -> Result<(), String>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let _cancel_guard = cancellation.clone().drop_guard();
    let tasks = TaskTracker::new();
    let (mut sink, mut source) = socket.split();
    let (outbound, mut messages) = mpsc::channel::<Outbound>(16);
    let sender = SocketSender(outbound);
    tasks.spawn({
        let cancellation = cancellation.clone();
        async move {
            let _cancel_guard = cancellation.clone().drop_guard();
            loop {
                tokio::select! {
                    biased;
                    _ = cancellation.cancelled() => break,
                    message = messages.recv() => {
                        let Some(message) = message else { break };
                        let result = tokio::select! {
                            biased;
                            _ = cancellation.cancelled() => break,
                            result = sink.send(message.message) => result.map_err(|error| error.to_string()),
                        };
                        let failed = result.is_err();
                        let _ = message.sent.send(result);
                        if failed { break; }
                    }
                }
            }
        }
    });
    let channel = BinaryBodyChannel::new(
        gateway_client::BinaryBodyLimits {
            role: BinaryBodyRole::Acceptor,
            ..daemon_body_limits()
        },
        {
            let sender = sender.clone();
            move |bytes| {
                let sender = sender.clone();
                async move {
                    sender
                        .send(Message::Binary(bytes))
                        .await
                        .map_err(BodyError::Transport)
                }
            }
        },
    )
    .map_err(|error| error.to_string())?;
    tasks.spawn({
        let state = state.clone();
        let sender = sender.clone();
        let cancellation = cancellation.clone();
        async move {
            let flush = async {
                loop {
                    let ready = state.events_ready.notified();
                    {
                        let _guard = state.events_flushing.lock().await;
                        flush_exec_event_outbox_with_sender(&state.events, |event| {
                            let sender = sender.clone();
                            async move {
                                let frame = Frame::Sig(SignalFrame {
                                    signal: "exec.status".to_string(),
                                    payload: Some(json!(event)),
                                    seq: None,
                                });
                                match sender.frame(&frame).await {
                                    Ok(()) => ExecEventSendOutcome::Sent,
                                    Err(error) => ExecEventSendOutcome::Retry(error),
                                }
                            }
                        })
                        .await;
                    }
                    ready.await;
                }
            };
            tokio::select! {
                _ = cancellation.cancelled() => {},
                _ = flush => {},
            }
        }
    });
    let requests = ActiveRequests::default();
    let result = loop {
        let message = tokio::select! {
            biased;
            _ = cancellation.cancelled() => break Ok(()),
            message = source.next() => message,
        };
        match message {
            Some(Ok(Message::Text(text))) => {
                let frame = match serde_json::from_str::<Frame>(&text) {
                    Ok(frame) => frame,
                    Err(_) => break Err("Invalid protocol frame".to_string()),
                };
                match frame {
                    Frame::Req(request) => {
                        let body = request
                            .body
                            .map(|body| channel.receive(body))
                            .transpose()
                            .map_err(|error| error.to_string());
                        let token = requests.register(&request);
                        let requests = requests.clone();
                        let state = state.clone();
                        let sender = sender.clone();
                        let channel = channel.clone();
                        tasks.spawn(async move {
                            tokio::select! {
                                biased;
                                _ = token.cancelled() => {},
                                result = serve_request(&state, &sender, &channel, &request, body, &token) => {
                                    if let Err(error) = result {
                                        tracing::warn!(event = "container.request.failed", call = %request.call, request_id = %request.id, error = %error);
                                    }
                                }
                            }
                            requests.finish(&request.id, &token);
                        });
                    }
                    Frame::Sig(signal) if signal.signal == REQUEST_CANCEL_SIGNAL => {
                        let cancel = signal.payload.and_then(|payload| {
                            serde_json::from_value::<RequestCancel>(payload).ok()
                        });
                        match cancel {
                            Some(cancel) => {
                                requests.cancel(cancel);
                            }
                            None => break Err("Invalid request cancellation".to_string()),
                        }
                    }
                    _ => break Err("Unexpected protocol frame".to_string()),
                }
            }
            Some(Ok(Message::Binary(bytes))) => {
                if !channel.handle_frame(&bytes).await {
                    break Err("Invalid binary frame".to_string());
                }
            }
            Some(Ok(Message::Ping(bytes))) => {
                if let Err(error) = sender.send(Message::Pong(bytes)).await {
                    break Err(error);
                }
            }
            Some(Ok(Message::Pong(_))) => {}
            Some(Ok(Message::Close(_))) | None => break Ok(()),
            Some(Ok(Message::Frame(_))) => break Err("Unexpected raw WebSocket frame".to_string()),
            Some(Err(error)) => break Err(error.to_string()),
        }
    };
    requests.cancel_all("Connection closed");
    channel.close("Connection closed");
    cancellation.cancel();
    tasks.close();
    tasks.wait().await;
    result
}

async fn serve_request(
    state: &State,
    sender: &SocketSender,
    channel: &BinaryBodyChannel,
    request: &RequestFrame,
    body: Result<Option<IncomingBody>, String>,
    cancellation: &CancellationToken,
) -> Result<(), String> {
    let result = execute_request(&state.tools, &state.workspace, request, body, cancellation).await;
    let result = result.and_then(|output| {
        let body = output
            .body
            .map(|body| prepare_response_body(channel, body))
            .transpose()?;
        Ok((
            Frame::Res(ResponseFrame {
                id: request.id.clone(),
                ok: true,
                data: Some(output.data),
                error: None,
                body: body.as_ref().map(|body| body.outgoing.descriptor()),
            }),
            body,
        ))
    });
    let (frame, body) = match result {
        Ok(result) => result,
        Err(error) => (driver_error_frame(request, error), None),
    };
    sender.frame(&frame).await?;
    if let Some(body) = body {
        body.send().await?;
    }
    Ok(())
}
