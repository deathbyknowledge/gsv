use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use desktop_protocol::{
    Command, DesktopControlHandler, DesktopStatus, GatewayState, MicrophoneName, MicrophoneStatus,
    OperationError, ProcessId, RequestContext, RequestId, Success, WindowState,
};
use serde::{Deserialize, Serialize};
use tauri::{ipc::Channel, AppHandle, Manager};
use tokio::sync::oneshot;
use uuid::Uuid;

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ControlEvent {
    Request { id: RequestId, command: Command },
    Cancel { id: RequestId },
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum ControlReply {
    Success { response: Success },
    Error { code: desktop_protocol::ErrorCode },
}

struct Pending {
    context: RequestContext,
    reply: oneshot::Sender<Result<Success, OperationError>>,
}

#[derive(Default)]
struct Frontend {
    lease: String,
    channel: Option<Channel<ControlEvent>>,
    pending: HashMap<RequestId, Pending>,
}

#[derive(Clone, Default)]
pub struct ControlBridge(Arc<Mutex<Frontend>>);

// Removing a request also cancels frontend work when the server drops a timed-out
// handler. The frontend checks this authority again before changing selection.
struct PendingGuard {
    bridge: ControlBridge,
    id: RequestId,
}

impl Drop for PendingGuard {
    fn drop(&mut self) {
        let mut frontend = self.bridge.0.lock().unwrap();
        if frontend.pending.remove(&self.id).is_some() {
            if let Some(channel) = &frontend.channel {
                let _ = channel.send(ControlEvent::Cancel { id: self.id });
            }
        }
    }
}

impl ControlBridge {
    pub fn reset(&self) {
        *self.0.lock().unwrap() = Frontend::default();
    }

    pub fn attach(&self, channel: Channel<ControlEvent>) -> String {
        let lease = Uuid::new_v4().to_string();
        *self.0.lock().unwrap() = Frontend {
            lease: lease.clone(),
            channel: Some(channel),
            pending: HashMap::new(),
        };
        lease
    }

    pub fn detach(&self, lease: &str) {
        let mut frontend = self.0.lock().unwrap();
        if frontend.lease == lease {
            *frontend = Frontend::default();
        }
    }

    pub fn active(&self, lease: &str, id: RequestId) -> bool {
        let frontend = self.0.lock().unwrap();
        frontend.lease == lease
            && frontend
                .pending
                .get(&id)
                .is_some_and(|p| !p.context.is_cancelled())
    }

    pub fn reply(&self, lease: &str, id: RequestId, value: ControlReply) {
        let mut frontend = self.0.lock().unwrap();
        if frontend.lease != lease {
            return;
        }
        if let Some(pending) = frontend.pending.remove(&id) {
            let response = if pending.context.is_cancelled() {
                Err(OperationError::Conflict)
            } else {
                match value {
                    ControlReply::Success { response } => Ok(response),
                    ControlReply::Error { code } => Err(match code {
                        desktop_protocol::ErrorCode::Busy => OperationError::Busy,
                        desktop_protocol::ErrorCode::ProcessNotFound => {
                            OperationError::ProcessNotFound
                        }
                        desktop_protocol::ErrorCode::PermissionDenied => {
                            OperationError::PermissionDenied
                        }
                        desktop_protocol::ErrorCode::Conflict => OperationError::Conflict,
                        _ => OperationError::Unavailable,
                    }),
                }
            };
            let _ = pending.reply.send(response);
        }
    }

    async fn request(
        &self,
        context: RequestContext,
        command: Command,
    ) -> Result<Success, OperationError> {
        if context.is_cancelled() {
            return Err(OperationError::Conflict);
        }
        let id = context.request_id();
        let (reply, response) = oneshot::channel();
        let channel = {
            let mut frontend = self.0.lock().unwrap();
            let channel = frontend
                .channel
                .clone()
                .ok_or(OperationError::Unavailable)?;
            frontend.pending.insert(
                id,
                Pending {
                    context: context.clone(),
                    reply,
                },
            );
            channel
        };
        let _guard = PendingGuard {
            bridge: self.clone(),
            id,
        };
        channel
            .send(ControlEvent::Request { id, command })
            .map_err(|_| OperationError::Unavailable)?;
        tokio::select! {
            value = response => value.unwrap_or(Err(OperationError::Unavailable)),
            () = context.cancelled() => Err(OperationError::Conflict),
        }
    }
}

pub struct DesktopHandler {
    pub app: AppHandle,
    pub bridge: ControlBridge,
}

#[async_trait::async_trait]
impl DesktopControlHandler for DesktopHandler {
    async fn activate(&self, context: RequestContext) -> Result<(), OperationError> {
        let app = self.app.clone();
        let (reply, result) = oneshot::channel();
        self.app
            .run_on_main_thread(move || {
                let result = if context.is_cancelled() {
                    Err(OperationError::Conflict)
                } else if let Some(window) = app.get_webview_window("main") {
                    window
                        .show()
                        .and_then(|_| window.unminimize())
                        .and_then(|_| window.set_focus())
                        .map_err(|_| OperationError::Unavailable)
                } else {
                    Err(OperationError::Unavailable)
                };
                let _ = reply.send(result);
            })
            .map_err(|_| OperationError::Unavailable)?;
        result.await.unwrap_or(Err(OperationError::Unavailable))
    }

    async fn status(&self, context: RequestContext) -> Result<DesktopStatus, OperationError> {
        let mut status = match self.bridge.request(context, Command::Status).await {
            Ok(Success::Status { status }) => status,
            Err(OperationError::Unavailable) => DesktopStatus {
                gateway: GatewayState::Disconnected,
                window: WindowState::Visible,
                selected_process: None,
            },
            Err(error) => return Err(error),
            _ => return Err(OperationError::Internal),
        };
        let window = self
            .app
            .get_webview_window("main")
            .ok_or(OperationError::Unavailable)?;
        status.window = if window.is_focused().unwrap_or(false) {
            WindowState::Focused
        } else if window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(false) {
            WindowState::Visible
        } else {
            WindowState::Hidden
        };
        Ok(status)
    }

    async fn new_conversation(&self, context: RequestContext) -> Result<ProcessId, OperationError> {
        match self.bridge.request(context, Command::New).await? {
            Success::Created { process_id } => Ok(process_id),
            _ => Err(OperationError::Internal),
        }
    }

    async fn use_process(
        &self,
        context: RequestContext,
        process_id: ProcessId,
    ) -> Result<ProcessId, OperationError> {
        match self
            .bridge
            .request(context, Command::Use { process_id })
            .await?
        {
            Success::Selected { process_id } => Ok(process_id),
            _ => Err(OperationError::Internal),
        }
    }

    async fn microphone_list(
        &self,
        context: RequestContext,
    ) -> Result<MicrophoneStatus, OperationError> {
        match self
            .bridge
            .request(context, Command::MicrophoneList)
            .await?
        {
            Success::MicrophonesListed { status } => Ok(status),
            _ => Err(OperationError::Internal),
        }
    }

    async fn microphone_use(
        &self,
        context: RequestContext,
        name: MicrophoneName,
    ) -> Result<MicrophoneStatus, OperationError> {
        match self
            .bridge
            .request(context, Command::MicrophoneUse { name })
            .await?
        {
            Success::MicrophoneSelected { status } => Ok(status),
            _ => Err(OperationError::Internal),
        }
    }

    async fn microphone_default(
        &self,
        context: RequestContext,
    ) -> Result<MicrophoneStatus, OperationError> {
        match self
            .bridge
            .request(context, Command::MicrophoneDefault)
            .await?
        {
            Success::DefaultMicrophoneSelected { status } => Ok(status),
            _ => Err(OperationError::Internal),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use desktop_protocol::{
        ClientOptions, DesktopControlClient, DesktopControlEndpoint, DesktopControlServer,
        ServerOptions,
    };
    use std::time::Duration;

    struct Handler(ControlBridge);
    #[async_trait::async_trait]
    impl DesktopControlHandler for Handler {
        async fn activate(&self, _: RequestContext) -> Result<(), OperationError> {
            Ok(())
        }
        async fn status(&self, _: RequestContext) -> Result<DesktopStatus, OperationError> {
            Err(OperationError::Unavailable)
        }
        async fn new_conversation(
            &self,
            context: RequestContext,
        ) -> Result<ProcessId, OperationError> {
            match self.0.request(context, Command::New).await? {
                Success::Created { process_id } => Ok(process_id),
                _ => Err(OperationError::Internal),
            }
        }
        async fn use_process(
            &self,
            _: RequestContext,
            _: ProcessId,
        ) -> Result<ProcessId, OperationError> {
            Err(OperationError::Unavailable)
        }
        async fn microphone_list(
            &self,
            _: RequestContext,
        ) -> Result<MicrophoneStatus, OperationError> {
            Err(OperationError::Unavailable)
        }
        async fn microphone_use(
            &self,
            _: RequestContext,
            _: MicrophoneName,
        ) -> Result<MicrophoneStatus, OperationError> {
            Err(OperationError::Unavailable)
        }
        async fn microphone_default(
            &self,
            _: RequestContext,
        ) -> Result<MicrophoneStatus, OperationError> {
            Err(OperationError::Unavailable)
        }
    }

    fn channel() -> (
        Channel<ControlEvent>,
        tokio::sync::mpsc::UnboundedReceiver<serde_json::Value>,
    ) {
        let (sender, receiver) = tokio::sync::mpsc::unbounded_channel();
        let channel = Channel::new(move |body| {
            let tauri::ipc::InvokeResponseBody::Json(json) = body else {
                panic!("expected JSON");
            };
            let _ = sender.send(serde_json::from_str(&json).unwrap());
            Ok(())
        });
        (channel, receiver)
    }

    #[tokio::test]
    async fn cli_disconnect_cancels_queued_work_and_reload_rejects_old_replies() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        std::fs::set_permissions(temp.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let endpoint = DesktopControlEndpoint::from_path(temp.path().join("desktop.sock"));
        let bridge = ControlBridge::default();
        let (updates, mut events) = channel();
        let lease = bridge.attach(updates);
        let server = DesktopControlServer::bind(
            &endpoint,
            Handler(bridge.clone()),
            ServerOptions::default(),
        )
        .unwrap();
        let (stop, stopped) = oneshot::channel();
        let serving = tokio::spawn(server.run_until(async {
            let _ = stopped.await;
        }));
        let client = DesktopControlClient::new(endpoint.clone(), ClientOptions::default());
        let request = tokio::spawn(async move { client.new_conversation().await });
        let event = events.recv().await.unwrap();
        let id: RequestId = serde_json::from_value(event["id"].clone()).unwrap();
        assert!(bridge.active(&lease, id));
        request.abort();
        tokio::time::timeout(Duration::from_secs(1), async {
            while bridge.active(&lease, id) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(events.recv().await.unwrap()["type"], "cancel");
        assert!(bridge.0.lock().unwrap().pending.is_empty());

        let client = DesktopControlClient::new(endpoint, ClientOptions::default());
        let request = tokio::spawn(async move { client.new_conversation().await });
        let event = events.recv().await.unwrap();
        let id: RequestId = serde_json::from_value(event["id"].clone()).unwrap();
        let (updates, _) = channel();
        let replacement = bridge.attach(updates);
        assert_ne!(lease, replacement);
        assert!(!bridge.active(&lease, id));
        bridge.reply(
            &lease,
            id,
            ControlReply::Success {
                response: Success::Created {
                    process_id: ProcessId::new("stale").unwrap(),
                },
            },
        );
        assert!(request.await.unwrap().is_err());
        assert!(bridge.0.lock().unwrap().pending.is_empty());

        let _ = stop.send(());
        serving.await.unwrap().unwrap();
    }
}
