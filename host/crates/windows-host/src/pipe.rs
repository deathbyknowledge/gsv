use crate::security::{current_user_sid_string, SecurityDescriptor};
use std::{
    ffi::OsStr,
    fs::File,
    io,
    os::windows::{
        ffi::OsStrExt,
        io::{AsRawHandle, FromRawHandle},
    },
    ptr,
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::{ERROR_PIPE_CONNECTED, ERROR_PIPE_LISTENING, INVALID_HANDLE_VALUE},
    Security::SECURITY_ATTRIBUTES,
    Storage::FileSystem::{FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_INBOUND},
    System::Pipes::{
        ConnectNamedPipe, CreateNamedPipeW, GetNamedPipeClientProcessId,
        GetNamedPipeServerProcessId, SetNamedPipeHandleState, PIPE_NOWAIT,
        PIPE_REJECT_REMOTE_CLIENTS,
    },
};

/// A unique, local-only event pipe, accessible only by the current OS user.
pub fn create(name: &OsStr) -> io::Result<File> {
    let descriptor = SecurityDescriptor::new(&current_user_sid_string()?)?;
    let attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.pointer,
        bInheritHandle: 0,
    };
    let name: Vec<u16> = name.encode_wide().chain(Some(0)).collect();
    // SAFETY: the terminated name and descriptor remain valid for this call.
    let handle = unsafe {
        CreateNamedPipeW(
            name.as_ptr(),
            PIPE_ACCESS_INBOUND | FILE_FLAG_FIRST_PIPE_INSTANCE,
            PIPE_NOWAIT | PIPE_REJECT_REMOTE_CLIENTS,
            1,
            4096,
            4096,
            0,
            &attributes,
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: CreateNamedPipeW returned a uniquely owned file handle.
    Ok(unsafe { File::from_raw_handle(handle) })
}

/// Bound connection time and authenticate the exact spawned helper process.
pub fn accept(pipe: &File, child_pid: u32, timeout: Duration) -> io::Result<()> {
    let deadline = Instant::now() + timeout;
    loop {
        // SAFETY: pipe is a live synchronous named pipe in nonblocking mode.
        let connected = unsafe { ConnectNamedPipe(pipe.as_raw_handle(), ptr::null_mut()) };
        let error = io::Error::last_os_error();
        if connected != 0 || error.raw_os_error() == Some(ERROR_PIPE_CONNECTED as i32) {
            break;
        }
        if error.raw_os_error() != Some(ERROR_PIPE_LISTENING as i32) {
            return Err(error);
        }
        if Instant::now() >= deadline {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "helper did not connect",
            ));
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let mut pid = 0;
    // SAFETY: the connected pipe and output pointer are valid.
    if unsafe { GetNamedPipeClientProcessId(pipe.as_raw_handle(), &mut pid) } == 0 {
        return Err(io::Error::last_os_error());
    }
    if pid != child_pid {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "unexpected helper process",
        ));
    }
    let mode = 0;
    // SAFETY: switch the connected byte pipe to blocking reads for the reader thread.
    if unsafe { SetNamedPipeHandleState(pipe.as_raw_handle(), &mode, ptr::null(), ptr::null()) }
        == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

pub fn connect(name: &OsStr, parent_pid: u32) -> io::Result<File> {
    let file = std::fs::OpenOptions::new().write(true).open(name)?;
    let mut pid = 0;
    // SAFETY: file is the connected pipe and pid is a valid output pointer.
    if unsafe { GetNamedPipeServerProcessId(file.as_raw_handle(), &mut pid) } == 0 {
        return Err(io::Error::last_os_error());
    }
    if pid != parent_pid {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "unexpected Desktop process",
        ));
    }
    Ok(file)
}
