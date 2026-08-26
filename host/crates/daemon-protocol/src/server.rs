use std::{future::Future, num::NonZeroUsize, sync::Arc, time::Duration};

use async_trait::async_trait;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::Semaphore,
    task::JoinSet,
};
use tokio_util::sync::CancellationToken;

use crate::{
    codec,
    protocol::{Request, Response},
    transport::BoundListener,
    Command, DaemonControlEndpoint, DaemonStatus, Diagnostics, Error, ErrorCode, RequestId,
    Success, TimeoutStage, PROTOCOL_VERSION,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OperationError {
    Busy,
    InvalidConfiguration,
    Internal,
}

impl From<OperationError> for ErrorCode {
    fn from(value: OperationError) -> Self {
        match value {
            OperationError::Busy => Self::Busy,
            OperationError::InvalidConfiguration => Self::InvalidConfiguration,
            OperationError::Internal => Self::Internal,
        }
    }
}

#[derive(Clone, Debug)]
pub struct RequestContext {
    request_id: RequestId,
    cancellation: CancellationToken,
}

impl RequestContext {
    fn new(request_id: RequestId) -> Self {
        Self {
            request_id,
            cancellation: CancellationToken::new(),
        }
    }

    #[must_use]
    pub fn request_id(&self) -> RequestId {
        self.request_id
    }

    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        self.cancellation.is_cancelled()
    }

    pub async fn cancelled(&self) {
        self.cancellation.cancelled().await;
    }
}

struct CancellationGuard(RequestContext);

impl Drop for CancellationGuard {
    fn drop(&mut self) {
        self.0.cancellation.cancel();
    }
}

#[async_trait]
pub trait DaemonControlHandler: Send + Sync + 'static {
    async fn status(&self, request: RequestContext) -> Result<DaemonStatus, OperationError>;
    async fn reload(&self, request: RequestContext) -> Result<(), OperationError>;
    async fn reconnect(&self, request: RequestContext) -> Result<(), OperationError>;
    async fn diagnostics(&self, request: RequestContext) -> Result<Diagnostics, OperationError>;
    async fn shutdown(&self, request: RequestContext) -> Result<(), OperationError>;
}

#[derive(Clone, Debug)]
pub struct ServerOptions {
    max_concurrent_connections: NonZeroUsize,
    io_timeout: Duration,
    operation_timeout: Duration,
}

impl Default for ServerOptions {
    fn default() -> Self {
        Self {
            max_concurrent_connections: NonZeroUsize::new(8).expect("nonzero connection limit"),
            io_timeout: Duration::from_secs(3),
            operation_timeout: Duration::from_secs(4),
        }
    }
}

pub struct DaemonControlServer<H> {
    listener: BoundListener,
    handler: Arc<H>,
    options: ServerOptions,
}

impl<H> DaemonControlServer<H>
where
    H: DaemonControlHandler,
{
    pub fn bind(
        endpoint: &DaemonControlEndpoint,
        handler: H,
        options: ServerOptions,
    ) -> Result<Self, Error> {
        Ok(Self {
            listener: BoundListener::bind(endpoint)?,
            handler: Arc::new(handler),
            options,
        })
    }

    pub async fn run_until<F>(self, shutdown: F) -> Result<(), Error>
    where
        F: Future<Output = ()> + Send,
    {
        let Self {
            mut listener,
            handler,
            options,
        } = self;
        let semaphore = Arc::new(Semaphore::new(options.max_concurrent_connections.get()));
        let mut tasks = JoinSet::new();
        tokio::pin!(shutdown);
        loop {
            let permit = tokio::select! {
                () = &mut shutdown => break,
                permit = Arc::clone(&semaphore).acquire_owned() => match permit {
                    Ok(permit) => permit,
                    Err(_) => break,
                }
            };
            let stream = tokio::select! {
                () = &mut shutdown => {
                    drop(permit);
                    break;
                }
                accepted = listener.accept() => match accepted {
                    Ok(stream) => stream,
                    Err(Error::PeerIdentity) => {
                        drop(permit);
                        continue;
                    }
                    Err(error) => {
                        tasks.abort_all();
                        while tasks.join_next().await.is_some() {}
                        return Err(error);
                    }
                }
            };
            let handler = Arc::clone(&handler);
            let options = options.clone();
            tasks.spawn(async move {
                let _permit = permit;
                let _ = serve_connection(stream, handler.as_ref(), &options).await;
            });
            while tasks.try_join_next().is_some() {}
        }
        tasks.abort_all();
        while tasks.join_next().await.is_some() {}
        Ok(())
    }
}

async fn serve_connection<S, H>(
    mut stream: S,
    handler: &H,
    options: &ServerOptions,
) -> Result<(), Error>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
    H: DaemonControlHandler,
{
    let request: Request = timed(
        options.io_timeout,
        TimeoutStage::Read,
        codec::read_json(&mut stream),
    )
    .await?;
    let response = if request.protocol_version == PROTOCOL_VERSION {
        let context = RequestContext::new(request.request_id);
        let guard = CancellationGuard(context.clone());
        let mut extra = [0_u8; 1];
        let response = tokio::select! {
            response = dispatch(request, handler, options.operation_timeout, context.clone()) => response,
            peer = stream.read(&mut extra) => {
                context.cancellation.cancel();
                return match peer {
                    Ok(0) => Err(Error::PeerDisconnected),
                    Ok(_) => Err(Error::UnexpectedClientData),
                    Err(error) => Err(Error::Io(error)),
                };
            }
        };
        drop(guard);
        response
    } else {
        Response::error(request.request_id, ErrorCode::UnsupportedVersion)
    };
    timed(
        options.io_timeout,
        TimeoutStage::Write,
        codec::write_json(&mut stream, &response),
    )
    .await?;
    timed(options.io_timeout, TimeoutStage::Write, stream.shutdown()).await
}

async fn dispatch<H>(
    request: Request,
    handler: &H,
    timeout: Duration,
    context: RequestContext,
) -> Response
where
    H: DaemonControlHandler,
{
    let request_id = request.request_id;
    let operation = async {
        match request.command {
            Command::Status => handler
                .status(context.clone())
                .await
                .map(|status| Success::Status { status }),
            Command::Reload => handler
                .reload(context.clone())
                .await
                .map(|()| Success::ReloadAccepted),
            Command::Reconnect => handler
                .reconnect(context.clone())
                .await
                .map(|()| Success::ReconnectAccepted),
            Command::Diagnostics => handler
                .diagnostics(context.clone())
                .await
                .map(|diagnostics| Success::Diagnostics { diagnostics }),
            Command::Shutdown => handler
                .shutdown(context.clone())
                .await
                .map(|()| Success::ShutdownAccepted),
        }
    };
    match tokio::time::timeout(timeout, operation).await {
        Ok(Ok(success)) => Response::success(request_id, success),
        Ok(Err(error)) => Response::error(request_id, error.into()),
        Err(_) => {
            context.cancellation.cancel();
            Response::error(request_id, ErrorCode::Timeout)
        }
    }
}

async fn timed<T, E>(
    duration: Duration,
    stage: TimeoutStage,
    future: impl Future<Output = Result<T, E>>,
) -> Result<T, Error>
where
    Error: From<E>,
{
    tokio::time::timeout(duration, future)
        .await
        .map_err(|_| Error::Timeout { stage, duration })?
        .map_err(Error::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{DaemonPhase, DiagnosticLevel, DiagnosticNotice};
    use tokio::io::duplex;

    struct Handler;

    fn status() -> DaemonStatus {
        DaemonStatus {
            version: "1.0.0".to_string(),
            process_id: 42,
            machine_id: "machine-a".to_string(),
            phase: DaemonPhase::Connected,
            connected: true,
            uptime_seconds: 5,
            reconnect_attempt: 0,
        }
    }

    #[async_trait]
    impl DaemonControlHandler for Handler {
        async fn status(&self, _: RequestContext) -> Result<DaemonStatus, OperationError> {
            Ok(status())
        }
        async fn reload(&self, _: RequestContext) -> Result<(), OperationError> {
            Ok(())
        }
        async fn reconnect(&self, _: RequestContext) -> Result<(), OperationError> {
            Ok(())
        }
        async fn diagnostics(&self, _: RequestContext) -> Result<Diagnostics, OperationError> {
            Diagnostics::new(
                status(),
                vec![DiagnosticNotice {
                    level: DiagnosticLevel::Info,
                    code: "connected".to_string(),
                    message: "The machine is connected.".to_string(),
                }],
            )
            .map_err(|_| OperationError::Internal)
        }
        async fn shutdown(&self, _: RequestContext) -> Result<(), OperationError> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn status_round_trips_without_exposing_configuration() {
        let (mut client, server) = duplex(4096);
        let request = Request::new(Command::Status);
        let request_id = request.request_id;
        let options = ServerOptions::default();
        let task = tokio::spawn(async move {
            serve_connection(server, &Handler, &options)
                .await
                .expect("request handled")
        });
        codec::write_json(&mut client, &request)
            .await
            .expect("request writes");
        let response: Response = codec::read_json(&mut client).await.expect("response reads");
        assert_eq!(response.request_id, request_id);
        assert_eq!(
            response.outcome,
            crate::protocol::Outcome::Success {
                response: Success::Status { status: status() }
            }
        );
        task.await.expect("server joins");
    }
}
