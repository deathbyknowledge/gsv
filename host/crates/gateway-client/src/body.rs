use crate::protocol::{
    build_binary_frame, build_window_frame, parse_binary_frame, parse_window_credit,
    FrameBodyDescriptor, BINARY_FRAME_CANCEL, BINARY_FRAME_DATA, BINARY_FRAME_END,
    BINARY_FRAME_ERROR, BINARY_FRAME_WINDOW, BINARY_INITIAL_WINDOW_BYTES,
};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fmt::{self, Display, Formatter};
use std::future::Future;
use std::io::Cursor;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::sync::{mpsc, Notify};
use tokio_util::sync::CancellationToken;

type SendFuture = Pin<Box<dyn Future<Output = Result<(), BodyError>> + Send>>;
type FrameSender = Arc<dyn Fn(Vec<u8>) -> SendFuture + Send + Sync>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BodyError {
    InvalidDescriptor(String),
    LimitExceeded(String),
    Protocol(String),
    Transport(String),
    TimedOut(u32),
    Cancelled(String),
    Closed(String),
}

impl Display for BodyError {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidDescriptor(message)
            | Self::LimitExceeded(message)
            | Self::Protocol(message)
            | Self::Transport(message)
            | Self::Cancelled(message)
            | Self::Closed(message) => f.write_str(message),
            Self::TimedOut(stream_id) => write!(f, "Binary transfer timed out: {stream_id}"),
        }
    }
}

impl std::error::Error for BodyError {}

/// Which end of the transport a channel sits on. The initiator opened the
/// connection and allocates odd stream ids; the acceptor allocates even ones.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum BinaryBodyRole {
    #[default]
    Initiator,
    Acceptor,
}

#[derive(Debug, Clone)]
pub struct BinaryBodyLimits {
    pub role: BinaryBodyRole,
    pub chunk_bytes: usize,
    /// Bytes a sender may keep in flight per stream while this side drains.
    pub window_bytes: u64,
    /// Credit both peers assume before any WINDOW frame. A protocol constant;
    /// override it only in tests that exercise stalls with small bodies.
    pub initial_window_bytes: u64,
    pub max_frame_bytes: usize,
    pub max_body_bytes: u64,
    pub max_active_streams: usize,
    pub max_orphan_frames: usize,
    pub max_orphan_bytes: usize,
    pub max_ignored_streams: usize,
    pub idle_timeout: Duration,
}

impl Default for BinaryBodyLimits {
    fn default() -> Self {
        Self {
            role: BinaryBodyRole::Initiator,
            chunk_bytes: 1024 * 1024,
            window_bytes: BINARY_INITIAL_WINDOW_BYTES,
            initial_window_bytes: BINARY_INITIAL_WINDOW_BYTES,
            max_frame_bytes: 1024 * 1024,
            max_body_bytes: 256 * 1024 * 1024,
            max_active_streams: 64,
            max_orphan_frames: 64,
            max_orphan_bytes: 8 * 1024 * 1024,
            max_ignored_streams: 256,
            idle_timeout: Duration::from_secs(120),
        }
    }
}

impl BinaryBodyLimits {
    fn validate(&self) -> Result<(), BodyError> {
        if self.chunk_bytes == 0 || self.chunk_bytes > self.max_frame_bytes {
            return Err(BodyError::InvalidDescriptor(
                "Binary chunk size must be positive and no larger than the frame limit".to_string(),
            ));
        }
        if self.window_bytes == 0
            || self.window_bytes > u64::from(u32::MAX)
            || self.initial_window_bytes == 0
            || self.initial_window_bytes > u64::from(u32::MAX)
        {
            return Err(BodyError::InvalidDescriptor(
                "Binary body windows must fit a u32 and be positive".to_string(),
            ));
        }
        if self.max_frame_bytes == 0
            || self.max_body_bytes == 0
            || self.max_active_streams == 0
            || self.max_orphan_frames == 0
            || self.max_orphan_bytes == 0
            || self.max_ignored_streams == 0
            || self.idle_timeout.is_zero()
        {
            return Err(BodyError::InvalidDescriptor(
                "Binary body limits must be positive".to_string(),
            ));
        }
        Ok(())
    }
}

pub struct BinaryBody {
    reader: Pin<Box<dyn AsyncRead + Send>>,
    length: Option<u64>,
    max_bytes: Option<u64>,
}

impl BinaryBody {
    pub fn from_bytes(bytes: impl Into<Vec<u8>>) -> Self {
        let bytes = bytes.into();
        let length = bytes.len() as u64;
        Self {
            reader: Box::pin(Cursor::new(bytes)),
            length: Some(length),
            max_bytes: Some(length),
        }
    }

    pub fn from_reader(reader: impl AsyncRead + Send + 'static, length: Option<u64>) -> Self {
        Self {
            reader: Box::pin(reader),
            length,
            max_bytes: length,
        }
    }

    pub fn length(&self) -> Option<u64> {
        self.length
    }

    pub fn with_max_bytes(mut self, max_bytes: u64) -> Self {
        self.max_bytes = Some(
            self.max_bytes
                .map_or(max_bytes, |current| current.min(max_bytes)),
        );
        self
    }
}

#[derive(Debug)]
enum BodyEvent {
    Data(Vec<u8>),
    End,
    Error(BodyError),
}

#[derive(Debug)]
struct IncomingState {
    /// Unbounded in frames on purpose: the peer may only send what the
    /// receive window allows, so buffered bytes are bounded by that window
    /// however small the frames are.
    sender: mpsc::UnboundedSender<BodyEvent>,
    expected: Option<u64>,
    received: u64,
    /// Credit granted to the sender so far, including the initial window.
    granted: u64,
}

/// Credit the receiver has allowed an outgoing stream to put on the wire.
#[derive(Debug, Default)]
struct OutgoingCredit {
    available: Mutex<u64>,
    granted: Notify,
}

impl OutgoingCredit {
    /// Resolves with the credit available to the next chunk. Waits for a WINDOW
    /// frame when the receiver has consumed everything it allowed, and fails
    /// the transfer when no credit arrives within the idle timeout.
    async fn wait(
        &self,
        cancelled: &CancellationToken,
        idle_timeout: Duration,
        stream_id: u32,
    ) -> Result<u64, BodyError> {
        loop {
            let available = self
                .available
                .lock()
                .map(|available| *available)
                .unwrap_or(0);
            if available > 0 {
                return Ok(available);
            }
            tokio::select! {
                _ = cancelled.cancelled() => {
                    return Err(BodyError::Cancelled("Binary body send was cancelled".to_string()));
                }
                granted = tokio::time::timeout(idle_timeout, self.granted.notified()) => {
                    if granted.is_err() {
                        return Err(BodyError::TimedOut(stream_id));
                    }
                }
            }
        }
    }
}

#[derive(Debug, Clone)]
struct OutgoingState {
    token: CancellationToken,
    credit: Arc<OutgoingCredit>,
}

#[derive(Debug, Clone)]
struct OrphanFrame {
    flags: u8,
    payload: Vec<u8>,
}

#[derive(Debug, Default)]
struct BodyState {
    incoming: HashMap<u32, IncomingState>,
    outgoing: HashMap<u32, OutgoingState>,
    orphans: HashMap<u32, VecDeque<OrphanFrame>>,
    orphan_order: VecDeque<u32>,
    orphan_frames: usize,
    orphan_bytes: usize,
    ignored: HashSet<u32>,
    ignored_order: VecDeque<u32>,
    closed: Option<String>,
}

#[derive(Clone)]
pub struct BinaryBodyChannel {
    state: Arc<Mutex<BodyState>>,
    next_stream_id: Arc<AtomicU32>,
    send_frame: FrameSender,
    control_tx: mpsc::Sender<Vec<u8>>,
    control_shutdown: CancellationToken,
    limits: BinaryBodyLimits,
}

impl BinaryBodyChannel {
    pub fn new<F, Fut>(limits: BinaryBodyLimits, send_frame: F) -> Result<Self, BodyError>
    where
        F: Fn(Vec<u8>) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<(), BodyError>> + Send + 'static,
    {
        limits.validate()?;
        let send_frame: FrameSender = Arc::new(move |frame| Box::pin(send_frame(frame)));
        let (control_tx, mut control_rx) = mpsc::channel(limits.max_active_streams);
        let control_shutdown = CancellationToken::new();
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            let control_send = send_frame.clone();
            let shutdown = control_shutdown.clone();
            runtime.spawn(async move {
                loop {
                    let frame = tokio::select! {
                        biased;
                        _ = shutdown.cancelled() => break,
                        frame = control_rx.recv() => frame,
                    };
                    let Some(frame) = frame else {
                        break;
                    };
                    tokio::select! {
                        biased;
                        _ = shutdown.cancelled() => break,
                        _ = control_send(frame) => {}
                    }
                }
            });
        }
        let first_stream_id = match limits.role {
            BinaryBodyRole::Initiator => 1,
            BinaryBodyRole::Acceptor => 2,
        };
        Ok(Self {
            state: Arc::new(Mutex::new(BodyState::default())),
            next_stream_id: Arc::new(AtomicU32::new(first_stream_id)),
            send_frame,
            control_tx,
            control_shutdown,
            limits,
        })
    }

    pub fn receive(&self, descriptor: FrameBodyDescriptor) -> Result<IncomingBody, BodyError> {
        validate_descriptor(descriptor, &self.limits)?;
        let (sender, receiver) = mpsc::unbounded_channel();
        let orphans = {
            let mut state = self.state.lock().map_err(|_| {
                BodyError::Closed("Binary body registry is unavailable".to_string())
            })?;
            if let Some(reason) = &state.closed {
                return Err(BodyError::Closed(reason.clone()));
            }
            if state.incoming.contains_key(&descriptor.stream_id) {
                return Err(BodyError::Protocol(format!(
                    "Binary stream is already pending: {}",
                    descriptor.stream_id
                )));
            }
            if state.incoming.len() >= self.limits.max_active_streams {
                return Err(BodyError::LimitExceeded(
                    "Too many active binary streams".to_string(),
                ));
            }
            let orphans = state
                .orphans
                .remove(&descriptor.stream_id)
                .unwrap_or_default();
            state.ignored.remove(&descriptor.stream_id);
            state.ignored_order.retain(|id| *id != descriptor.stream_id);
            if !orphans.is_empty() {
                state.orphan_order.retain(|id| *id != descriptor.stream_id);
                state.orphan_frames = state.orphan_frames.saturating_sub(orphans.len());
                state.orphan_bytes = state.orphan_bytes.saturating_sub(
                    orphans
                        .iter()
                        .map(|frame| frame.payload.len())
                        .sum::<usize>(),
                );
            }
            state.incoming.insert(
                descriptor.stream_id,
                IncomingState {
                    sender,
                    expected: descriptor.length,
                    received: 0,
                    granted: self.limits.initial_window_bytes,
                },
            );
            orphans
        };

        let mut body = IncomingBody {
            stream_id: descriptor.stream_id,
            length: descriptor.length,
            receiver,
            channel: self.clone(),
            terminal: false,
            consumed: 0,
        };
        for frame in orphans {
            self.dispatch_frame(descriptor.stream_id, frame.flags, frame.payload);
        }
        if self
            .state
            .lock()
            .map(|state| !state.incoming.contains_key(&descriptor.stream_id))
            .unwrap_or(true)
            && body.receiver.is_empty()
        {
            body.terminal = true;
        }
        Ok(body)
    }

    pub fn prepare(&self, body: BinaryBody) -> Result<OutgoingBody, BodyError> {
        if body
            .length
            .is_some_and(|length| length > self.limits.max_body_bytes)
            || body
                .length
                .zip(body.max_bytes)
                .is_some_and(|(length, maximum)| length > maximum)
        {
            return Err(BodyError::LimitExceeded(format!(
                "Binary body exceeds limit of {} bytes",
                self.limits.max_body_bytes
            )));
        }
        let token = CancellationToken::new();
        let credit = Arc::new(OutgoingCredit {
            available: Mutex::new(self.limits.initial_window_bytes),
            granted: Notify::new(),
        });
        let stream_id = {
            let mut state = self.state.lock().map_err(|_| {
                BodyError::Closed("Binary body registry is unavailable".to_string())
            })?;
            if let Some(reason) = &state.closed {
                return Err(BodyError::Closed(reason.clone()));
            }
            if state.outgoing.len() >= self.limits.max_active_streams {
                return Err(BodyError::LimitExceeded(
                    "Too many active outgoing binary streams".to_string(),
                ));
            }
            let stream_id = self.allocate_stream_id(&state)?;
            state.outgoing.insert(
                stream_id,
                OutgoingState {
                    token: token.clone(),
                    credit: credit.clone(),
                },
            );
            stream_id
        };
        Ok(OutgoingBody {
            descriptor: FrameBodyDescriptor {
                stream_id,
                length: body.length,
            },
            body: Some(body),
            channel: self.clone(),
            token,
            credit,
            terminal: Arc::new(AtomicBool::new(false)),
        })
    }

    pub async fn handle_frame(&self, data: &[u8]) -> bool {
        let Some((stream_id, flags, payload)) = parse_binary_frame(data) else {
            return false;
        };
        if flags & BINARY_FRAME_WINDOW != 0 {
            let credit = self
                .state
                .lock()
                .ok()
                .and_then(|state| state.outgoing.get(&stream_id).map(|s| s.credit.clone()));
            if let (Some(credit), Some(granted)) = (credit, parse_window_credit(&payload)) {
                if let Ok(mut available) = credit.available.lock() {
                    *available = available.saturating_add(u64::from(granted));
                }
                credit.granted.notify_one();
            }
            return true;
        }
        if flags & BINARY_FRAME_CANCEL != 0 {
            let token = self
                .state
                .lock()
                .ok()
                .and_then(|state| state.outgoing.get(&stream_id).map(|s| s.token.clone()));
            if let Some(token) = token {
                token.cancel();
                return true;
            }
        }
        let ignored = self
            .state
            .lock()
            .map(|mut state| {
                let ignored = state.ignored.contains(&stream_id);
                if ignored && flags & BINARY_FRAME_END != 0 {
                    state.ignored.remove(&stream_id);
                    state.ignored_order.retain(|id| *id != stream_id);
                }
                ignored
            })
            .unwrap_or(false);
        if ignored {
            return true;
        }
        let registered = self
            .state
            .lock()
            .map(|state| state.incoming.contains_key(&stream_id))
            .unwrap_or(false);
        if registered {
            self.dispatch_frame(stream_id, flags, payload);
            // A WebSocket can surface an already-buffered burst without yielding
            // between frames. Give the body owner a chance to drain its bounded
            // queue before the connection reads the next ready data frame.
            if flags & BINARY_FRAME_DATA != 0 {
                tokio::task::yield_now().await;
            }
        } else {
            self.buffer_orphan(stream_id, flags, payload);
        }
        true
    }

    pub fn close(&self, reason: impl Into<String>) {
        let reason = reason.into();
        let (incoming, outgoing) = {
            let Ok(mut state) = self.state.lock() else {
                return;
            };
            if state.closed.is_some() {
                return;
            }
            state.closed = Some(reason.clone());
            let incoming = state
                .incoming
                .drain()
                .map(|(_, value)| value.sender)
                .collect::<Vec<_>>();
            let outgoing = state
                .outgoing
                .drain()
                .map(|(_, value)| value.token)
                .collect::<Vec<_>>();
            state.orphans.clear();
            state.orphan_order.clear();
            state.orphan_frames = 0;
            state.orphan_bytes = 0;
            state.ignored.clear();
            state.ignored_order.clear();
            (incoming, outgoing)
        };
        for sender in incoming {
            let _ = sender.send(BodyEvent::Error(BodyError::Closed(reason.clone())));
        }
        for token in outgoing {
            token.cancel();
        }
        self.control_shutdown.cancel();
    }

    fn allocate_stream_id(&self, state: &BodyState) -> Result<u32, BodyError> {
        let first = match self.limits.role {
            BinaryBodyRole::Initiator => 1,
            BinaryBodyRole::Acceptor => 2,
        };
        for _ in 0..u32::MAX / 2 {
            // Stepping by two keeps this side's parity; a wrap lands on 0 (or
            // an initiator's 1), which restarts the sequence.
            let id = self.next_stream_id.fetch_add(2, Ordering::Relaxed);
            let id = if id == 0 {
                self.next_stream_id.store(first + 2, Ordering::Relaxed);
                first
            } else {
                id
            };
            if !state.outgoing.contains_key(&id) && !state.incoming.contains_key(&id) {
                return Ok(id);
            }
        }
        Err(BodyError::LimitExceeded(
            "No binary stream identifiers are available".to_string(),
        ))
    }

    fn dispatch_frame(&self, stream_id: u32, flags: u8, payload: Vec<u8>) {
        let mut terminal = None;
        let mut frame = None;
        let mut reject_peer = false;
        {
            let Ok(mut state) = self.state.lock() else {
                return;
            };
            let Some(incoming) = state.incoming.get_mut(&stream_id) else {
                return;
            };
            if flags & (BINARY_FRAME_ERROR | BINARY_FRAME_CANCEL) != 0 {
                let message = String::from_utf8_lossy(&payload).to_string();
                terminal = Some(BodyEvent::Error(BodyError::Cancelled(
                    if message.is_empty() {
                        "Binary transfer was cancelled by its sender".to_string()
                    } else {
                        message
                    },
                )));
            } else if flags & BINARY_FRAME_DATA != 0 && !payload.is_empty() {
                let next = incoming.received.saturating_add(payload.len() as u64);
                let invalid = payload.len() > self.limits.max_frame_bytes
                    || next > self.limits.max_body_bytes
                    || next > incoming.granted
                    || incoming.expected.is_some_and(|expected| next > expected);
                if invalid {
                    reject_peer = true;
                    terminal = Some(BodyEvent::Error(BodyError::LimitExceeded(
                        "Binary body exceeded its declared or configured size".to_string(),
                    )));
                } else {
                    incoming.received = next;
                    frame = Some(BodyEvent::Data(payload));
                }
            }
            if terminal.is_none() && flags & BINARY_FRAME_END != 0 {
                terminal = Some(
                    if incoming
                        .expected
                        .is_some_and(|expected| expected != incoming.received)
                    {
                        BodyEvent::Error(BodyError::Protocol(format!(
                            "Body length {} did not match {:?}",
                            incoming.received, incoming.expected
                        )))
                    } else {
                        BodyEvent::End
                    },
                );
            }
            let sender = incoming.sender.clone();
            if let Some(frame) = frame {
                let _ = sender.send(frame);
            }
            if let Some(event) = terminal {
                state.incoming.remove(&stream_id);
                if reject_peer {
                    mark_ignored(&mut state, stream_id, self.limits.max_ignored_streams);
                }
                let _ = sender.send(event);
            }
        }
        if reject_peer {
            self.send_control(
                stream_id,
                BINARY_FRAME_CANCEL | BINARY_FRAME_END,
                "Binary body receiver rejected the transfer",
            );
        }
    }

    fn buffer_orphan(&self, stream_id: u32, flags: u8, payload: Vec<u8>) {
        if payload.len() > self.limits.max_frame_bytes {
            if let Ok(mut state) = self.state.lock() {
                mark_ignored(&mut state, stream_id, self.limits.max_ignored_streams);
            }
            self.send_control(
                stream_id,
                BINARY_FRAME_CANCEL | BINARY_FRAME_END,
                "Binary frame exceeded limit",
            );
            return;
        }
        let mut reject = false;
        {
            let Ok(mut state) = self.state.lock() else {
                return;
            };
            if state.closed.is_some() {
                return;
            }
            let new_stream = !state.orphans.contains_key(&stream_id);
            if state.orphan_frames >= self.limits.max_orphan_frames
                || state.orphan_bytes.saturating_add(payload.len()) > self.limits.max_orphan_bytes
            {
                reject = true;
                mark_ignored(&mut state, stream_id, self.limits.max_ignored_streams);
            } else {
                if new_stream {
                    state.orphan_order.push_back(stream_id);
                }
                state.orphan_frames += 1;
                state.orphan_bytes += payload.len();
                state
                    .orphans
                    .entry(stream_id)
                    .or_default()
                    .push_back(OrphanFrame { flags, payload });
            }
        }
        if reject {
            self.send_control(
                stream_id,
                BINARY_FRAME_CANCEL | BINARY_FRAME_END,
                "Binary body arrived without a receiver",
            );
        }
    }

    /// Grants the sender enough credit to keep one window in flight beyond
    /// what the consumer has drained. Small top-ups are batched until half a
    /// window is owed, unless the sender is out of credit entirely.
    async fn grant_window(&self, stream_id: u32, consumed: u64) {
        let frame = {
            let Ok(mut state) = self.state.lock() else {
                return;
            };
            let Some(incoming) = state.incoming.get_mut(&stream_id) else {
                return;
            };
            let target = consumed.saturating_add(self.limits.window_bytes);
            let increment = target.saturating_sub(incoming.granted);
            let stalled = incoming.granted == incoming.received;
            if increment == 0 || (!stalled && increment < self.limits.window_bytes.div_ceil(2)) {
                return;
            }
            let increment = u32::try_from(increment.min(u64::from(u32::MAX))).unwrap_or(u32::MAX);
            incoming.granted = incoming.granted.saturating_add(u64::from(increment));
            build_window_frame(stream_id, increment)
        };
        let _ = (self.send_frame)(frame).await;
    }

    fn cancel_incoming(&self, stream_id: u32, reason: &str) {
        let removed = self
            .state
            .lock()
            .ok()
            .and_then(|mut state| {
                let removed = state.incoming.remove(&stream_id);
                if removed.is_some() {
                    mark_ignored(&mut state, stream_id, self.limits.max_ignored_streams);
                }
                removed
            })
            .is_some();
        if removed {
            self.send_control(stream_id, BINARY_FRAME_CANCEL | BINARY_FRAME_END, reason);
        }
    }

    fn send_control(&self, stream_id: u32, flags: u8, reason: &str) {
        let frame = build_binary_frame(stream_id, flags, reason.as_bytes());
        // Control frames are best effort and bounded. Local ownership is
        // already terminated before this point; a saturated/closed transport
        // must not create an unbounded detached task merely to report it.
        let _ = self.control_tx.try_send(frame);
    }

    fn missing_terminal_error(&self, stream_id: u32) -> BodyError {
        let reason = self
            .state
            .lock()
            .ok()
            .and_then(|state| state.closed.clone())
            .unwrap_or_else(|| {
                format!("Binary body stream {stream_id} closed without a terminal frame")
            });
        BodyError::Closed(reason)
    }
}

fn mark_ignored(state: &mut BodyState, stream_id: u32, limit: usize) {
    if !state.ignored.insert(stream_id) {
        return;
    }
    while state.ignored_order.len() >= limit {
        if let Some(evicted) = state.ignored_order.pop_front() {
            state.ignored.remove(&evicted);
        }
    }
    state.ignored_order.push_back(stream_id);
}

pub struct IncomingBody {
    stream_id: u32,
    length: Option<u64>,
    receiver: mpsc::UnboundedReceiver<BodyEvent>,
    channel: BinaryBodyChannel,
    terminal: bool,
    consumed: u64,
}

impl IncomingBody {
    pub fn stream_id(&self) -> u32 {
        self.stream_id
    }

    pub fn length(&self) -> Option<u64> {
        self.length
    }

    pub async fn recv(&mut self) -> Result<Option<Vec<u8>>, BodyError> {
        if self.terminal {
            return Ok(None);
        }
        let event = tokio::time::timeout(self.channel.limits.idle_timeout, self.receiver.recv())
            .await
            .map_err(|_| {
                self.channel
                    .cancel_incoming(self.stream_id, "Binary body transfer timed out");
                self.terminal = true;
                BodyError::TimedOut(self.stream_id)
            })?;
        match event {
            Some(BodyEvent::Data(bytes)) => {
                self.consumed = self.consumed.saturating_add(bytes.len() as u64);
                self.channel
                    .grant_window(self.stream_id, self.consumed)
                    .await;
                Ok(Some(bytes))
            }
            Some(BodyEvent::End) => {
                self.terminal = true;
                Ok(None)
            }
            Some(BodyEvent::Error(error)) => {
                self.terminal = true;
                Err(error)
            }
            None => {
                self.terminal = true;
                Err(self.channel.missing_terminal_error(self.stream_id))
            }
        }
    }

    pub async fn read_all(mut self, max_bytes: usize) -> Result<Vec<u8>, BodyError> {
        if self.length.is_some_and(|length| length > max_bytes as u64) {
            self.cancel("Binary body is larger than the caller limit");
            return Err(BodyError::LimitExceeded(format!(
                "Binary body exceeds caller limit of {max_bytes} bytes"
            )));
        }
        let mut bytes = Vec::with_capacity(
            self.length
                .and_then(|length| usize::try_from(length).ok())
                .unwrap_or(0)
                .min(max_bytes),
        );
        while let Some(chunk) = self.recv().await? {
            if bytes.len().saturating_add(chunk.len()) > max_bytes {
                self.cancel("Binary body exceeded the caller limit");
                return Err(BodyError::LimitExceeded(format!(
                    "Binary body exceeds caller limit of {max_bytes} bytes"
                )));
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
    }

    pub fn cancel(&mut self, reason: &str) {
        if !self.terminal {
            self.channel.cancel_incoming(self.stream_id, reason);
            self.terminal = true;
        }
    }
}

impl Drop for IncomingBody {
    fn drop(&mut self) {
        self.cancel("Binary body was no longer needed");
    }
}

pub struct OutgoingBody {
    descriptor: FrameBodyDescriptor,
    body: Option<BinaryBody>,
    channel: BinaryBodyChannel,
    token: CancellationToken,
    credit: Arc<OutgoingCredit>,
    terminal: Arc<AtomicBool>,
}

impl OutgoingBody {
    pub fn descriptor(&self) -> FrameBodyDescriptor {
        self.descriptor
    }

    pub fn cancel(&self) {
        self.token.cancel();
    }

    pub async fn send(mut self) -> Result<(), BodyError> {
        let mut body = self
            .body
            .take()
            .ok_or_else(|| BodyError::Protocol("Binary body was already consumed".to_string()))?;
        let mut buffer = vec![0_u8; self.channel.limits.chunk_bytes];
        let mut sent = 0_u64;
        let result = loop {
            let allowed = match self
                .credit
                .wait(
                    &self.token,
                    self.channel.limits.idle_timeout,
                    self.descriptor.stream_id,
                )
                .await
            {
                Ok(allowed) => allowed,
                Err(error) => break Err(error),
            };
            let limit = usize::try_from(allowed)
                .unwrap_or(usize::MAX)
                .min(buffer.len());
            let read = tokio::select! {
                _ = self.token.cancelled() => {
                    break Err(BodyError::Cancelled("Binary body send was cancelled".to_string()));
                }
                read = body.reader.read(&mut buffer[..limit]) => read
                    .map_err(|error| BodyError::Transport(format!("Could not read binary body: {error}")))?,
            };
            if let Ok(mut available) = self.credit.available.lock() {
                *available = available.saturating_sub(read as u64);
            }
            if read == 0 {
                if body.length.is_some_and(|length| length != sent) {
                    break Err(BodyError::Protocol(format!(
                        "Outgoing body length {sent} did not match {:?}",
                        body.length
                    )));
                }
                (self.channel.send_frame)(build_binary_frame(
                    self.descriptor.stream_id,
                    BINARY_FRAME_END,
                    &[],
                ))
                .await?;
                break Ok(());
            }
            sent = sent.saturating_add(read as u64);
            if sent > self.channel.limits.max_body_bytes
                || body.max_bytes.is_some_and(|maximum| sent > maximum)
                || body.length.is_some_and(|length| sent > length)
            {
                break Err(BodyError::LimitExceeded(
                    "Outgoing binary body exceeded its declared or configured size".to_string(),
                ));
            }
            (self.channel.send_frame)(build_binary_frame(
                self.descriptor.stream_id,
                BINARY_FRAME_DATA,
                &buffer[..read],
            ))
            .await?;
        };
        if let Err(error) = &result {
            let _ = (self.channel.send_frame)(build_binary_frame(
                self.descriptor.stream_id,
                BINARY_FRAME_ERROR | BINARY_FRAME_END,
                error.to_string().as_bytes(),
            ))
            .await;
        }
        if let Ok(mut state) = self.channel.state.lock() {
            state.outgoing.remove(&self.descriptor.stream_id);
        }
        self.terminal.store(true, Ordering::Release);
        result
    }

    pub async fn send_until(
        self,
        deadline: tokio::time::Instant,
        cancellation: CancellationToken,
    ) -> Result<(), BodyError> {
        let stream_id = self.descriptor.stream_id;
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => {
                Err(BodyError::Cancelled("Binary body send was cancelled".to_string()))
            }
            result = tokio::time::timeout_at(deadline, self.send()) => {
                result.map_err(|_| BodyError::TimedOut(stream_id))?
            }
        }
    }
}

impl Drop for OutgoingBody {
    fn drop(&mut self) {
        if !self.terminal.load(Ordering::Acquire) {
            self.token.cancel();
            if let Ok(mut state) = self.channel.state.lock() {
                state.outgoing.remove(&self.descriptor.stream_id);
            }
            self.channel.send_control(
                self.descriptor.stream_id,
                BINARY_FRAME_ERROR | BINARY_FRAME_END,
                "Binary body sender was dropped",
            );
        }
    }
}

pub struct RpcResponse {
    pub data: serde_json::Value,
    pub body: Option<IncomingBody>,
}

fn validate_descriptor(
    descriptor: FrameBodyDescriptor,
    limits: &BinaryBodyLimits,
) -> Result<(), BodyError> {
    if descriptor.stream_id == 0 {
        return Err(BodyError::InvalidDescriptor(
            "Binary stream id must be positive".to_string(),
        ));
    }
    if descriptor
        .length
        .is_some_and(|length| length > limits.max_body_bytes)
    {
        return Err(BodyError::LimitExceeded(format!(
            "Binary body exceeds limit of {} bytes",
            limits.max_body_bytes
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    fn channel(sent: Arc<StdMutex<Vec<Vec<u8>>>>) -> BinaryBodyChannel {
        BinaryBodyChannel::new(BinaryBodyLimits::default(), move |frame| {
            let sent = sent.clone();
            async move {
                sent.lock().expect("sent frames").push(frame);
                Ok(())
            }
        })
        .expect("body channel")
    }

    #[tokio::test]
    async fn outgoing_body_uses_wire_compatible_frames() {
        let sent = Arc::new(StdMutex::new(Vec::new()));
        let channel = channel(sent.clone());
        let outgoing = channel
            .prepare(BinaryBody::from_bytes(b"hello".to_vec()))
            .expect("outgoing body");
        let descriptor = outgoing.descriptor();
        outgoing.send().await.expect("body send");
        let frames = sent.lock().expect("sent frames");
        let parsed = frames
            .iter()
            .map(|frame| parse_binary_frame(frame).expect("binary frame"))
            .collect::<Vec<_>>();
        assert_eq!(descriptor.length, Some(5));
        assert_eq!(
            parsed[0],
            (descriptor.stream_id, BINARY_FRAME_DATA, b"hello".to_vec())
        );
        assert_eq!(
            parsed[1],
            (descriptor.stream_id, BINARY_FRAME_END, Vec::new())
        );
    }

    #[tokio::test]
    async fn incoming_body_accepts_frames_before_descriptor_registration() {
        let sent = Arc::new(StdMutex::new(Vec::new()));
        let channel = channel(sent);
        channel
            .handle_frame(&build_binary_frame(9, BINARY_FRAME_DATA, b"hello"))
            .await;
        channel
            .handle_frame(&build_binary_frame(9, BINARY_FRAME_END, &[]))
            .await;
        let body = channel
            .receive(FrameBodyDescriptor {
                stream_id: 9,
                length: Some(5),
            })
            .expect("incoming body");
        assert_eq!(body.read_all(8).await.expect("body bytes"), b"hello");
    }

    #[tokio::test]
    async fn dropping_incoming_body_notifies_sender() {
        let sent = Arc::new(StdMutex::new(Vec::new()));
        let channel = channel(sent.clone());
        let body = channel
            .receive(FrameBodyDescriptor {
                stream_id: 7,
                length: None,
            })
            .expect("incoming body");
        drop(body);
        tokio::task::yield_now().await;
        let frames = sent.lock().expect("sent frames");
        let (_, flags, _) = parse_binary_frame(&frames[0]).expect("cancel frame");
        assert_eq!(flags, BINARY_FRAME_CANCEL | BINARY_FRAME_END);
    }

    #[tokio::test]
    async fn cancelled_stream_discards_late_chunks_without_orphan_buffering() {
        let sent = Arc::new(StdMutex::new(Vec::new()));
        let channel = channel(sent.clone());
        let mut body = channel
            .receive(FrameBodyDescriptor {
                stream_id: 17,
                length: None,
            })
            .expect("incoming body");
        body.cancel("caller stopped reading");
        channel
            .handle_frame(&build_binary_frame(17, BINARY_FRAME_DATA, b"late"))
            .await;
        channel
            .handle_frame(&build_binary_frame(17, BINARY_FRAME_END, &[]))
            .await;
        {
            let state = channel.state.lock().expect("body state");
            assert!(!state.orphans.contains_key(&17));
            assert!(!state.ignored.contains(&17));
        }
        tokio::task::yield_now().await;
        let frames = sent.lock().expect("sent frames");
        assert_eq!(frames.len(), 1);
    }

    #[tokio::test]
    async fn closing_channel_terminates_active_incoming_body() {
        let sent = Arc::new(StdMutex::new(Vec::new()));
        let channel = channel(sent);
        let mut body = channel
            .receive(FrameBodyDescriptor {
                stream_id: 18,
                length: None,
            })
            .expect("incoming body");
        channel.close("transport disconnected");
        assert_eq!(
            body.recv().await.expect_err("closed body"),
            BodyError::Closed("transport disconnected".to_string())
        );
    }

    #[tokio::test]
    async fn closing_channel_reports_error_after_buffered_data() {
        let sent = Arc::new(StdMutex::new(Vec::new()));
        let channel = channel(sent);
        let body = channel
            .receive(FrameBodyDescriptor {
                stream_id: 19,
                length: Some(6),
            })
            .expect("incoming body");
        channel
            .handle_frame(&build_binary_frame(19, BINARY_FRAME_DATA, b"one"))
            .await;

        channel.close("transport disconnected");

        assert_eq!(
            body.read_all(8).await.expect_err("truncated body"),
            BodyError::Closed("transport disconnected".to_string())
        );
    }

    #[tokio::test]
    async fn dropped_body_controls_remain_bounded_behind_a_stalled_transport() {
        let limits = BinaryBodyLimits {
            max_active_streams: 2,
            ..BinaryBodyLimits::default()
        };
        let channel = BinaryBodyChannel::new(limits, |_frame| async {
            std::future::pending::<Result<(), BodyError>>().await
        })
        .expect("body channel");

        for _ in 0..100 {
            drop(
                channel
                    .prepare(BinaryBody::from_bytes(Vec::new()))
                    .expect("dropped body releases its stream slot"),
            );
        }
        tokio::task::yield_now().await;

        assert!(channel
            .state
            .lock()
            .expect("body state")
            .outgoing
            .is_empty());
        assert!(channel.control_tx.capacity() < 2);
        channel.close("test complete");
    }

    #[tokio::test]
    async fn small_frames_within_the_window_are_all_buffered() {
        let sent = Arc::new(StdMutex::new(Vec::new()));
        let channel = channel(sent.clone());
        let body = channel
            .receive(FrameBodyDescriptor {
                stream_id: 11,
                length: Some(64 * 1024),
            })
            .expect("incoming body");
        // A 4 MiB window of 1 KiB frames used to overflow the fixed frame queue.
        for _ in 0..64 {
            channel
                .handle_frame(&build_binary_frame(11, BINARY_FRAME_DATA, &[7_u8; 1024]))
                .await;
        }
        channel
            .handle_frame(&build_binary_frame(11, BINARY_FRAME_END, &[]))
            .await;
        assert_eq!(
            body.read_all(64 * 1024).await.expect("body bytes").len(),
            64 * 1024
        );
        assert!(sent.lock().expect("sent frames").is_empty());
    }

    #[tokio::test]
    async fn registered_body_drains_between_ready_frames() {
        let sent = Arc::new(StdMutex::new(Vec::new()));
        let channel = BinaryBodyChannel::new(BinaryBodyLimits::default(), {
            let sent = sent.clone();
            move |frame| {
                let sent = sent.clone();
                async move {
                    sent.lock().expect("sent frames").push(frame);
                    Ok(())
                }
            }
        })
        .expect("body channel");
        let body = channel
            .receive(FrameBodyDescriptor {
                stream_id: 12,
                length: Some(6),
            })
            .expect("incoming body");
        let reading = tokio::spawn(async move { body.read_all(6).await });

        channel
            .handle_frame(&build_binary_frame(12, BINARY_FRAME_DATA, b"one"))
            .await;
        channel
            .handle_frame(&build_binary_frame(12, BINARY_FRAME_DATA, b"two"))
            .await;
        channel
            .handle_frame(&build_binary_frame(12, BINARY_FRAME_END, &[]))
            .await;

        assert_eq!(
            reading.await.expect("reader task").expect("body bytes"),
            b"onetwo"
        );
        assert!(sent.lock().expect("sent frames").is_empty());
    }

    #[tokio::test]
    async fn outgoing_body_stalls_until_the_receiver_grants_a_window() {
        let sent = Arc::new(StdMutex::new(Vec::new()));
        let limits = BinaryBodyLimits {
            chunk_bytes: 2,
            initial_window_bytes: 4,
            idle_timeout: Duration::from_secs(5),
            ..BinaryBodyLimits::default()
        };
        let channel = BinaryBodyChannel::new(limits, {
            let sent = sent.clone();
            move |frame| {
                let sent = sent.clone();
                async move {
                    sent.lock().expect("sent frames").push(frame);
                    Ok(())
                }
            }
        })
        .expect("body channel");
        let outgoing = channel
            .prepare(BinaryBody::from_bytes(b"hello!".to_vec()))
            .expect("outgoing body");
        let stream_id = outgoing.descriptor().stream_id;
        let sending = tokio::spawn(outgoing.send());
        for _ in 0..8 {
            tokio::task::yield_now().await;
        }
        assert_eq!(sent.lock().expect("sent frames").len(), 2);
        assert!(!sending.is_finished());

        channel
            .handle_frame(&build_window_frame(stream_id, 8))
            .await;
        sending
            .await
            .expect("send task")
            .expect("send completes once credit arrives");
        let frames = sent.lock().expect("sent frames");
        let parsed = frames
            .iter()
            .map(|frame| parse_binary_frame(frame).expect("binary frame"))
            .collect::<Vec<_>>();
        assert_eq!(parsed[2], (stream_id, BINARY_FRAME_DATA, b"o!".to_vec()));
        assert_eq!(parsed[3], (stream_id, BINARY_FRAME_END, Vec::new()));
    }

    #[tokio::test]
    async fn outgoing_body_fails_when_no_window_arrives() {
        let limits = BinaryBodyLimits {
            chunk_bytes: 2,
            initial_window_bytes: 2,
            idle_timeout: Duration::from_millis(20),
            ..BinaryBodyLimits::default()
        };
        let channel =
            BinaryBodyChannel::new(limits, |_frame| async { Ok(()) }).expect("body channel");
        let outgoing = channel
            .prepare(BinaryBody::from_bytes(b"hello!".to_vec()))
            .expect("outgoing body");
        let stream_id = outgoing.descriptor().stream_id;
        assert_eq!(
            outgoing.send().await.expect_err("stalled send"),
            BodyError::TimedOut(stream_id)
        );
    }

    #[tokio::test]
    async fn incoming_body_grants_credit_as_the_consumer_drains() {
        let sent = Arc::new(StdMutex::new(Vec::new()));
        let limits = BinaryBodyLimits {
            window_bytes: 4,
            initial_window_bytes: 4,
            ..BinaryBodyLimits::default()
        };
        let channel = BinaryBodyChannel::new(limits, {
            let sent = sent.clone();
            move |frame| {
                let sent = sent.clone();
                async move {
                    sent.lock().expect("sent frames").push(frame);
                    Ok(())
                }
            }
        })
        .expect("body channel");
        let mut body = channel
            .receive(FrameBodyDescriptor {
                stream_id: 21,
                length: None,
            })
            .expect("incoming body");
        channel
            .handle_frame(&build_binary_frame(21, BINARY_FRAME_DATA, b"ab"))
            .await;
        channel
            .handle_frame(&build_binary_frame(21, BINARY_FRAME_DATA, b"cd"))
            .await;
        assert_eq!(
            body.recv().await.expect("first chunk"),
            Some(b"ab".to_vec())
        );
        {
            let frames = sent.lock().expect("sent frames");
            let (stream_id, flags, payload) = parse_binary_frame(&frames[0]).expect("window frame");
            assert_eq!((stream_id, flags), (21, BINARY_FRAME_WINDOW));
            assert_eq!(parse_window_credit(&payload), Some(2));
        }
        // Data beyond the granted window is a protocol violation.
        channel
            .handle_frame(&build_binary_frame(21, BINARY_FRAME_DATA, b"efghi"))
            .await;
        assert_eq!(
            body.recv().await.expect("second chunk"),
            Some(b"cd".to_vec())
        );
        assert!(body.recv().await.is_err());
    }

    #[test]
    fn acceptor_channels_allocate_even_stream_ids() {
        let acceptor = BinaryBodyChannel::new(
            BinaryBodyLimits {
                role: BinaryBodyRole::Acceptor,
                ..BinaryBodyLimits::default()
            },
            |_frame| async { Ok(()) },
        )
        .expect("body channel");
        let initiator =
            BinaryBodyChannel::new(BinaryBodyLimits::default(), |_frame| async { Ok(()) })
                .expect("body channel");
        let ids = |channel: &BinaryBodyChannel| {
            (0..3)
                .map(|_| {
                    channel
                        .prepare(BinaryBody::from_bytes(Vec::new()))
                        .expect("outgoing body")
                        .descriptor()
                        .stream_id
                })
                .collect::<Vec<_>>()
        };
        assert_eq!(ids(&acceptor), vec![2, 4, 6]);
        assert_eq!(ids(&initiator), vec![1, 3, 5]);
    }

    #[test]
    fn protocol_descriptor_matches_typescript_wire_shape() {
        let descriptor = FrameBodyDescriptor {
            stream_id: 41,
            length: Some(3),
        };
        assert_eq!(
            serde_json::to_value(descriptor).expect("descriptor"),
            serde_json::json!({ "streamId": 41, "length": 3 })
        );
    }
}
