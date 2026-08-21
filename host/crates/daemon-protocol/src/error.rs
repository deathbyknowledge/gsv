use std::{io, time::Duration};

use crate::ErrorCode;

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum EndpointSafety {
    #[error("endpoint parent is a symbolic link")]
    ParentIsSymlink,
    #[error("endpoint parent is not a directory")]
    ParentNotDirectory,
    #[error("endpoint parent belongs to another user")]
    ParentWrongOwner,
    #[error("endpoint parent permissions are not private")]
    ParentNotPrivate,
    #[error("endpoint is a symbolic link")]
    EndpointIsSymlink,
    #[error("endpoint is not a local IPC object")]
    EndpointWrongType,
    #[error("endpoint belongs to another user")]
    EndpointWrongOwner,
    #[error("endpoint permissions are not private")]
    EndpointNotPrivate,
    #[error("endpoint instance lock is a symbolic link")]
    LockIsSymlink,
    #[error("endpoint instance lock is not a regular file")]
    LockWrongType,
    #[error("endpoint instance lock belongs to another user")]
    LockWrongOwner,
    #[error("endpoint instance lock permissions are not private")]
    LockNotPrivate,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum TimeoutStage {
    #[error("connecting")]
    Connect,
    #[error("reading an IPC frame")]
    Read,
    #[error("writing an IPC frame")]
    Write,
    #[error("waiting for gsvd")]
    Handler,
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("gsvd is already running")]
    AlreadyRunning,
    #[error("unsafe gsvd control endpoint: {0}")]
    UnsafeEndpoint(EndpointSafety),
    #[error("gsvd control peer is not the current user")]
    PeerIdentity,
    #[error("gsvd control frame is empty")]
    EmptyFrame,
    #[error("gsvd control frame is {actual} bytes; maximum is {maximum}")]
    FrameTooLarge { actual: usize, maximum: usize },
    #[error("malformed gsvd control frame")]
    MalformedFrame(#[source] serde_json::Error),
    #[error("gsvd control protocol version {actual} is unsupported; expected {expected}")]
    UnsupportedVersion { actual: u16, expected: u16 },
    #[error("gsvd control response did not match its request")]
    UnexpectedResponse,
    #[error("gsvd control peer disconnected before the operation completed")]
    PeerDisconnected,
    #[error("gsvd control peer sent more than one request on a connection")]
    UnexpectedClientData,
    #[error("gsvd control operation timed out while {stage} after {duration:?}")]
    Timeout {
        stage: TimeoutStage,
        duration: Duration,
    },
    #[error("gsvd rejected the request: {0:?}")]
    Remote(ErrorCode),
    #[error("gsvd control I/O failed")]
    Io(#[source] io::Error),
}

impl From<io::Error> for Error {
    fn from(value: io::Error) -> Self {
        Self::Io(value)
    }
}
