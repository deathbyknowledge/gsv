use super::*;
use std::os::windows::io::{AsRawHandle, OwnedHandle};
use windows_sys::Win32::{
    Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT},
    System::{
        Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE},
        Threading::{GetExitCodeProcess, GetProcessId, WaitForSingleObject, INFINITE},
    },
    UI::{
        Shell::{
            ShellExecuteExW, SEE_MASK_FLAG_NO_UI, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS,
            SHELLEXECUTEINFOW,
        },
        WindowsAndMessaging::SW_HIDE,
    },
};

/// Keeps the elevated replacement alive until the original caller has applied
/// workspace permissions and started SCM. Caller death aborts the replacement.
pub(super) fn run(
    executable: &Path,
    arguments: &str,
    mut escrow: WorkspaceEscrow,
    complete: impl FnOnce() -> Result<(), DynError>,
) -> Result<(), DynError> {
    let child = elevate(executable, arguments)?;
    // SAFETY: ShellExecuteEx returned this live, owned process handle.
    let child_pid = unsafe { GetProcessId(child.as_raw_handle()) };
    if child_pid == 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    let ready = (|| -> Result<(), DynError> {
        loop {
            if escrow.ready(child_pid)? {
                return Ok(());
            }
            // SAFETY: the child handle remains live throughout the bounded wait.
            match unsafe { WaitForSingleObject(child.as_raw_handle(), 100) } {
                WAIT_TIMEOUT => {}
                WAIT_OBJECT_0 => {
                    return Err("Elevated enrollment ended before registration was ready".into());
                }
                _ => return Err(std::io::Error::last_os_error().into()),
            }
        }
    })();
    if let Err(error) = ready {
        // Closing our endpoint aborts a child that reached its transaction wait.
        drop(escrow);
        let _ = wait(&child);
        return Err(error);
    }
    let result = complete();
    let sent = escrow.complete(result.is_ok());
    if sent.is_err() {
        drop(escrow);
    }
    let elevated = wait(&child);
    match (result.and(sent), elevated) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(error), Ok(())) | (Ok(()), Err(error)) => Err(error),
        (Err(error), Err(elevated)) => Err(format!("{error}; {elevated}").into()),
    }
}

fn elevate(executable: &Path, arguments: &str) -> Result<OwnedHandle, DynError> {
    let executable: Vec<u16> = executable
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let arguments: Vec<u16> = arguments.encode_utf16().chain(Some(0)).collect();
    // A dedicated STA keeps shell activation independent of the caller's COM mode.
    std::thread::spawn(move || -> Result<OwnedHandle, std::io::Error> {
        // SAFETY: this new thread owns and balances its COM apartment.
        let initialized = unsafe {
            CoInitializeEx(
                std::ptr::null(),
                (COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) as u32,
            )
        };
        if initialized < 0 {
            return Err(std::io::Error::other(format!(
                "Could not initialize Windows elevation: {initialized:#x}"
            )));
        }
        let verb: Vec<u16> = "runas".encode_utf16().chain(Some(0)).collect();
        let directory: Vec<u16> = system_tool("")
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect();
        let mut info = SHELLEXECUTEINFOW {
            cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
            fMask: SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI,
            lpVerb: verb.as_ptr(),
            lpFile: executable.as_ptr(),
            lpParameters: arguments.as_ptr(),
            lpDirectory: directory.as_ptr(),
            nShow: SW_HIDE,
            ..SHELLEXECUTEINFOW::default()
        };
        // SAFETY: the structure and all terminated strings remain live; the
        // no-close flag returns the exact process Windows launches after UAC.
        let result = if unsafe { ShellExecuteExW(&mut info) } == 0 {
            Err(std::io::Error::last_os_error())
        } else if info.hProcess.is_null() {
            Err(std::io::Error::other(
                "Windows returned no installer process",
            ))
        } else {
            // SAFETY: ShellExecuteEx transferred ownership of this process handle.
            Ok(unsafe { OwnedHandle::from_raw_handle(info.hProcess) })
        };
        // SAFETY: successful CoInitializeEx above must be balanced on this thread.
        unsafe { CoUninitialize() };
        result
    })
    .join()
    .map_err(|_panic| "Windows elevation worker stopped unexpectedly")?
    .map_err(Into::into)
}

fn wait(child: &OwnedHandle) -> Result<(), DynError> {
    // SAFETY: the process handle remains owned throughout the wait.
    if unsafe { WaitForSingleObject(child.as_raw_handle(), INFINITE) } != WAIT_OBJECT_0 {
        return Err(std::io::Error::last_os_error().into());
    }
    let mut code = 0;
    // SAFETY: the process has exited and code is valid output storage.
    if unsafe { GetExitCodeProcess(child.as_raw_handle(), &mut code) } == 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    if code != 0 {
        return Err(format!("Elevated GSV installation failed with exit code {code}").into());
    }
    Ok(())
}
