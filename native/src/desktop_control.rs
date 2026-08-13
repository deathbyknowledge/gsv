use gsv_desktop_control::{
    DesktopControlHandler, DesktopStatus, OperationError, ProcessId, RequestContext,
};
use tokio::sync::{mpsc, oneshot};

use crate::client::ClientEvent;

/// A deliberately narrow handoff from the same-user IPC server to Desktop's
/// UI owner. The request context travels all the way to the mutation boundary;
/// a request whose peer disappeared must never mutate Desktop later.
#[derive(Debug)]
pub enum DesktopControlRequest {
    Activate {
        context: RequestContext,
        response: oneshot::Sender<Result<(), OperationError>>,
    },
    Status {
        context: RequestContext,
        response: oneshot::Sender<Result<DesktopStatus, OperationError>>,
    },
    New {
        context: RequestContext,
        response: oneshot::Sender<Result<ProcessId, OperationError>>,
    },
    Use {
        context: RequestContext,
        process_id: ProcessId,
        response: oneshot::Sender<Result<ProcessId, OperationError>>,
    },
}

#[derive(Clone)]
pub struct NativeDesktopControlHandler {
    events: mpsc::UnboundedSender<ClientEvent>,
}

impl NativeDesktopControlHandler {
    pub fn new(events: mpsc::UnboundedSender<ClientEvent>) -> Self {
        Self { events }
    }

    async fn dispatch<T>(
        &self,
        build: impl FnOnce(oneshot::Sender<Result<T, OperationError>>) -> DesktopControlRequest,
    ) -> Result<T, OperationError> {
        let (response, receiver) = oneshot::channel();
        self.events
            .send(ClientEvent::DesktopControl(build(response)))
            .map_err(|_| OperationError::Unavailable)?;
        receiver.await.unwrap_or(Err(OperationError::Unavailable))
    }
}

#[async_trait::async_trait]
impl DesktopControlHandler for NativeDesktopControlHandler {
    async fn activate(&self, context: RequestContext) -> Result<(), OperationError> {
        self.dispatch(|response| DesktopControlRequest::Activate { context, response })
            .await
    }

    async fn status(&self, context: RequestContext) -> Result<DesktopStatus, OperationError> {
        self.dispatch(|response| DesktopControlRequest::Status { context, response })
            .await
    }

    async fn new_conversation(&self, context: RequestContext) -> Result<ProcessId, OperationError> {
        self.dispatch(|response| DesktopControlRequest::New { context, response })
            .await
    }

    async fn use_process(
        &self,
        context: RequestContext,
        process_id: ProcessId,
    ) -> Result<ProcessId, OperationError> {
        self.dispatch(|response| DesktopControlRequest::Use {
            context,
            process_id,
            response,
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use gsv_desktop_control::{
        ClientOptions, DesktopControlClient, DesktopControlEndpoint, DesktopControlServer, Error,
        ErrorCode, ServerOptions,
    };

    use super::*;

    #[cfg(unix)]
    fn endpoint() -> (tempfile::TempDir, DesktopControlEndpoint) {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::TempDir::new().expect("temp directory");
        let private = temp.path().join("private");
        std::fs::create_dir(&private).expect("private directory");
        std::fs::set_permissions(&private, std::fs::Permissions::from_mode(0o700))
            .expect("private permissions");
        let endpoint = DesktopControlEndpoint::from_path(private.join("desktop.sock"));
        (temp, endpoint)
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn dropped_client_cancels_before_a_queued_ui_mutation() -> Result<(), String> {
        let (_temp, endpoint) = endpoint();
        let (events, mut requests) = mpsc::unbounded_channel();
        let server = DesktopControlServer::bind(
            &endpoint,
            NativeDesktopControlHandler::new(events),
            ServerOptions::default().with_operation_timeout(Duration::from_secs(2)),
        )
        .expect("server binds");
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        let server_task = tokio::spawn(server.run_until(async move {
            let _ = shutdown_rx.await;
        }));
        let client = DesktopControlClient::new(
            endpoint,
            ClientOptions::default().with_response_timeout(Duration::from_millis(30)),
        );

        assert!(matches!(
            client.new_conversation().await,
            Err(Error::Timeout { .. })
        ));
        let ClientEvent::DesktopControl(DesktopControlRequest::New { context, response }) =
            requests
                .recv()
                .await
                .ok_or_else(|| "request was not queued".to_string())?
        else {
            return Err("expected a new-conversation request".to_string());
        };
        tokio::time::timeout(Duration::from_secs(1), async {
            while !context.is_cancelled() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("server cancellation propagates");
        assert!(context.is_cancelled());
        assert!(response
            .send(Ok(ProcessId::new("late").expect("pid")))
            .is_err());

        let _ = shutdown_tx.send(());
        server_task
            .await
            .expect("server task joins")
            .expect("server exits");
        Ok(())
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn invalid_process_result_is_a_redacted_protocol_error() -> Result<(), String> {
        let (_temp, endpoint) = endpoint();
        let (events, mut requests) = mpsc::unbounded_channel();
        let server = DesktopControlServer::bind(
            &endpoint,
            NativeDesktopControlHandler::new(events),
            ServerOptions::default(),
        )
        .expect("server binds");
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        let server_task = tokio::spawn(server.run_until(async move {
            let _ = shutdown_rx.await;
        }));
        let responder = tokio::spawn(async move {
            let ClientEvent::DesktopControl(DesktopControlRequest::Use { response, .. }) =
                requests.recv().await.ok_or("request was not queued")?
            else {
                return Err("expected a use-process request");
            };
            let _ = response.send(Err(OperationError::ProcessNotFound));
            Ok::<(), &str>(())
        });
        let client = DesktopControlClient::new(endpoint, ClientOptions::default());
        let result = client
            .use_process(ProcessId::new("missing").expect("pid"))
            .await;
        assert!(matches!(
            result,
            Err(Error::Remote(ErrorCode::ProcessNotFound))
        ));

        responder
            .await
            .map_err(|error| error.to_string())?
            .map_err(str::to_string)?;
        let _ = shutdown_tx.send(());
        server_task
            .await
            .expect("server task joins")
            .expect("server exits");
        Ok(())
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn status_crosses_only_the_redacted_contract() -> Result<(), String> {
        let (_temp, endpoint) = endpoint();
        let (events, mut requests) = mpsc::unbounded_channel();
        let server = DesktopControlServer::bind(
            &endpoint,
            NativeDesktopControlHandler::new(events),
            ServerOptions::default(),
        )
        .expect("server binds");
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        let server_task = tokio::spawn(server.run_until(async move {
            let _ = shutdown_rx.await;
        }));
        let responder = tokio::spawn(async move {
            let ClientEvent::DesktopControl(DesktopControlRequest::Status { response, .. }) =
                requests.recv().await.ok_or("request was not queued")?
            else {
                return Err("expected a status request");
            };
            let _ = response.send(Ok(DesktopStatus {
                gateway: gsv_desktop_control::GatewayState::Connected,
                window: gsv_desktop_control::WindowState::Focused,
                selected_process: Some(ProcessId::new("proc-7").map_err(|_| "invalid pid")?),
            }));
            Ok::<(), &str>(())
        });
        let client = DesktopControlClient::new(endpoint, ClientOptions::default());
        let status = client.status().await.map_err(|error| error.to_string())?;
        assert_eq!(
            status.selected_process.as_ref().map(ProcessId::as_str),
            Some("proc-7")
        );
        let serialized = serde_json::to_value(&status).map_err(|error| error.to_string())?;
        let object = serialized
            .as_object()
            .ok_or_else(|| "status was not an object".to_string())?;
        assert_eq!(object.len(), 3);
        assert!(object.contains_key("gateway"));
        assert!(object.contains_key("window"));
        assert!(object.contains_key("selectedProcess"));

        responder
            .await
            .map_err(|error| error.to_string())?
            .map_err(str::to_string)?;
        let _ = shutdown_tx.send(());
        server_task
            .await
            .expect("server task joins")
            .expect("server exits");
        Ok(())
    }
}
