use std::{
    ffi::{c_void, OsStr},
    io, mem,
    os::windows::{ffi::OsStrExt, io::AsRawHandle},
    ptr,
    time::Duration,
};

use tokio::net::windows::named_pipe::{
    ClientOptions as PipeClientOptions, NamedPipeClient, NamedPipeServer,
    ServerOptions as PipeServerOptions,
};
use windows_sys::Win32::{
    Foundation::{
        CloseHandle, GetLastError, LocalFree, ERROR_ACCESS_DENIED, ERROR_PIPE_BUSY, HANDLE, HLOCAL,
    },
    Security::{
        Authorization::{
            ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
            SDDL_REVISION_1,
        },
        GetTokenInformation, TokenUser, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES, TOKEN_QUERY,
        TOKEN_USER,
    },
    System::{
        Pipes::{GetNamedPipeClientProcessId, GetNamedPipeServerProcessId},
        Threading::{
            GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
        },
    },
};

use crate::{DaemonControlEndpoint, Error, TimeoutStage, MAX_FRAME_BYTES};

const MAX_PIPE_INSTANCES: usize = 32;

pub(crate) struct BoundListener {
    waiting: Option<NamedPipeServer>,
    endpoint: DaemonControlEndpoint,
    current_sid: String,
}

impl BoundListener {
    pub(crate) fn bind(endpoint: &DaemonControlEndpoint) -> Result<Self, Error> {
        let current_sid = current_user_sid_string()?;
        let waiting = create_pipe(endpoint, &current_sid, true).map_err(|error| {
            if error.raw_os_error() == Some(ERROR_ACCESS_DENIED as i32) {
                Error::AlreadyRunning
            } else {
                Error::Io(error)
            }
        })?;
        Ok(Self {
            waiting: Some(waiting),
            endpoint: endpoint.clone(),
            current_sid,
        })
    }

    pub(crate) async fn accept(&mut self) -> Result<NamedPipeServer, Error> {
        let waiting = self.waiting.take().ok_or_else(|| {
            Error::Io(io::Error::new(
                io::ErrorKind::NotConnected,
                "gsvd control listener is closed",
            ))
        })?;
        waiting.connect().await.map_err(Error::Io)?;
        self.waiting =
            Some(create_pipe(&self.endpoint, &self.current_sid, false).map_err(Error::Io)?);
        verify_client_identity(&waiting, &self.current_sid)?;
        Ok(waiting)
    }
}

pub(crate) async fn connect(
    endpoint: &DaemonControlEndpoint,
    timeout: Duration,
) -> Result<NamedPipeClient, Error> {
    let operation = async {
        loop {
            match PipeClientOptions::new().open(endpoint.pipe_name()) {
                Ok(client) => return Ok(client),
                Err(error) if error.raw_os_error() == Some(ERROR_PIPE_BUSY as i32) => {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
                Err(error) => return Err(Error::Io(error)),
            }
        }
    };
    let client = tokio::time::timeout(timeout, operation)
        .await
        .map_err(|_| Error::Timeout {
            stage: TimeoutStage::Connect,
            duration: timeout,
        })??;
    verify_server_identity(&client, &current_user_sid_string()?)?;
    Ok(client)
}

fn create_pipe(
    endpoint: &DaemonControlEndpoint,
    current_sid: &str,
    first_instance: bool,
) -> io::Result<NamedPipeServer> {
    let descriptor = CurrentUserSecurityDescriptor::new(current_sid)?;
    let mut attributes = SECURITY_ATTRIBUTES {
        nLength: u32::try_from(mem::size_of::<SECURITY_ATTRIBUTES>())
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "attributes too large"))?,
        lpSecurityDescriptor: descriptor.pointer,
        bInheritHandle: 0,
    };
    let mut options = PipeServerOptions::new();
    options
        .first_pipe_instance(first_instance)
        .reject_remote_clients(true)
        .max_instances(MAX_PIPE_INSTANCES)
        .in_buffer_size(MAX_FRAME_BYTES as u32)
        .out_buffer_size(MAX_FRAME_BYTES as u32);
    // SAFETY: the descriptor remains alive for CreateNamedPipeW and Tokio does
    // not retain the pointer after this call.
    unsafe {
        options.create_with_security_attributes_raw(
            endpoint.pipe_name(),
            (&mut attributes as *mut SECURITY_ATTRIBUTES).cast::<c_void>(),
        )
    }
}

struct CurrentUserSecurityDescriptor {
    pointer: PSECURITY_DESCRIPTOR,
}

impl CurrentUserSecurityDescriptor {
    fn new(current_sid: &str) -> io::Result<Self> {
        let encoded = wide_null(OsStr::new(&format!("D:P(A;;GA;;;{current_sid})")));
        let mut pointer = ptr::null_mut();
        // SAFETY: encoded is NUL-terminated and pointer is a valid out pointer.
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                encoded.as_ptr(),
                SDDL_REVISION_1,
                &mut pointer,
                ptr::null_mut(),
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(Self { pointer })
    }
}

impl Drop for CurrentUserSecurityDescriptor {
    fn drop(&mut self) {
        if !self.pointer.is_null() {
            // SAFETY: Windows allocated this descriptor with LocalAlloc.
            unsafe {
                LocalFree(self.pointer.cast::<c_void>() as HLOCAL);
            }
        }
    }
}

pub(crate) fn current_user_sid_string() -> Result<String, Error> {
    // SAFETY: GetCurrentProcess returns a non-owned pseudo-handle.
    let process = unsafe { GetCurrentProcess() };
    sid_string_for_process_handle(process).map_err(Error::Io)
}

fn sid_string_for_process_id(process_id: u32) -> io::Result<String> {
    // SAFETY: the returned process handle is owned by the guard below.
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id) };
    if process.is_null() {
        return Err(io::Error::last_os_error());
    }
    let process = OwnedHandle(process);
    sid_string_for_process_handle(process.0)
}

fn sid_string_for_process_handle(process: HANDLE) -> io::Result<String> {
    let mut token = ptr::null_mut();
    // SAFETY: token is a valid out pointer and process is live.
    if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let token = OwnedHandle(token);
    let mut required = 0_u32;
    // SAFETY: the first call intentionally queries the required size.
    unsafe {
        GetTokenInformation(token.0, TokenUser, ptr::null_mut(), 0, &mut required);
    }
    if required == 0 {
        return Err(io::Error::last_os_error());
    }
    let word_count = (required as usize).div_ceil(mem::size_of::<usize>());
    let mut storage = vec![0_usize; word_count];
    // SAFETY: storage is aligned and large enough for TOKEN_USER.
    if unsafe {
        GetTokenInformation(
            token.0,
            TokenUser,
            storage.as_mut_ptr().cast::<c_void>(),
            required,
            &mut required,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: GetTokenInformation initialized TOKEN_USER at the buffer start.
    let token_user = unsafe { &*storage.as_ptr().cast::<TOKEN_USER>() };
    sid_to_string(token_user.User.Sid)
}

fn sid_to_string(sid: windows_sys::Win32::Security::PSID) -> io::Result<String> {
    let mut string_pointer = ptr::null_mut();
    // SAFETY: sid is live and string_pointer is a valid out pointer.
    if unsafe { ConvertSidToStringSidW(sid, &mut string_pointer) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut length = 0;
    // SAFETY: the returned value is a NUL-terminated UTF-16 string.
    unsafe {
        while *string_pointer.add(length) != 0 {
            length += 1;
        }
    }
    // SAFETY: the preceding loop found the initialized string length.
    let slice = unsafe { std::slice::from_raw_parts(string_pointer, length) };
    let result = String::from_utf16(slice)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "SID is invalid UTF-16"));
    // SAFETY: Windows allocated this string with LocalAlloc.
    unsafe {
        LocalFree(string_pointer.cast::<c_void>() as HLOCAL);
    }
    result
}

fn verify_client_identity(server: &NamedPipeServer, current_sid: &str) -> Result<(), Error> {
    let mut process_id = 0_u32;
    // SAFETY: server is connected and process_id is a valid out pointer.
    if unsafe {
        GetNamedPipeClientProcessId(server.as_raw_handle().cast::<c_void>(), &mut process_id)
    } == 0
    {
        return Err(last_windows_error());
    }
    verify_process_sid(process_id, current_sid)
}

fn verify_server_identity(client: &NamedPipeClient, current_sid: &str) -> Result<(), Error> {
    let mut process_id = 0_u32;
    // SAFETY: client is connected and process_id is a valid out pointer.
    if unsafe {
        GetNamedPipeServerProcessId(client.as_raw_handle().cast::<c_void>(), &mut process_id)
    } == 0
    {
        return Err(last_windows_error());
    }
    verify_process_sid(process_id, current_sid)
}

fn verify_process_sid(process_id: u32, current_sid: &str) -> Result<(), Error> {
    if sid_string_for_process_id(process_id).map_err(Error::Io)? != current_sid {
        return Err(Error::PeerIdentity);
    }
    Ok(())
}

fn last_windows_error() -> Error {
    // SAFETY: called immediately after the failing Windows API.
    Error::Io(io::Error::from_raw_os_error(
        unsafe { GetLastError() } as i32
    ))
}

fn wide_null(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(Some(0)).collect()
}

struct OwnedHandle(HANDLE);

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: this guard exclusively owns the handle.
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}
