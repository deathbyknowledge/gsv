#![cfg(unix)]

use std::{
    num::NonZeroUsize,
    os::unix::fs::PermissionsExt,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use async_trait::async_trait;
use gsv_desktop_control::{
    ClientOptions, DesktopControlClient, DesktopControlEndpoint, DesktopControlHandler,
    DesktopControlServer, DesktopStatus, Error, ErrorCode, GatewayState, MicrophoneDevice,
    MicrophoneEnvironmentOverride, MicrophoneName, MicrophoneSelection, MicrophoneStatus,
    OperationError, ProcessId, RequestContext, ServerOptions, TimeoutStage, WindowState,
    PROTOCOL_VERSION,
};
use tempfile::TempDir;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::{oneshot, Notify},
};

fn test_endpoint(temp: &TempDir) -> DesktopControlEndpoint {
    let parent = temp.path().join("control");
    std::fs::create_dir(&parent).expect("control directory created");
    std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o700))
        .expect("control directory made private");
    DesktopControlEndpoint::from_path(parent.join("desktop.sock"))
}

fn microphone_status(selected: MicrophoneSelection) -> Result<MicrophoneStatus, OperationError> {
    MicrophoneStatus::new(
        vec![
            MicrophoneDevice {
                name: MicrophoneName::new("Built-in Microphone")
                    .map_err(|_| OperationError::Internal)?,
                is_default: true,
            },
            MicrophoneDevice {
                name: MicrophoneName::new("Shure MV6").map_err(|_| OperationError::Internal)?,
                is_default: false,
            },
        ],
        selected,
        Some(MicrophoneEnvironmentOverride::Invalid),
    )
    .map_err(|_| OperationError::Internal)
}

#[derive(Default)]
struct WorkingHandler {
    activations: Arc<AtomicUsize>,
}

#[async_trait]
impl DesktopControlHandler for WorkingHandler {
    async fn activate(&self, _request: RequestContext) -> Result<(), OperationError> {
        self.activations.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    async fn status(&self, _request: RequestContext) -> Result<DesktopStatus, OperationError> {
        Ok(DesktopStatus {
            gateway: GatewayState::Connected,
            window: WindowState::Focused,
            selected_process: Some(
                ProcessId::new("proc:current").map_err(|_| OperationError::Internal)?,
            ),
        })
    }

    async fn new_conversation(
        &self,
        _request: RequestContext,
    ) -> Result<ProcessId, OperationError> {
        ProcessId::new("proc:new").map_err(|_| OperationError::Internal)
    }

    async fn use_process(
        &self,
        _request: RequestContext,
        process_id: ProcessId,
    ) -> Result<ProcessId, OperationError> {
        if process_id.as_str() == "proc:missing" {
            Err(OperationError::ProcessNotFound)
        } else {
            Ok(process_id)
        }
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

#[tokio::test]
async fn all_commands_round_trip_and_shutdown_cleans_up() {
    let temp = TempDir::new().expect("temp dir");
    let endpoint = test_endpoint(&temp);
    let handler = WorkingHandler::default();
    let activations = Arc::clone(&handler.activations);
    let server = DesktopControlServer::bind(&endpoint, handler, ServerOptions::default())
        .expect("server binds");
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let server_task = tokio::spawn(server.run_until(async move {
        let _ = shutdown_rx.await;
    }));
    let client = DesktopControlClient::new(endpoint.clone(), ClientOptions::default());

    client.activate().await.expect("Desktop activates");
    assert_eq!(activations.load(Ordering::SeqCst), 1);
    assert_eq!(
        client.status().await.expect("status returns"),
        DesktopStatus {
            gateway: GatewayState::Connected,
            window: WindowState::Focused,
            selected_process: Some(ProcessId::new("proc:current").expect("valid process id")),
        }
    );
    assert_eq!(
        client
            .new_conversation()
            .await
            .expect("conversation is created")
            .as_str(),
        "proc:new"
    );
    assert_eq!(
        client
            .use_process(ProcessId::new("proc:other").expect("valid process id"))
            .await
            .expect("process is selected")
            .as_str(),
        "proc:other"
    );
    assert!(matches!(
        client
            .use_process(ProcessId::new("proc:missing").expect("valid process id"))
            .await,
        Err(Error::Remote(ErrorCode::ProcessNotFound))
    ));
    let microphones = client
        .microphone_list()
        .await
        .expect("microphones are listed");
    assert_eq!(microphones.devices().len(), 2);
    assert_eq!(microphones.selected(), &MicrophoneSelection::Ask);
    assert_eq!(
        microphones.environment_override(),
        Some(&MicrophoneEnvironmentOverride::Invalid)
    );

    let selected_name = MicrophoneName::new("Shure MV6").expect("valid microphone name");
    let microphones = client
        .microphone_use(selected_name.clone())
        .await
        .expect("microphone is selected");
    assert_eq!(
        microphones.selected(),
        &MicrophoneSelection::Device {
            name: selected_name
        }
    );

    let microphones = client
        .microphone_default()
        .await
        .expect("default microphone is selected");
    assert_eq!(microphones.selected(), &MicrophoneSelection::SystemDefault);

    shutdown_tx.send(()).expect("shutdown sent");
    server_task
        .await
        .expect("server task joins")
        .expect("server shuts down cleanly");
    assert!(!endpoint.path().exists());
}

struct SlowHandler {
    request: Arc<Mutex<Option<RequestContext>>>,
}

#[async_trait]
impl DesktopControlHandler for SlowHandler {
    async fn activate(&self, _request: RequestContext) -> Result<(), OperationError> {
        Err(OperationError::Internal)
    }

    async fn status(&self, _request: RequestContext) -> Result<DesktopStatus, OperationError> {
        Err(OperationError::Internal)
    }

    async fn new_conversation(
        &self,
        _request: RequestContext,
    ) -> Result<ProcessId, OperationError> {
        Err(OperationError::Internal)
    }

    async fn use_process(
        &self,
        _request: RequestContext,
        _process_id: ProcessId,
    ) -> Result<ProcessId, OperationError> {
        Err(OperationError::Internal)
    }

    async fn microphone_list(
        &self,
        _request: RequestContext,
    ) -> Result<MicrophoneStatus, OperationError> {
        Err(OperationError::Internal)
    }

    async fn microphone_use(
        &self,
        request: RequestContext,
        _name: MicrophoneName,
    ) -> Result<MicrophoneStatus, OperationError> {
        *self.request.lock().expect("request lock") = Some(request);
        tokio::time::sleep(Duration::from_secs(1)).await;
        microphone_status(MicrophoneSelection::Ask)
    }

    async fn microphone_default(
        &self,
        _request: RequestContext,
    ) -> Result<MicrophoneStatus, OperationError> {
        Err(OperationError::Internal)
    }
}

#[tokio::test]
async fn operation_timeout_is_a_typed_redacted_response() {
    let temp = TempDir::new().expect("temp dir");
    let endpoint = test_endpoint(&temp);
    let captured_request = Arc::new(Mutex::new(None));
    let options = ServerOptions::default().with_operation_timeout(Duration::from_millis(20));
    let server = DesktopControlServer::bind(
        &endpoint,
        SlowHandler {
            request: Arc::clone(&captured_request),
        },
        options,
    )
    .expect("server binds");
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let server_task = tokio::spawn(server.run_until(async move {
        let _ = shutdown_rx.await;
    }));
    let client = DesktopControlClient::new(endpoint, ClientOptions::default());

    assert!(matches!(
        client
            .microphone_use(MicrophoneName::new("Shure MV6").expect("valid microphone name"))
            .await,
        Err(Error::Remote(ErrorCode::Timeout))
    ));
    assert!(
        captured_request
            .lock()
            .expect("request lock")
            .as_ref()
            .is_some_and(RequestContext::is_cancelled),
        "the UI bridge must observe cancellation before a timed-out mutation"
    );

    shutdown_tx.send(()).expect("shutdown sent");
    server_task
        .await
        .expect("server task joins")
        .expect("server stops");
}

struct DisconnectHandler {
    request: Arc<Mutex<Option<RequestContext>>>,
    entered: Arc<Notify>,
}

#[async_trait]
impl DesktopControlHandler for DisconnectHandler {
    async fn activate(&self, request: RequestContext) -> Result<(), OperationError> {
        *self.request.lock().expect("request lock") = Some(request);
        self.entered.notify_one();
        std::future::pending().await
    }

    async fn status(&self, _request: RequestContext) -> Result<DesktopStatus, OperationError> {
        Err(OperationError::Internal)
    }

    async fn new_conversation(
        &self,
        _request: RequestContext,
    ) -> Result<ProcessId, OperationError> {
        Err(OperationError::Internal)
    }

    async fn use_process(
        &self,
        _request: RequestContext,
        _process_id: ProcessId,
    ) -> Result<ProcessId, OperationError> {
        Err(OperationError::Internal)
    }

    async fn microphone_list(
        &self,
        _request: RequestContext,
    ) -> Result<MicrophoneStatus, OperationError> {
        Err(OperationError::Internal)
    }

    async fn microphone_use(
        &self,
        _request: RequestContext,
        _name: MicrophoneName,
    ) -> Result<MicrophoneStatus, OperationError> {
        Err(OperationError::Internal)
    }

    async fn microphone_default(
        &self,
        _request: RequestContext,
    ) -> Result<MicrophoneStatus, OperationError> {
        Err(OperationError::Internal)
    }
}

#[tokio::test]
async fn disconnect_cancels_a_queued_ui_operation() {
    let temp = TempDir::new().expect("temp dir");
    let endpoint = test_endpoint(&temp);
    let captured_request = Arc::new(Mutex::new(None));
    let entered = Arc::new(Notify::new());
    let server = DesktopControlServer::bind(
        &endpoint,
        DisconnectHandler {
            request: Arc::clone(&captured_request),
            entered: Arc::clone(&entered),
        },
        ServerOptions::default().with_operation_timeout(Duration::from_secs(2)),
    )
    .expect("server binds");
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let server_task = tokio::spawn(server.run_until(async move {
        let _ = shutdown_rx.await;
    }));

    let mut stream = tokio::net::UnixStream::connect(endpoint.path())
        .await
        .expect("manual client connects");
    let request = serde_json::to_vec(&serde_json::json!({
        "protocolVersion": PROTOCOL_VERSION,
        "requestId": uuid::Uuid::new_v4(),
        "command": { "type": "activate" }
    }))
    .expect("request serializes");
    stream
        .write_u32(request.len() as u32)
        .await
        .expect("request header writes");
    stream
        .write_all(&request)
        .await
        .expect("request body writes");
    entered.notified().await;
    drop(stream);

    tokio::time::timeout(Duration::from_millis(200), async {
        loop {
            let cancelled = captured_request
                .lock()
                .expect("request lock")
                .as_ref()
                .is_some_and(RequestContext::is_cancelled);
            if cancelled {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("disconnect cancellation propagates");

    shutdown_tx.send(()).expect("shutdown sent");
    server_task
        .await
        .expect("server task joins")
        .expect("server stops");
}

struct BlockingHandler {
    entered: Arc<Notify>,
    release: Arc<Notify>,
}

#[async_trait]
impl DesktopControlHandler for BlockingHandler {
    async fn activate(&self, _request: RequestContext) -> Result<(), OperationError> {
        self.entered.notify_one();
        self.release.notified().await;
        Ok(())
    }

    async fn status(&self, _request: RequestContext) -> Result<DesktopStatus, OperationError> {
        Ok(DesktopStatus {
            gateway: GatewayState::Connected,
            window: WindowState::Visible,
            selected_process: None,
        })
    }

    async fn new_conversation(
        &self,
        _request: RequestContext,
    ) -> Result<ProcessId, OperationError> {
        Err(OperationError::Internal)
    }

    async fn use_process(
        &self,
        _request: RequestContext,
        _process_id: ProcessId,
    ) -> Result<ProcessId, OperationError> {
        Err(OperationError::Internal)
    }

    async fn microphone_list(
        &self,
        _request: RequestContext,
    ) -> Result<MicrophoneStatus, OperationError> {
        Err(OperationError::Internal)
    }

    async fn microphone_use(
        &self,
        _request: RequestContext,
        _name: MicrophoneName,
    ) -> Result<MicrophoneStatus, OperationError> {
        Err(OperationError::Internal)
    }

    async fn microphone_default(
        &self,
        _request: RequestContext,
    ) -> Result<MicrophoneStatus, OperationError> {
        Err(OperationError::Internal)
    }
}

#[tokio::test]
async fn concurrent_connections_are_bounded() {
    let temp = TempDir::new().expect("temp dir");
    let endpoint = test_endpoint(&temp);
    let entered = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let handler = BlockingHandler {
        entered: Arc::clone(&entered),
        release: Arc::clone(&release),
    };
    let options = ServerOptions::default()
        .with_max_concurrent_connections(NonZeroUsize::new(1).expect("nonzero"))
        .with_operation_timeout(Duration::from_secs(2));
    let server = DesktopControlServer::bind(&endpoint, handler, options).expect("server binds");
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let server_task = tokio::spawn(server.run_until(async move {
        let _ = shutdown_rx.await;
    }));

    let first_client = DesktopControlClient::new(endpoint.clone(), ClientOptions::default());
    let first = tokio::spawn(async move { first_client.activate().await });
    entered.notified().await;

    let impatient_client = DesktopControlClient::new(
        endpoint,
        ClientOptions::default().with_io_timeout(Duration::from_millis(30)),
    );
    assert!(matches!(
        impatient_client.status().await,
        Err(Error::Timeout {
            stage: TimeoutStage::Read,
            ..
        })
    ));

    release.notify_one();
    first
        .await
        .expect("first client task joins")
        .expect("first request completes");
    shutdown_tx.send(()).expect("shutdown sent");
    server_task
        .await
        .expect("server task joins")
        .expect("server stops");
}

#[tokio::test]
async fn client_rejects_an_uncorrelated_response() {
    let temp = TempDir::new().expect("temp dir");
    let endpoint = test_endpoint(&temp);
    let listener = tokio::net::UnixListener::bind(endpoint.path()).expect("rogue listener binds");
    std::fs::set_permissions(endpoint.path(), std::fs::Permissions::from_mode(0o600))
        .expect("socket made private");

    let rogue = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.expect("client connects");
        let request_length = stream.read_u32().await.expect("request header reads") as usize;
        let mut request = vec![0_u8; request_length];
        stream
            .read_exact(&mut request)
            .await
            .expect("request body reads");
        let response = serde_json::json!({
            "protocolVersion": PROTOCOL_VERSION,
            "requestId": uuid::Uuid::new_v4(),
            "outcome": {
                "type": "success",
                "response": { "type": "activated" }
            }
        });
        let response = serde_json::to_vec(&response).expect("response serializes");
        stream
            .write_u32(response.len() as u32)
            .await
            .expect("response header writes");
        stream
            .write_all(&response)
            .await
            .expect("response body writes");
    });
    let client = DesktopControlClient::new(endpoint, ClientOptions::default());

    assert!(matches!(
        client.activate().await,
        Err(Error::UnexpectedResponse)
    ));
    rogue.await.expect("rogue server joins");
}
