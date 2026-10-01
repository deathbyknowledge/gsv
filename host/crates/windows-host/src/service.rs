use std::{
    ffi::OsString,
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};
pub use windows_service;
use windows_service::{
    service::{Service, ServiceAccess, ServiceState},
    service_manager::{ServiceManager, ServiceManagerAccess},
};

pub const NAME: &str = "gsvd";
pub const ACCOUNT: &str = r"NT SERVICE\gsvd";
static SERVICE_PROCESS: AtomicBool = AtomicBool::new(false);

pub fn enter_service() {
    SERVICE_PROCESS.store(true, Ordering::Relaxed);
}
pub fn is_service_process() -> bool {
    SERVICE_PROCESS.load(Ordering::Relaxed)
}
pub fn data_dir() -> PathBuf {
    PathBuf::from(
        std::env::var_os("ProgramData").unwrap_or_else(|| OsString::from(r"C:\ProgramData")),
    )
    .join("GSV")
    .join("daemon")
}
pub fn open(access: ServiceAccess) -> windows_service::Result<Service> {
    ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)?
        .open_service(NAME, access)
}
pub fn installed() -> windows_service::Result<bool> {
    match open(ServiceAccess::QUERY_STATUS) {
        Ok(_) => Ok(true),
        Err(windows_service::Error::Winapi(error)) if error.raw_os_error() == Some(1060) => {
            Ok(false)
        }
        Err(error) => Err(error),
    }
}
pub fn process_id() -> windows_service::Result<Option<u32>> {
    Ok(open(ServiceAccess::QUERY_STATUS)?
        .query_status()?
        .process_id)
}
pub fn wait(service: &Service, state: ServiceState) -> Result<(), Box<dyn std::error::Error>> {
    let deadline = Instant::now() + Duration::from_secs(30);
    while service.query_status()?.current_state != state {
        if Instant::now() >= deadline {
            return Err(format!("gsvd did not reach {state:?} within 30 seconds").into());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Ok(())
}
pub fn stop() -> Result<(), Box<dyn std::error::Error>> {
    let service = open(ServiceAccess::STOP | ServiceAccess::QUERY_STATUS)?;
    let state = service.query_status()?.current_state;
    if state != ServiceState::Stopped && state != ServiceState::StopPending {
        service.stop()?;
    }
    wait(&service, ServiceState::Stopped)
}
pub fn start() -> Result<(), Box<dyn std::error::Error>> {
    let service = open(ServiceAccess::START | ServiceAccess::QUERY_STATUS)?;
    if service.query_status()?.current_state == ServiceState::Stopped {
        service.start::<&str>(&[])?;
    }
    wait(&service, ServiceState::Running)
}
