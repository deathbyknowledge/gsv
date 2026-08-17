//! Versioned, same-user local control protocol for GSV Desktop.
//!
//! This crate intentionally does not expose a general RPC mechanism. It only
//! permits activating Desktop, reading a redacted status, creating or selecting
//! a conversation, and inspecting or selecting a local microphone. Explicit
//! microphone names are limited to those microphone operations and never enter
//! the general [`DesktopStatus`]. Gateway credentials, user content, drafts,
//! attachment paths, and approval details do not belong on this boundary.

mod client;
mod codec;
mod endpoint;
mod error;
mod protocol;
mod server;
mod transport;

pub use client::{ClientOptions, DesktopControlClient};
pub use endpoint::DesktopControlEndpoint;
pub use error::{EndpointSafety, Error, TimeoutStage};
pub use protocol::{
    Command, DesktopStatus, ErrorCode, GatewayState, InvalidMicrophoneName,
    InvalidMicrophoneStatus, InvalidProcessId, MicrophoneDevice, MicrophoneEnvironmentOverride,
    MicrophoneName, MicrophoneSelection, MicrophoneStatus, OperationError, ProcessId, RequestId,
    Success, WindowState, MAX_FRAME_BYTES, MAX_MICROPHONE_DEVICES, PROTOCOL_VERSION,
};
pub use server::{DesktopControlHandler, DesktopControlServer, RequestContext, ServerOptions};

#[cfg(not(any(unix, windows)))]
compile_error!("gsv-desktop-control supports Unix domain sockets and Windows named pipes");
