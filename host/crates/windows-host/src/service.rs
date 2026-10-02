use std::{
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
fn known_folder(id: &windows_sys::core::GUID) -> PathBuf {
    use std::{ffi::OsString, os::windows::ffi::OsStringExt, ptr};
    let mut value = ptr::null_mut();
    // SAFETY: id and the output pointer are valid; the shell allocates the result.
    let result = unsafe {
        windows_sys::Win32::UI::Shell::SHGetKnownFolderPath(id, 0, ptr::null_mut(), &mut value)
    };
    assert!(
        result >= 0 && !value.is_null(),
        "Windows system folder is unavailable"
    );
    // SAFETY: a successful result is a NUL-terminated UTF-16 allocation.
    unsafe {
        let mut length = 0;
        while *value.add(length) != 0 {
            length += 1;
        }
        let path = PathBuf::from(OsString::from_wide(std::slice::from_raw_parts(
            value, length,
        )));
        windows_sys::Win32::System::Com::CoTaskMemFree(value.cast());
        path
    }
}

pub fn data_dir() -> PathBuf {
    known_folder(&windows_sys::Win32::UI::Shell::FOLDERID_ProgramData)
        .join("GSV")
        .join("daemon")
}

pub fn owner_sid_path() -> PathBuf {
    known_folder(&windows_sys::Win32::UI::Shell::FOLDERID_ProgramData)
        .join("GSV")
        .join("owner.sid")
}

pub fn binary_dir() -> PathBuf {
    known_folder(&windows_sys::Win32::UI::Shell::FOLDERID_ProgramFilesX64)
        .join("GSV")
        .join("service")
}

pub fn system_tool(name: &str) -> PathBuf {
    use std::{ffi::OsString, os::windows::ffi::OsStringExt};
    let mut buffer = vec![0u16; 32768];
    // SAFETY: buffer is writable and its capacity is passed accurately.
    let length = unsafe {
        windows_sys::Win32::System::SystemInformation::GetSystemDirectoryW(
            buffer.as_mut_ptr(),
            buffer.len() as u32,
        )
    };
    assert!(
        length > 0 && (length as usize) < buffer.len(),
        "Windows system directory is unavailable"
    );
    PathBuf::from(OsString::from_wide(&buffer[..length as usize])).join(name)
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
    // SCM cannot deliver STOP until a starting service accepts controls. Keep
    // ownership while startup settles so cancellation can restore its old image.
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let state = service.query_status()?.current_state;
        if state == ServiceState::StartPending {
            if Instant::now() >= deadline {
                return Err("gsvd startup did not settle before stopping".into());
            }
            std::thread::sleep(Duration::from_millis(100));
            continue;
        }
        if state != ServiceState::Stopped && state != ServiceState::StopPending {
            service.stop()?;
        }
        return wait(&service, ServiceState::Stopped);
    }
}
pub fn start() -> Result<(), Box<dyn std::error::Error>> {
    let service = open(ServiceAccess::START | ServiceAccess::QUERY_STATUS)?;
    if service.query_status()?.current_state == ServiceState::Stopped {
        service.start::<&str>(&[])?;
    }
    wait(&service, ServiceState::Running)
}
