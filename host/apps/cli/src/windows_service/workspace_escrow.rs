use super::*;
use std::os::windows::io::{AsRawHandle, OwnedHandle};
use windows_sys::Win32::{
    Foundation::{
        DuplicateHandle, DUPLICATE_SAME_ACCESS, ERROR_NO_DATA, ERROR_PIPE_CONNECTED,
        ERROR_PIPE_LISTENING, WAIT_OBJECT_0, WAIT_TIMEOUT,
    },
    Storage::FileSystem::{
        FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_DUPLEX, SECURITY_IDENTIFICATION,
    },
    System::{
        Pipes::{
            ConnectNamedPipe, CreateNamedPipeW, GetNamedPipeClientProcessId,
            GetNamedPipeServerProcessId, SetNamedPipeHandleState, PIPE_NOWAIT,
            PIPE_REJECT_REMOTE_CLIENTS,
        },
        Threading::{
            GetCurrentProcess, OpenProcess, WaitForSingleObject, PROCESS_DUP_HANDLE,
            PROCESS_SYNCHRONIZE,
        },
    },
};
use workspace_permissions::WorkspaceAcl;

fn pipe_name(id: &str) -> Result<String, DynError> {
    Ok(format!(
        r"\\.\pipe\gsv-install-{}-workspace",
        uuid::Uuid::parse_str(id)?
    ))
}

/// Transfers only handles already opened by the unelevated caller. The pipe's
/// kernel-reported server PID binds their source; arguments never select a
/// different process from which the elevated child could duplicate authority.
pub(super) struct WorkspaceEscrow {
    pipe: File,
    handles: [u8; 16],
    sent: bool,
}

impl WorkspaceEscrow {
    pub(super) fn create(
        id: &str,
        owner: &str,
        workspace: &File,
        previous: Option<&File>,
    ) -> Result<Self, DynError> {
        let descriptor =
            SecurityDescriptor::from_sddl(&format!("D:P(A;;GA;;;{owner})(A;;GA;;;BA)"))?;
        let attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor.pointer,
            bInheritHandle: 0,
        };
        let name: Vec<u16> = pipe_name(id)?.encode_utf16().chain(Some(0)).collect();
        // SAFETY: the descriptor/name remain live; the first-instance flag
        // rejects an existing endpoint and the pipe accepts only local clients.
        let handle = unsafe {
            CreateNamedPipeW(
                name.as_ptr(),
                PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
                PIPE_NOWAIT | PIPE_REJECT_REMOTE_CLIENTS,
                1,
                16,
                16,
                0,
                &attributes,
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err(std::io::Error::last_os_error().into());
        }
        // SAFETY: CreateNamedPipeW returned a newly owned handle.
        let pipe = unsafe { File::from_raw_handle(handle) };
        // Listen before launching the elevated process so it can connect as soon
        // as UAC returns. No authority is sent before checking its actual PID.
        // SAFETY: this newly owned pipe is nonblocking and uses no overlapped I/O.
        if unsafe { ConnectNamedPipe(pipe.as_raw_handle(), std::ptr::null_mut()) } == 0 {
            let error = std::io::Error::last_os_error();
            if !matches!(error.raw_os_error(), Some(value) if value == ERROR_PIPE_LISTENING as i32 || value == ERROR_PIPE_CONNECTED as i32)
            {
                return Err(error.into());
            }
        }
        let mut handles = [0; 16];
        handles[..8].copy_from_slice(&(workspace.as_raw_handle() as usize as u64).to_le_bytes());
        handles[8..].copy_from_slice(
            &(previous.map_or(0, |file| file.as_raw_handle() as usize as u64)).to_le_bytes(),
        );
        Ok(Self {
            pipe,
            handles,
            sent: false,
        })
    }

    fn send_if_connected(&mut self, child_pid: u32) -> Result<(), DynError> {
        if self.sent {
            return Ok(());
        }
        // SAFETY: this nonblocking pipe remains owned; no overlapped I/O is used.
        if unsafe { ConnectNamedPipe(self.pipe.as_raw_handle(), std::ptr::null_mut()) } != 0 {
            // In NOWAIT mode the first successful call starts listening.
            return Ok(());
        } else {
            let error = std::io::Error::last_os_error();
            match error.raw_os_error() {
                Some(value) if value == ERROR_PIPE_LISTENING as i32 => return Ok(()),
                Some(value) if value == ERROR_PIPE_CONNECTED as i32 => {}
                _ => return Err(error.into()),
            }
        }
        let mut connected_pid = 0;
        // SAFETY: the connected pipe and output PID remain live.
        if unsafe { GetNamedPipeClientProcessId(self.pipe.as_raw_handle(), &mut connected_pid) }
            == 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
        if connected_pid != child_pid {
            return Err("Only the launched elevated installer may complete enrollment".into());
        }
        self.pipe.write_all(&self.handles)?;
        self.sent = true;
        Ok(())
    }

    pub(super) fn ready(&mut self, child_pid: u32) -> Result<bool, DynError> {
        self.send_if_connected(child_pid)?;
        if !self.sent {
            return Ok(false);
        }
        match read_signal(&mut self.pipe)? {
            Some(b'R') => Ok(true),
            None => Ok(false),
            _ => Err("Invalid enrollment readiness message".into()),
        }
    }

    pub(super) fn complete(&mut self, success: bool) -> Result<(), DynError> {
        Ok(self.pipe.write_all(if success { b"C" } else { b"A" })?)
    }
}

pub(super) struct WorkspaceRollback {
    parent: OwnedHandle,
    pipe: File,
    workspace: WorkspaceAcl,
    previous: Option<WorkspaceAcl>,
}

impl WorkspaceRollback {
    pub(super) fn receive(id: &str, parent_pid: u32) -> Result<Self, DynError> {
        // Identification prevents the unelevated server from impersonating its
        // elevated client. This connection supplies no elevated access token.
        let mut pipe = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .security_qos_flags(SECURITY_IDENTIFICATION)
            .open(pipe_name(id)?)?;
        let mut server_pid = 0;
        // SAFETY: pipe is connected and the output PID is writable.
        if unsafe { GetNamedPipeServerProcessId(pipe.as_raw_handle(), &mut server_pid) } == 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        if server_pid != parent_pid {
            return Err("Workspace authority must come from the enrolling process".into());
        }
        // SAFETY: the PID comes from the connected pipe, not solely from arguments.
        let parent =
            unsafe { OpenProcess(PROCESS_DUP_HANDLE | PROCESS_SYNCHRONIZE, 0, server_pid) };
        if parent.is_null() {
            return Err(std::io::Error::last_os_error().into());
        }
        // SAFETY: OpenProcess returned a newly owned handle.
        let parent = unsafe { OwnedHandle::from_raw_handle(parent) };
        let mut handles = [0_u8; 16];
        pipe.read_exact(&mut handles)?;
        let duplicate = |bytes: [u8; 8]| -> Result<Option<WorkspaceAcl>, DynError> {
            let source = u64::from_le_bytes(bytes);
            if source == 0 {
                return Ok(None);
            }
            let mut destination = std::ptr::null_mut();
            // SAFETY: GetCurrentProcess returns a non-owned pseudo-handle.
            let current = unsafe { GetCurrentProcess() };
            // SAFETY: process/output handles are live. SAME_ACCESS is essential:
            // the elevated token must never request greater rights on this object.
            if unsafe {
                DuplicateHandle(
                    parent.as_raw_handle(),
                    source as usize as _,
                    current,
                    &mut destination,
                    0,
                    0,
                    DUPLICATE_SAME_ACCESS,
                )
            } == 0
            {
                return Err(std::io::Error::last_os_error().into());
            }
            // SAFETY: DuplicateHandle returned a newly owned handle.
            let file = unsafe { File::from_raw_handle(destination) };
            if !file.metadata()?.is_dir() {
                return Err("Workspace authority must refer to a directory".into());
            }
            Ok(Some(WorkspaceAcl::capture(file)?))
        };
        let workspace =
            duplicate(handles[..8].try_into()?)?.ok_or("Missing workspace authority")?;
        let previous = duplicate(handles[8..].try_into()?)?;
        let mode = PIPE_NOWAIT;
        // SAFETY: the connected client owns this pipe; the mode pointer is live.
        if unsafe {
            SetNamedPipeHandleState(
                pipe.as_raw_handle(),
                &mode,
                std::ptr::null(),
                std::ptr::null(),
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(Self {
            parent,
            pipe,
            workspace,
            previous,
        })
    }

    pub(super) fn wait_for_caller(&mut self) -> Result<(), DynError> {
        self.pipe.write_all(b"R")?;
        loop {
            // SAFETY: the authenticated parent process handle remains live.
            match unsafe { WaitForSingleObject(self.parent.as_raw_handle(), 0) } {
                WAIT_TIMEOUT => {}
                WAIT_OBJECT_0 => {
                    return Err("Enrollment cancelled; restoring the previous service".into());
                }
                _ => return Err(std::io::Error::last_os_error().into()),
            }
            match read_signal(&mut self.pipe)? {
                Some(b'C') => return Ok(()),
                Some(b'A') => {
                    return Err("Enrollment cancelled; restoring the previous service".into());
                }
                None => std::thread::sleep(Duration::from_millis(100)),
                _ => return Err("Invalid enrollment completion message".into()),
            }
        }
    }

    pub(super) fn restore(&mut self) -> Result<(), DynError> {
        let workspace = self.workspace.restore();
        let previous = self
            .previous
            .as_mut()
            .map(WorkspaceAcl::restore)
            .transpose();
        workspace?;
        previous?;
        Ok(())
    }
}

fn read_signal(pipe: &mut File) -> Result<Option<u8>, DynError> {
    let mut signal = [0];
    match pipe.read(&mut signal) {
        Ok(0) => Err("Enrollment control pipe closed before completion".into()),
        Ok(_) => Ok(Some(signal[0])),
        Err(error) if error.raw_os_error() == Some(ERROR_NO_DATA as i32) => Ok(None),
        Err(error) => Err(error.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unexpected_process_cannot_send_readiness_or_receive_authority() {
        let directory = tempfile::tempdir().unwrap();
        let file = workspace_acl_access(directory.path()).unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let mut escrow =
            WorkspaceEscrow::create(&id, &current_user_sid_string().unwrap(), &file, None).unwrap();
        let mut impostor = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(pipe_name(&id).unwrap())
            .unwrap();
        impostor.write_all(b"R").unwrap();
        let error = escrow
            .ready(std::process::id().wrapping_add(1))
            .unwrap_err();
        assert!(error.to_string().contains("launched elevated installer"));
        let mode = PIPE_NOWAIT;
        assert_ne!(
            // SAFETY: the test owns this connected pipe and mode remains live.
            unsafe {
                SetNamedPipeHandleState(
                    impostor.as_raw_handle(),
                    &mode,
                    std::ptr::null(),
                    std::ptr::null(),
                )
            },
            0
        );
        assert_eq!(read_signal(&mut impostor).unwrap(), None);
    }

    #[test]
    fn enrollment_ignores_named_signals_and_requires_the_callers_commit() {
        use windows_sys::Win32::System::Threading::CreateEventW;

        for outcome in ["commit", "abort", "caller_exit", "disconnect"] {
            let directory = tempfile::tempdir().unwrap();
            let file = workspace_acl_access(directory.path()).unwrap();
            let id = uuid::Uuid::new_v4().to_string();
            let mut escrow =
                WorkspaceEscrow::create(&id, &current_user_sid_string().unwrap(), &file, None)
                    .unwrap();
            let _forged: Vec<OwnedHandle> = ["ready", "commit", "abort"]
                .into_iter()
                .map(|suffix| {
                    let name: Vec<u16> = format!("Local\\gsv-install-{id}-{suffix}")
                        .encode_utf16()
                        .chain(Some(0))
                        .collect();
                    // SAFETY: test-owned names are terminated; these unrelated
                    // manual-reset events start signaled, as in the reported attack.
                    let handle = unsafe { CreateEventW(std::ptr::null(), 1, 1, name.as_ptr()) };
                    assert!(!handle.is_null());
                    // SAFETY: CreateEventW returned a newly owned handle.
                    unsafe { OwnedHandle::from_raw_handle(handle) }
                })
                .collect();
            let mut caller = Command::new(system_tool(r"WindowsPowerShell\v1.0\powershell.exe"))
                .args(["-NoProfile", "-Command", "Start-Sleep -Seconds 30"])
                .spawn()
                .unwrap();
            // SAFETY: the test child is alive and only synchronization is requested.
            let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, caller.id()) };
            assert!(!handle.is_null());
            // SAFETY: OpenProcess returned a newly owned handle.
            let parent = unsafe { OwnedHandle::from_raw_handle(handle) };
            let worker = std::thread::spawn(move || {
                let mut rollback = WorkspaceRollback::receive(&id, std::process::id()).unwrap();
                // The real pipe authenticates this test process; substitute only
                // its liveness handle so the test can exercise actual process exit.
                rollback.parent = parent;
                rollback
                    .wait_for_caller()
                    .map_err(|error| error.to_string())
            });
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            while !escrow.ready(std::process::id()).unwrap() {
                assert!(std::time::Instant::now() < deadline, "readiness timed out");
                std::thread::sleep(Duration::from_millis(10));
            }
            std::thread::sleep(Duration::from_millis(150));
            assert!(
                !worker.is_finished(),
                "named events must not complete enrollment"
            );
            match outcome {
                "commit" => escrow.complete(true).unwrap(),
                "abort" => escrow.complete(false).unwrap(),
                "caller_exit" => {
                    caller.kill().unwrap();
                    caller.wait().unwrap();
                }
                _ => drop(escrow),
            }
            let result = worker.join().unwrap();
            assert_eq!(result.is_ok(), outcome == "commit", "{outcome}: {result:?}");
            if caller.try_wait().unwrap().is_none() {
                caller.kill().unwrap();
                caller.wait().unwrap();
            }
        }
    }

    #[test]
    fn transferred_handles_survive_close_without_gaining_access() {
        for writable in [true, false] {
            let directory = tempfile::tempdir().unwrap();
            let access = READ_CONTROL | FILE_READ_ATTRIBUTES | if writable { WRITE_DAC } else { 0 };
            let file = fs::OpenOptions::new()
                .access_mode(access)
                .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
                .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
                .open(directory.path())
                .unwrap();
            let id = uuid::Uuid::new_v4().to_string();
            let mut escrow =
                WorkspaceEscrow::create(&id, &current_user_sid_string().unwrap(), &file, None)
                    .unwrap();
            escrow.send_if_connected(std::process::id()).unwrap();
            let (ready_tx, ready_rx) = std::sync::mpsc::channel();
            let (close_tx, close_rx) = std::sync::mpsc::channel();
            let worker = std::thread::spawn(move || {
                let mut rollback = WorkspaceRollback::receive(&id, std::process::id()).unwrap();
                ready_tx.send(()).unwrap();
                close_rx.recv().unwrap();
                rollback.restore().is_ok()
            });
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            loop {
                escrow.send_if_connected(std::process::id()).unwrap();
                if ready_rx.try_recv().is_ok() {
                    break;
                }
                assert!(
                    std::time::Instant::now() < deadline,
                    "handle transfer timed out"
                );
                std::thread::sleep(Duration::from_millis(10));
            }
            drop(file);
            close_tx.send(()).unwrap();
            assert_eq!(
                worker.join().unwrap(),
                writable,
                "duplication must preserve the caller's original authority"
            );
        }
    }
}
