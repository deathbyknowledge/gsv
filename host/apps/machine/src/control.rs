use std::{
    sync::{Arc, RwLock},
    time::Instant,
};

use async_trait::async_trait;
use daemon_protocol::{
    DaemonControlHandler, DaemonPhase, DaemonStatus, DiagnosticLevel, DiagnosticNotice,
    Diagnostics, OperationError, RequestContext,
};
use tokio::sync::mpsc;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ControlAction {
    Reload,
    Reconnect,
    Shutdown,
}

#[derive(Clone, Debug)]
struct RuntimeSnapshot {
    machine_id: String,
    phase: DaemonPhase,
    connected: bool,
    reconnect_attempt: u32,
    last_error: Option<String>,
    update_notice: Option<DiagnosticNotice>,
}

#[derive(Clone)]
pub struct DaemonRuntime {
    started: Instant,
    snapshot: Arc<RwLock<RuntimeSnapshot>>,
    actions: mpsc::Sender<ControlAction>,
}

impl DaemonRuntime {
    pub fn new(machine_id: String) -> (Self, mpsc::Receiver<ControlAction>) {
        let (actions, receiver) = mpsc::channel(8);
        (
            Self {
                started: Instant::now(),
                snapshot: Arc::new(RwLock::new(RuntimeSnapshot {
                    machine_id,
                    phase: DaemonPhase::Starting,
                    connected: false,
                    reconnect_attempt: 0,
                    last_error: None,
                    update_notice: None,
                })),
                actions,
            },
            receiver,
        )
    }

    pub fn set_machine_id(&self, machine_id: String) {
        self.update(|snapshot| snapshot.machine_id = machine_id);
    }

    pub fn set_phase(&self, phase: DaemonPhase) {
        self.update(|snapshot| {
            snapshot.phase = phase;
            snapshot.connected = phase == DaemonPhase::Connected;
            if snapshot.connected {
                snapshot.reconnect_attempt = 0;
                snapshot.last_error = None;
            }
        });
    }

    pub fn reconnecting(&self, attempt: u32, error: impl Into<String>) {
        let error = bounded_message(error.into());
        self.update(|snapshot| {
            snapshot.phase = DaemonPhase::Reconnecting;
            snapshot.connected = false;
            snapshot.reconnect_attempt = attempt;
            snapshot.last_error = Some(error);
        });
    }

    /// The latest automatic-update decision, shown in diagnostics until the
    /// next handshake replaces it.
    pub fn set_update_notice(&self, notice: Option<DiagnosticNotice>) {
        self.update(|snapshot| snapshot.update_notice = notice);
    }

    pub async fn request(&self, action: ControlAction) -> Result<(), OperationError> {
        self.actions.try_send(action).map_err(|error| match error {
            mpsc::error::TrySendError::Full(_) => OperationError::Busy,
            mpsc::error::TrySendError::Closed(_) => OperationError::Internal,
        })
    }

    pub fn status(&self) -> DaemonStatus {
        let snapshot = self
            .snapshot
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        DaemonStatus {
            version: env!("CARGO_PKG_VERSION").to_string(),
            process_id: std::process::id(),
            machine_id: snapshot.machine_id,
            phase: snapshot.phase,
            connected: snapshot.connected,
            uptime_seconds: self.started.elapsed().as_secs(),
            reconnect_attempt: snapshot.reconnect_attempt,
        }
    }

    pub fn diagnostics(&self) -> Diagnostics {
        let snapshot = self
            .snapshot
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        let mut notices = Vec::new();
        if let Some(message) = snapshot.last_error {
            notices.push(DiagnosticNotice {
                level: DiagnosticLevel::Warning,
                code: "gatewayConnection".to_string(),
                message,
            });
        } else if snapshot.connected {
            notices.push(DiagnosticNotice {
                level: DiagnosticLevel::Info,
                code: "connected".to_string(),
                message: "The machine is connected to GSV.".to_string(),
            });
        }
        if let Some(notice) = snapshot.update_notice {
            notices.push(notice);
        }
        Diagnostics::new(self.status(), notices).unwrap_or_else(|_| Diagnostics {
            status: self.status(),
            notices: Vec::new(),
        })
    }

    fn update(&self, update: impl FnOnce(&mut RuntimeSnapshot)) {
        let mut snapshot = self
            .snapshot
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        update(&mut snapshot);
    }
}

fn bounded_message(mut value: String) -> String {
    const MAX_BYTES: usize = 512;
    if value.len() <= MAX_BYTES {
        return value;
    }
    let mut boundary = MAX_BYTES;
    while !value.is_char_boundary(boundary) {
        boundary -= 1;
    }
    value.truncate(boundary);
    value
}

#[async_trait]
impl DaemonControlHandler for DaemonRuntime {
    async fn status(&self, _: RequestContext) -> Result<DaemonStatus, OperationError> {
        Ok(self.status())
    }

    async fn reload(&self, request: RequestContext) -> Result<(), OperationError> {
        if request.is_cancelled() {
            return Err(OperationError::Busy);
        }
        self.request(ControlAction::Reload).await
    }

    async fn reconnect(&self, request: RequestContext) -> Result<(), OperationError> {
        if request.is_cancelled() {
            return Err(OperationError::Busy);
        }
        self.request(ControlAction::Reconnect).await
    }

    async fn diagnostics(&self, _: RequestContext) -> Result<Diagnostics, OperationError> {
        Ok(self.diagnostics())
    }

    async fn shutdown(&self, request: RequestContext) -> Result<(), OperationError> {
        if request.is_cancelled() {
            return Err(OperationError::Busy);
        }
        self.request(ControlAction::Shutdown).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn reports_redacted_state_and_delivers_control_actions() {
        let (runtime, mut receiver) = DaemonRuntime::new("machine-a".to_string());
        runtime.reconnecting(2, "provider secret must not be included by callers");
        let status = runtime.status();
        assert_eq!(status.machine_id, "machine-a");
        assert_eq!(status.phase, DaemonPhase::Reconnecting);
        assert_eq!(status.reconnect_attempt, 2);

        runtime
            .request(ControlAction::Reload)
            .await
            .expect("reload queues");
        assert_eq!(receiver.recv().await, Some(ControlAction::Reload));
    }

    #[test]
    fn diagnostics_carry_the_latest_update_decision() {
        let (runtime, _receiver) = DaemonRuntime::new("machine-a".to_string());
        runtime.set_update_notice(Some(DiagnosticNotice {
            level: DiagnosticLevel::Info,
            code: "autoUpdateStarted".to_string(),
            message: "Installing GSV v0.5.0.".to_string(),
        }));
        let codes: Vec<String> = runtime
            .diagnostics()
            .notices
            .into_iter()
            .map(|notice| notice.code)
            .collect();
        assert_eq!(codes, vec!["autoUpdateStarted".to_string()]);
        runtime.set_update_notice(None);
        assert!(runtime.diagnostics().notices.is_empty());
    }
}
