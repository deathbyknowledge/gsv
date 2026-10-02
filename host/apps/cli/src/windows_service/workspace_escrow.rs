use super::*;
use enrollment::WorkspaceAcl;
use std::os::windows::io::{AsRawHandle, OwnedHandle};
use windows_sys::Win32::{
    Foundation::{
        DuplicateHandle, DUPLICATE_SAME_ACCESS, ERROR_PIPE_CONNECTED, ERROR_PIPE_LISTENING,
    },
    Storage::FileSystem::{
        FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_OUTBOUND, SECURITY_IDENTIFICATION,
    },
    System::{
        Pipes::{
            ConnectNamedPipe, CreateNamedPipeW, GetNamedPipeServerProcessId, PIPE_NOWAIT,
            PIPE_REJECT_REMOTE_CLIENTS,
        },
        Threading::{GetCurrentProcess, OpenProcess, PROCESS_DUP_HANDLE, PROCESS_SYNCHRONIZE},
    },
};

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
                PIPE_ACCESS_OUTBOUND | FILE_FLAG_FIRST_PIPE_INSTANCE,
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

    pub(super) fn send_if_connected(&mut self) -> Result<(), DynError> {
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
        self.pipe.write_all(&self.handles)?;
        self.sent = true;
        Ok(())
    }
}

pub(super) struct WorkspaceRollback {
    pub(super) parent: OwnedHandle,
    workspace: WorkspaceAcl,
    previous: Option<WorkspaceAcl>,
}

impl WorkspaceRollback {
    pub(super) fn receive(id: &str, parent_pid: u32) -> Result<Self, DynError> {
        // Identification prevents the unelevated server from impersonating its
        // elevated client. This connection supplies no elevated access token.
        let mut pipe = fs::OpenOptions::new()
            .read(true)
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
        Ok(Self {
            parent,
            workspace,
            previous,
        })
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

#[cfg(test)]
mod tests {
    use super::*;

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
            escrow.send_if_connected().unwrap();
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
                escrow.send_if_connected().unwrap();
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
