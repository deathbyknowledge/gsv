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

/// Creates a managed directory atomically with its final ACL. Existing paths
/// must be administrator-owned ordinary directories, never junctions or links.
pub fn protect_directory(path: &std::path::Path, sddl: &str) -> io::Result<()> {
    use std::os::windows::fs::MetadataExt;
    use windows_sys::Win32::{
        Foundation::ERROR_ALREADY_EXISTS,
        Security::{
            Authorization::{GetNamedSecurityInfoW, SetNamedSecurityInfoW, SE_FILE_OBJECT},
            GetSecurityDescriptorDacl, GetSecurityDescriptorOwner, DACL_SECURITY_INFORMATION,
            OWNER_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION, SECURITY_ATTRIBUTES,
        },
        Storage::FileSystem::{CreateDirectoryW, FILE_ATTRIBUTE_REPARSE_POINT},
    };
    let descriptor = SecurityDescriptor::from_sddl(sddl)?;
    let name = wide_null(path.as_os_str());
    let attributes = SECURITY_ATTRIBUTES {
        nLength: mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.pointer,
        bInheritHandle: 0,
    };
    // SAFETY: name and the descriptor remain live throughout this call.
    if unsafe { CreateDirectoryW(name.as_ptr(), &attributes) } == 0 {
        let error = io::Error::last_os_error();
        if error.raw_os_error() != Some(ERROR_ALREADY_EXISTS as i32) {
            return Err(error);
        }
    }
    let metadata = std::fs::symlink_metadata(path)?;
    if !metadata.is_dir() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Managed service paths cannot be links or junctions",
        ));
    }
    let mut owner = ptr::null_mut();
    let mut existing = ptr::null_mut();
    // SAFETY: valid path and output pointers; existing owns the returned allocation.
    let result = unsafe {
        GetNamedSecurityInfoW(
            name.as_ptr(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION,
            &mut owner,
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            &mut existing,
        )
    };
    if result != 0 {
        return Err(io::Error::from_raw_os_error(result as i32));
    }
    let existing = SecurityDescriptor { pointer: existing };
    let owner_sid = sid_to_string(owner)?;
    if owner_sid != "S-1-5-32-544" && owner_sid != "S-1-5-18" {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "An administrator must remove the existing untrusted GSV service directory",
        ));
    }
    drop(existing);
    let mut dacl = ptr::null_mut();
    let mut present = 0;
    let mut defaulted = 0;
    // SAFETY: the descriptor was successfully parsed above and outputs are writable.
    unsafe {
        if GetSecurityDescriptorOwner(descriptor.pointer, &mut owner, &mut defaulted) == 0
            || GetSecurityDescriptorDacl(
                descriptor.pointer,
                &mut present,
                &mut dacl,
                &mut defaulted,
            ) == 0
            || present == 0
            || dacl.is_null()
            || owner.is_null()
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Managed directory requires an owner and an explicit ACL",
            ));
        }
        let result = SetNamedSecurityInfoW(
            name.as_ptr(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION
                | DACL_SECURITY_INFORMATION
                | PROTECTED_DACL_SECURITY_INFORMATION,
            owner,
            ptr::null_mut(),
            dacl,
            ptr::null_mut(),
        );
        if result != 0 {
            return Err(io::Error::from_raw_os_error(result as i32));
        }
    }
    Ok(())
}
