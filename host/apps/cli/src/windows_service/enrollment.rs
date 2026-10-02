use super::*;
use std::os::windows::io::{AsRawHandle, OwnedHandle};
use windows_sys::Win32::{
    Foundation::{GetLastError, ERROR_ALREADY_EXISTS, WAIT_OBJECT_0, WAIT_TIMEOUT},
    System::Threading::{
        CreateEventW, OpenEventW, SetEvent, WaitForMultipleObjects, WaitForSingleObject,
        EVENT_MODIFY_STATE, INFINITE, SYNCHRONIZATION_SYNCHRONIZE,
    },
};

/// Keeps the elevated replacement alive until the original caller has applied
/// workspace permissions and started SCM. Caller death aborts the replacement.
pub(super) struct Enrollment {
    pub(super) id: String,
    ready: OwnedHandle,
    commit: OwnedHandle,
    abort: OwnedHandle,
}

impl Enrollment {
    pub(super) fn create(owner: &str) -> Result<Self, DynError> {
        Self::events(&uuid::Uuid::new_v4().to_string(), Some(owner))
    }

    fn events(id: &str, owner: Option<&str>) -> Result<Self, DynError> {
        let id = uuid::Uuid::parse_str(id)?.to_string();
        let descriptor = owner
            .map(|owner| {
                SecurityDescriptor::from_sddl(&format!("D:P(A;;GA;;;BA)(A;;GA;;;{owner})"))
            })
            .transpose()?;
        let event = |suffix: &str| -> Result<OwnedHandle, DynError> {
            let name: Vec<u16> = format!("Local\\gsv-install-{id}-{suffix}")
                .encode_utf16()
                .chain(Some(0))
                .collect();
            let handle = if let Some(descriptor) = &descriptor {
                let attributes = SECURITY_ATTRIBUTES {
                    nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                    lpSecurityDescriptor: descriptor.pointer,
                    bInheritHandle: 0,
                };
                // SAFETY: the descriptor and terminated event name remain live.
                let handle = unsafe { CreateEventW(&attributes, 1, 0, name.as_ptr()) };
                // SAFETY: GetLastError reads the calling thread's last API result.
                let existed = unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
                if handle.is_null() {
                    return Err(std::io::Error::last_os_error().into());
                }
                // SAFETY: CreateEventW returned a newly owned handle.
                let handle = unsafe { OwnedHandle::from_raw_handle(handle) };
                if existed {
                    return Err("Enrollment event already exists".into());
                }
                return Ok(handle);
            } else {
                // SAFETY: the terminated event name remains live.
                unsafe {
                    OpenEventW(
                        EVENT_MODIFY_STATE | SYNCHRONIZATION_SYNCHRONIZE,
                        0,
                        name.as_ptr(),
                    )
                }
            };
            if handle.is_null() {
                return Err(std::io::Error::last_os_error().into());
            }
            // SAFETY: OpenEventW returned a newly owned handle.
            Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
        };
        Ok(Self {
            ready: event("ready")?,
            commit: event("commit")?,
            abort: event("abort")?,
            id,
        })
    }

    pub(super) fn run(
        &self,
        script: String,
        mut escrow: WorkspaceEscrow,
        complete: impl FnOnce() -> Result<(), DynError>,
    ) -> Result<(), DynError> {
        let worker = std::thread::spawn(move || {
            run_windows_powershell_script(
                &script,
                "Administrator approval is required to install the boot service",
            )
            .map_err(|error| error.to_string())
        });
        loop {
            escrow.send_if_connected()?;
            // SAFETY: the event handle is live throughout the bounded wait.
            match unsafe { WaitForSingleObject(self.ready.as_raw_handle(), 100) } {
                WAIT_OBJECT_0 => break,
                WAIT_TIMEOUT if !worker.is_finished() => continue,
                _ => {
                    signal(&self.abort)?;
                    let result = worker
                        .join()
                        .map_err(|_panic| "Enrollment worker stopped unexpectedly")?;
                    return Err(result
                        .err()
                        .unwrap_or_else(|| "Enrollment ended before registration was ready".into())
                        .into());
                }
            }
        }
        let result = complete();
        signal(if result.is_ok() {
            &self.commit
        } else {
            &self.abort
        })?;
        let elevated = worker
            .join()
            .map_err(|_panic| "Enrollment worker stopped unexpectedly")?;
        match (result, elevated) {
            (Ok(()), Ok(())) => Ok(()),
            (Err(error), Ok(())) => Err(error),
            (Ok(()), Err(error)) => Err(error.into()),
            (Err(error), Err(elevated)) => Err(format!("{error}; {elevated}").into()),
        }
    }

    pub(super) fn wait_for_caller(id: &str, parent: &OwnedHandle) -> Result<(), DynError> {
        let events = Self::events(id, None)?;
        signal(&events.ready)?;
        let handles = [
            events.abort.as_raw_handle(),
            parent.as_raw_handle(),
            events.commit.as_raw_handle(),
        ];
        // SAFETY: all three handles remain live until this wait completes.
        match unsafe { WaitForMultipleObjects(handles.len() as u32, handles.as_ptr(), 0, INFINITE) }
        {
            value if value == WAIT_OBJECT_0 + 2 => Ok(()),
            value if value == WAIT_OBJECT_0 || value == WAIT_OBJECT_0 + 1 => {
                Err("Enrollment cancelled; restoring the previous service".into())
            }
            _ => Err(std::io::Error::last_os_error().into()),
        }
    }
}

fn signal(event: &OwnedHandle) -> Result<(), DynError> {
    // SAFETY: the owned event handle remains live.
    if unsafe { SetEvent(event.as_raw_handle()) } == 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enrollment_waits_for_commit_and_aborts_when_the_caller_exits() {
        for commit in [true, false] {
            let enrollment = Enrollment::create(&current_user_sid_string().unwrap()).unwrap();
            let mut caller = Command::new(system_tool(r"WindowsPowerShell\v1.0\powershell.exe"))
                .args(["-NoProfile", "-Command", "Start-Sleep -Seconds 30"])
                .spawn()
                .unwrap();
            let id = enrollment.id.clone();
            // SAFETY: the test child is alive; only synchronize access is requested.
            let parent = unsafe {
                windows_sys::Win32::System::Threading::OpenProcess(
                    windows_sys::Win32::System::Threading::PROCESS_SYNCHRONIZE,
                    0,
                    caller.id(),
                )
            };
            assert!(!parent.is_null());
            // SAFETY: OpenProcess returned a newly owned handle.
            let parent = unsafe { OwnedHandle::from_raw_handle(parent) };
            let child = std::thread::spawn(move || {
                Enrollment::wait_for_caller(&id, &parent).map_err(|error| error.to_string())
            });
            // SAFETY: the event handle remains live throughout the bounded wait.
            assert_eq!(
                unsafe { WaitForSingleObject(enrollment.ready.as_raw_handle(), 5000) },
                WAIT_OBJECT_0
            );
            assert!(!child.is_finished(), "registration alone must not commit");
            if commit {
                signal(&enrollment.commit).unwrap();
            } else {
                caller.kill().unwrap();
                caller.wait().unwrap();
            }
            let result = child.join().unwrap();
            if commit {
                assert!(result.is_ok());
                caller.kill().unwrap();
                caller.wait().unwrap();
            } else {
                assert!(result
                    .unwrap_err()
                    .contains("restoring the previous service"));
            }
        }
    }
}
