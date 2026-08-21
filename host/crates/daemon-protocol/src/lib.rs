//! Versioned, same-user control protocol for the local `gsvd` process.
//!
//! This is deliberately not a general RPC channel. It exposes only redacted
//! health, configuration reload, reconnect, diagnostics, and graceful
//! shutdown. Gateway frames, credentials, file contents, and media never cross
//! this boundary.

mod client;
mod codec;
mod endpoint;
mod error;
mod protocol;
mod server;
mod transport;

pub use client::{ClientOptions, DaemonControlClient};
pub use endpoint::DaemonControlEndpoint;
pub use error::{EndpointSafety, Error, TimeoutStage};
pub use protocol::{
    Command, DaemonPhase, DaemonStatus, DiagnosticLevel, DiagnosticNotice, Diagnostics, ErrorCode,
    OperationShapeError, RequestId, Success, MAX_DIAGNOSTIC_NOTICES, MAX_FRAME_BYTES,
    PROTOCOL_VERSION,
};
pub use server::{
    DaemonControlHandler, DaemonControlServer, OperationError, RequestContext, ServerOptions,
};

#[cfg(not(any(unix, windows)))]
compile_error!("daemon-protocol supports Unix domain sockets and Windows named pipes");
