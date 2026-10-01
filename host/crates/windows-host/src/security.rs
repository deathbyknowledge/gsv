use std::{
    ffi::{c_void, OsStr},
    io, mem,
    os::windows::ffi::OsStrExt,
    ptr,
};
use windows_sys::Win32::{
    Foundation::{CloseHandle, LocalFree, HANDLE, HLOCAL},
    Security::{
        Authorization::{
            ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
            SDDL_REVISION_1,
        },
        GetTokenInformation, TokenUser, PSECURITY_DESCRIPTOR, TOKEN_QUERY, TOKEN_USER,
    },
    System::Threading::{
        GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
    },
};
pub struct SecurityDescriptor {
    pub pointer: PSECURITY_DESCRIPTOR,
}

impl SecurityDescriptor {
    pub fn new(current_sid: &str) -> io::Result<Self> {
        Self::from_sddl(&format!("D:P(A;;GA;;;{current_sid})"))
    }
    pub fn from_sddl(sddl: &str) -> io::Result<Self> {
        let encoded = wide_null(OsStr::new(sddl));
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

impl Drop for SecurityDescriptor {
    fn drop(&mut self) {
        if !self.pointer.is_null() {
            // SAFETY: Windows allocated this descriptor with LocalAlloc.
            unsafe {
                LocalFree(self.pointer.cast::<c_void>() as HLOCAL);
            }
        }
    }
}

pub fn current_user_sid_string() -> io::Result<String> {
    // SAFETY: GetCurrentProcess returns a non-owned pseudo-handle.
    let process = unsafe { GetCurrentProcess() };
    sid_string_for_process_handle(process)
}

pub fn sid_string_for_process_id(process_id: u32) -> io::Result<String> {
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
