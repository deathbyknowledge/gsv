use std::{
    ffi::OsString,
    sync::{Arc, OnceLock},
    time::Duration,
};
use tokio_util::sync::CancellationToken;
use windows_host::service::{
    self,
    windows_service::{
        define_windows_service,
        service::{
            ServiceControl, ServiceControlAccept, ServiceExitCode, ServiceState, ServiceStatus,
            ServiceType,
        },
        service_control_handler::{self, ServiceControlHandlerResult, ServiceStatusHandle},
        service_dispatcher,
    },
};

define_windows_service!(service_main_ffi, service_main);

pub fn run() -> Result<(), Box<dyn std::error::Error>> {
    service_dispatcher::start(service::NAME, service_main_ffi)?;
    Ok(())
}

fn status(state: ServiceState, failed: bool) -> ServiceStatus {
    ServiceStatus {
        service_type: ServiceType::OWN_PROCESS,
        current_state: state,
        controls_accepted: if state == ServiceState::Running {
            ServiceControlAccept::STOP | ServiceControlAccept::SHUTDOWN
        } else {
            ServiceControlAccept::empty()
        },
        exit_code: ServiceExitCode::Win32(if failed { 1 } else { 0 }),
        checkpoint: if matches!(
            state,
            ServiceState::StartPending | ServiceState::StopPending
        ) {
            1
        } else {
            0
        },
        wait_hint: if matches!(
            state,
            ServiceState::StartPending | ServiceState::StopPending
        ) {
            Duration::from_secs(30)
        } else {
            Duration::ZERO
        },
        process_id: None,
    }
}

fn service_main(_: Vec<OsString>) {
    service::enter_service();
    let shutdown = CancellationToken::new();
    let stop = shutdown.clone();
    let handle_slot: Arc<OnceLock<ServiceStatusHandle>> = Arc::new(OnceLock::new());
    let handler_slot = handle_slot.clone();
    let handle =
        match service_control_handler::register(service::NAME, move |control| match control {
            ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
            ServiceControl::Stop | ServiceControl::Shutdown => {
                if let Some(handle) = handler_slot.get() {
                    let _ = handle.set_service_status(status(ServiceState::StopPending, false));
                }
                stop.cancel();
                ServiceControlHandlerResult::NoError
            }
            _ => ServiceControlHandlerResult::NotImplemented,
        }) {
            Ok(handle) => handle,
            Err(_) => return,
        };
    let _ = handle_slot.set(handle);
    let _ = handle.set_service_status(status(ServiceState::StartPending, false));
    let result = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build();
    let failed = match result {
        Ok(runtime) => runtime
            .block_on(crate::app::run_with_shutdown(shutdown, || {
                let _ = handle.set_service_status(status(ServiceState::Running, false));
            }))
            .is_err(),
        Err(_) => true,
    };
    let _ = handle.set_service_status(status(ServiceState::Stopped, failed));
}
