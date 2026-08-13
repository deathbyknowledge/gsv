use std::{future::Future, num::NonZeroUsize, sync::Arc, time::Duration};

use async_trait::async_trait;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::Semaphore,
    task::JoinSet,
};

use crate::{
    codec,
    protocol::{Request, Response},
    transport::BoundListener,
    Command, DesktopControlEndpoint, DesktopStatus, Error, ErrorCode, MicrophoneName,
    MicrophoneStatus, OperationError, ProcessId, Success, TimeoutStage, PROTOCOL_VERSION,
};

#[derive(Clone, Debug)]
pub struct ServerOptions {
    max_concurrent_connections: NonZeroUsize,
    io_timeout: Duration,
    operation_timeout: Duration,
}

impl ServerOptions {
    #[must_use]
    pub fn with_max_concurrent_connections(mut self, value: NonZeroUsize) -> Self {
        self.max_concurrent_connections = value;
        self
    }

    #[must_use]
    pub fn with_io_timeout(mut self, value: Duration) -> Self {
        self.io_timeout = value;
        self
    }

    #[must_use]
    pub fn with_operation_timeout(mut self, value: Duration) -> Self {
        self.operation_timeout = value;
        self
    }
}

impl Default for ServerOptions {
    fn default() -> Self {
        Self {
            max_concurrent_connections: NonZeroUsize::new(16)
                .expect("the default connection limit is nonzero"),
            io_timeout: Duration::from_secs(3),
            operation_timeout: Duration::from_secs(10),
        }
    }
}

#[async_trait]
pub trait DesktopControlHandler: Send + Sync + 'static {
    async fn activate(&self, request: RequestContext) -> Result<(), OperationError>;

    async fn status(&self, request: RequestContext) -> Result<DesktopStatus, OperationError>;

    async fn new_conversation(&self, request: RequestContext) -> Result<ProcessId, OperationError>;

    async fn use_process(
        &self,
        request: RequestContext,
        process_id: ProcessId,
    ) -> Result<ProcessId, OperationError>;

    async fn microphone_list(
        &self,
        request: RequestContext,
    ) -> Result<MicrophoneStatus, OperationError>;

    async fn microphone_use(
        &self,
        request: RequestContext,
        name: MicrophoneName,
    ) -> Result<MicrophoneStatus, OperationError>;

    async fn microphone_default(
        &self,
        request: RequestContext,
    ) -> Result<MicrophoneStatus, OperationError>;
}

/// Correlation and cancellation state for one accepted Desktop operation.
///
/// A bridge that queues work onto the UI thread must carry this value with the
/// queued operation and check [`Self::is_cancelled`] immediately before
/// mutating Desktop state. It becomes cancelled when the client disconnects,
/// the handler times out, or the server shuts down.
#[derive(Clone, Debug)]
pub struct RequestContext {
    request_id: crate::RequestId,
    cancellation: tokio_util::sync::CancellationToken,
}

impl RequestContext {
    fn new(request_id: crate::RequestId) -> Self {
        Self {
            request_id,
            cancellation: tokio_util::sync::CancellationToken::new(),
        }
    }

    #[must_use]
    pub fn request_id(&self) -> crate::RequestId {
        self.request_id
    }

    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        self.cancellation.is_cancelled()
    }

    /// Wait until the peer disconnects, the operation times out, or the
    /// server shuts down. Application-owned I/O should race this future so a
    /// cancelled local request cannot keep the UI in a pending state.
    pub async fn cancelled(&self) {
        self.cancellation.cancelled().await;
    }

    fn cancel(&self) {
        self.cancellation.cancel();
    }
}

struct RequestCancellationGuard(RequestContext);

impl Drop for RequestCancellationGuard {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

pub struct DesktopControlServer<H> {
    listener: BoundListener,
    handler: Arc<H>,
    options: ServerOptions,
}

impl<H> DesktopControlServer<H>
where
    H: DesktopControlHandler,
{
    pub fn bind(
        endpoint: &DesktopControlEndpoint,
        handler: H,
        options: ServerOptions,
    ) -> Result<Self, Error> {
        Ok(Self {
            listener: BoundListener::bind(endpoint)?,
            handler: Arc::new(handler),
            options,
        })
    }

    /// Serves requests until `shutdown` resolves.
    ///
    /// All accepted request tasks are cancelled and joined before this method
    /// returns, so no handler owned by the server remains detached afterward.
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
                permit = Arc::clone(&semaphore).acquire_owned() => {
                    match permit {
                        Ok(permit) => permit,
                        Err(_) => break,
                    }
                }
            };

            let stream = tokio::select! {
                () = &mut shutdown => {
                    drop(permit);
                    break;
                }
                accepted = listener.accept() => {
                    match accepted {
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
                }
            };

            let request_handler = Arc::clone(&handler);
            let request_options = options.clone();
            tasks.spawn(async move {
                let _permit = permit;
                let _ = serve_connection(stream, request_handler.as_ref(), &request_options).await;
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
    H: DesktopControlHandler,
{
    let request: Request = timeout_result(
        options.io_timeout,
        TimeoutStage::Read,
        codec::read_json(&mut stream),
    )
    .await?;

    let response = if request.protocol_version == PROTOCOL_VERSION {
        let request_context = RequestContext::new(request.request_id);
        let cancellation_guard = RequestCancellationGuard(request_context.clone());
        let mut extra_byte = [0_u8; 1];
        let response = tokio::select! {
            response = dispatch(
                request,
                handler,
                options.operation_timeout,
                request_context.clone(),
            ) => response,
            peer = stream.read(&mut extra_byte) => {
                request_context.cancel();
                return match peer {
                    Ok(0) => Err(Error::PeerDisconnected),
                    Ok(_) => Err(Error::UnexpectedClientData),
                    Err(error) => Err(Error::Io(error)),
                };
            }
        };
        drop(cancellation_guard);
        response
    } else {
        Response::error(request.request_id, ErrorCode::UnsupportedVersion)
    };

    timeout_result(
        options.io_timeout,
        TimeoutStage::Write,
        codec::write_json(&mut stream, &response),
    )
    .await?;
    timeout_result(options.io_timeout, TimeoutStage::Write, stream.shutdown()).await
}

async fn dispatch<H>(
    request: Request,
    handler: &H,
    timeout: Duration,
    request_context: RequestContext,
) -> Response
where
    H: DesktopControlHandler,
{
    let request_id = request.request_id;
    let operation = async {
        match request.command {
            Command::Activate => handler
                .activate(request_context.clone())
                .await
                .map(|()| Success::Activated),
            Command::Status => handler
                .status(request_context.clone())
                .await
                .map(|status| Success::Status { status }),
            Command::New => handler
                .new_conversation(request_context.clone())
                .await
                .map(|process_id| Success::Created { process_id }),
            Command::Use { process_id } => handler
                .use_process(request_context.clone(), process_id)
                .await
                .map(|process_id| Success::Selected { process_id }),
            Command::MicrophoneList => handler
                .microphone_list(request_context.clone())
                .await
                .map(|status| Success::MicrophonesListed { status }),
            Command::MicrophoneUse { name } => handler
                .microphone_use(request_context.clone(), name)
                .await
                .map(|status| Success::MicrophoneSelected { status }),
            Command::MicrophoneDefault => handler
                .microphone_default(request_context.clone())
                .await
                .map(|status| Success::DefaultMicrophoneSelected { status }),
        }
    };

    match tokio::time::timeout(timeout, operation).await {
        Ok(Ok(success)) => Response::success(request_id, success),
        Ok(Err(error)) => Response::error(request_id, error.into()),
        Err(_) => {
            request_context.cancel();
            Response::error(request_id, ErrorCode::Timeout)
        }
    }
}

async fn timeout_result<T, E, F>(
    duration: Duration,
    stage: TimeoutStage,
    operation: F,
) -> Result<T, Error>
where
    F: Future<Output = Result<T, E>>,
    Error: From<E>,
{
    tokio::time::timeout(duration, operation)
        .await
        .map_err(|_| Error::Timeout { stage, duration })?
        .map_err(Error::from)
}

#[cfg(test)]
mod tests {
    use tokio::io::{duplex, AsyncReadExt, AsyncWriteExt};

    use super::*;
    use crate::{
        protocol::Outcome, GatewayState, MicrophoneDevice, MicrophoneSelection, RequestId,
        WindowState,
    };

    struct Handler;

    #[async_trait]
    impl DesktopControlHandler for Handler {
        async fn activate(&self, _request: RequestContext) -> Result<(), OperationError> {
            Ok(())
        }

        async fn status(&self, _request: RequestContext) -> Result<DesktopStatus, OperationError> {
            Ok(DesktopStatus {
                gateway: GatewayState::Connected,
                window: WindowState::Focused,
                selected_process: None,
            })
        }

        async fn new_conversation(
            &self,
            _request: RequestContext,
        ) -> Result<ProcessId, OperationError> {
            ProcessId::new("new-process").map_err(|_| OperationError::Internal)
        }

        async fn use_process(
            &self,
            _request: RequestContext,
            process_id: ProcessId,
        ) -> Result<ProcessId, OperationError> {
            Ok(process_id)
        }

        async fn microphone_list(
            &self,
            _request: RequestContext,
        ) -> Result<MicrophoneStatus, OperationError> {
            microphone_status(MicrophoneSelection::Ask)
        }

        async fn microphone_use(
            &self,
            _request: RequestContext,
            name: MicrophoneName,
        ) -> Result<MicrophoneStatus, OperationError> {
            microphone_status(MicrophoneSelection::Device { name })
        }

        async fn microphone_default(
            &self,
            _request: RequestContext,
        ) -> Result<MicrophoneStatus, OperationError> {
            microphone_status(MicrophoneSelection::SystemDefault)
        }
    }

    fn microphone_status(
        selected: MicrophoneSelection,
    ) -> Result<MicrophoneStatus, OperationError> {
        MicrophoneStatus::new(
            vec![MicrophoneDevice {
                name: MicrophoneName::new("Built-in Microphone")
                    .map_err(|_| OperationError::Internal)?,
                is_default: true,
            }],
            selected,
            None,
        )
        .map_err(|_| OperationError::Internal)
    }

    #[tokio::test]
    async fn unsupported_versions_are_correlated_and_do_not_reach_the_handler() {
        let (mut client, server) = duplex(4096);
        let request_id = RequestId::new();
        let request = Request {
            protocol_version: PROTOCOL_VERSION + 1,
            request_id,
            command: Command::Activate,
        };
        let options = ServerOptions::default();
        let server_task = tokio::spawn(async move {
            serve_connection(server, &Handler, &options)
                .await
                .expect("server handles request");
        });

        codec::write_json(&mut client, &request)
            .await
            .expect("request writes");
        let response: Response = codec::read_json(&mut client).await.expect("response reads");
        assert_eq!(response.request_id, request_id);
        assert_eq!(
            response.outcome,
            Outcome::Error {
                code: ErrorCode::UnsupportedVersion
            }
        );
        server_task.await.expect("server task joins");
    }

    #[tokio::test]
    async fn oversized_input_is_rejected_without_a_response() {
        let (mut client, server) = duplex(4096);
        let options = ServerOptions::default();
        let server_task =
            tokio::spawn(async move { serve_connection(server, &Handler, &options).await });

        client
            .write_u32((crate::MAX_FRAME_BYTES + 1) as u32)
            .await
            .expect("header writes");
        client.shutdown().await.expect("client write closes");

        let mut byte = [0_u8; 1];
        assert_eq!(client.read(&mut byte).await.expect("server closes"), 0);
        assert!(matches!(
            server_task.await.expect("server joins"),
            Err(Error::FrameTooLarge { .. })
        ));
    }

    #[tokio::test]
    async fn cancellation_wakes_application_io_without_a_missed_signal() {
        let context = RequestContext::new(RequestId::new());
        let waiter = context.clone();
        let task = tokio::spawn(async move { waiter.cancelled().await });
        tokio::task::yield_now().await;
        context.cancel();
        tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .expect("cancellation wakes promptly")
            .expect("wait task joins");

        tokio::time::timeout(Duration::from_secs(1), context.cancelled())
            .await
            .expect("late waiter observes cancellation");
    }
}
