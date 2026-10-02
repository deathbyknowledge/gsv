use super::*;
use std::os::windows::io::AsRawHandle;
use windows_sys::Win32::{
    Foundation::LocalFree,
    Security::{
        AclSizeInformation, AddAce,
        Authorization::{
            GetSecurityInfo, SetEntriesInAclW, SetSecurityInfo, EXPLICIT_ACCESS_W, GRANT_ACCESS,
            NO_MULTIPLE_TRUSTEE, SE_FILE_OBJECT, TRUSTEE_IS_SID, TRUSTEE_IS_UNKNOWN, TRUSTEE_W,
        },
        EqualSid, GetAce, GetAclInformation, GetSecurityDescriptorControl,
        GetSecurityDescriptorDacl, InitializeAcl, LookupAccountNameW, ACCESS_ALLOWED_ACE,
        ACE_HEADER, ACL_SIZE_INFORMATION, CONTAINER_INHERIT_ACE, INHERITED_ACE, OBJECT_INHERIT_ACE,
        PROTECTED_DACL_SECURITY_INFORMATION, SECURITY_MAX_SID_SIZE, SE_DACL_PROTECTED,
        UNPROTECTED_DACL_SECURITY_INFORMATION,
    },
    Storage::FileSystem::{DELETE, FILE_GENERIC_EXECUTE, FILE_GENERIC_READ, FILE_GENERIC_WRITE},
    System::SystemServices::ACCESS_ALLOWED_ACE_TYPE,
};

/// Mutates only the caller's preflight handle, synchronously in its own process.
/// Process exit drains these calls before the transaction owner restores ACLs;
/// no orphaned ACL subprocess can write after rollback.
pub(super) fn change_workspace_grant(file: &File, grant: bool) -> Result<(), DynError> {
    let snapshot = WorkspaceAcl::capture(file.try_clone()?)?;
    let mut dacl = std::ptr::null_mut();
    let mut present = 0;
    let mut defaulted = 0;
    // SAFETY: the snapshot descriptor and output pointers remain live.
    if unsafe {
        GetSecurityDescriptorDacl(
            snapshot.descriptor.pointer,
            &mut present,
            &mut dacl,
            &mut defaulted,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error().into());
    }
    // A null DACL already grants everyone full access and has no explicit grant
    // to revoke. Preserve that existing policy instead of replacing it.
    if dacl.is_null() {
        return Ok(());
    }
    let mut sid = [0_u32; SECURITY_MAX_SID_SIZE as usize / 4];
    let mut sid_size = std::mem::size_of_val(&sid) as u32;
    let mut domain = [0_u16; 256];
    let mut domain_size = domain.len() as u32;
    let mut sid_type = 0;
    let account: Vec<u16> = service::ACCOUNT.encode_utf16().chain(Some(0)).collect();
    // SAFETY: the fixed virtual service account has a bounded SID/domain name;
    // all supplied buffers are aligned, writable and accurately sized.
    if unsafe {
        LookupAccountNameW(
            std::ptr::null(),
            account.as_ptr(),
            sid.as_mut_ptr().cast(),
            &mut sid_size,
            domain.as_mut_ptr(),
            &mut domain_size,
            &mut sid_type,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error().into());
    }
    let apply = |acl| {
        // SAFETY: file has caller-authorized WRITE_DAC; the ACL stays live.
        let error = unsafe {
            SetSecurityInfo(
                file.as_raw_handle(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                acl,
                std::ptr::null_mut(),
            )
        };
        if error == 0 {
            Ok(())
        } else {
            Err(std::io::Error::from_raw_os_error(error as i32).into())
        }
    };
    if grant {
        let access = EXPLICIT_ACCESS_W {
            grfAccessPermissions: FILE_GENERIC_READ
                | FILE_GENERIC_WRITE
                | FILE_GENERIC_EXECUTE
                | DELETE,
            grfAccessMode: GRANT_ACCESS,
            grfInheritance: OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE,
            Trustee: TRUSTEE_W {
                pMultipleTrustee: std::ptr::null_mut(),
                MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE,
                TrusteeForm: TRUSTEE_IS_SID,
                TrusteeType: TRUSTEE_IS_UNKNOWN,
                ptstrName: sid.as_mut_ptr().cast(),
            },
        };
        let mut updated = std::ptr::null_mut();
        // SAFETY: the original ACL, trustee SID and output pointer remain live.
        let error = unsafe { SetEntriesInAclW(1, &access, dacl, &mut updated) };
        if error != 0 {
            return Err(std::io::Error::from_raw_os_error(error as i32).into());
        }
        let result = apply(updated);
        // SAFETY: SetEntriesInAclW allocated this ACL with LocalAlloc.
        unsafe { LocalFree(updated.cast()) };
        return result;
    }
    let mut info = ACL_SIZE_INFORMATION {
        AceCount: 0,
        AclBytesInUse: 0,
        AclBytesFree: 0,
    };
    // SAFETY: the valid ACL and accurately sized output structure remain live.
    if unsafe {
        GetAclInformation(
            dacl,
            (&mut info as *mut ACL_SIZE_INFORMATION).cast(),
            std::mem::size_of_val(&info) as u32,
            AclSizeInformation,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error().into());
    }
    let mut storage = vec![0_u32; (info.AclBytesInUse as usize).div_ceil(4)];
    let updated = storage.as_mut_ptr().cast();
    // SAFETY: GetSecurityDescriptorDacl returned a valid ACL header.
    let revision = unsafe { (*dacl).AclRevision } as u32;
    // SAFETY: storage is aligned and large enough for the original ACL.
    if unsafe { InitializeAcl(updated, (storage.len() * 4) as u32, revision) } == 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    for index in 0..info.AceCount {
        let mut ace = std::ptr::null_mut();
        // SAFETY: index is bounded by the validated ACL's ACE count.
        if unsafe { GetAce(dacl, index, &mut ace) } == 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        // SAFETY: GetAce returned a valid ACE in the live snapshot.
        let header = unsafe { &*ace.cast::<ACE_HEADER>() };
        if header.AceType as u32 == ACCESS_ALLOWED_ACE_TYPE
            && header.AceFlags as u32 & INHERITED_ACE == 0
        {
            // SAFETY: the ACE type identifies this structure and its inline SID.
            let allowed = unsafe { &*ace.cast::<ACCESS_ALLOWED_ACE>() };
            // SAFETY: both SID buffers are validated by Windows and remain live.
            if unsafe {
                EqualSid(
                    std::ptr::addr_of!(allowed.SidStart).cast_mut().cast(),
                    sid.as_mut_ptr().cast(),
                )
            } != 0
            {
                continue;
            }
        }
        // Preserve every other ACE, including explicit denies and inherited grants.
        // SAFETY: the ACL has enough space and this ACE's size comes from its header.
        if unsafe { AddAce(updated, revision, u32::MAX, ace, header.AceSize as u32) } == 0 {
            return Err(std::io::Error::last_os_error().into());
        }
    }
    apply(updated)
}

/// The preflight handle retains WRITE_DAC authority even if an ACL operation
/// fails midway. Restoring the original DACL never requires elevation.
pub(super) struct WorkspaceAcl {
    file: File,
    descriptor: SecurityDescriptor,
    restored: bool,
}

impl WorkspaceAcl {
    pub(super) fn capture(file: File) -> Result<Self, DynError> {
        let mut pointer = std::ptr::null_mut();
        // SAFETY: the file has READ_CONTROL and the output pointer is writable.
        let error = unsafe {
            GetSecurityInfo(
                file.as_raw_handle(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut pointer,
            )
        };
        if error != 0 {
            return Err(std::io::Error::from_raw_os_error(error as i32).into());
        }
        Ok(Self {
            file,
            descriptor: SecurityDescriptor { pointer },
            restored: false,
        })
    }

    pub(super) fn restore(&mut self) -> Result<(), DynError> {
        if self.restored {
            return Ok(());
        }
        let mut dacl = std::ptr::null_mut();
        let mut present = 0;
        let mut defaulted = 0;
        let mut control = 0;
        let mut revision = 0;
        // SAFETY: the captured descriptor and all output pointers remain live.
        if unsafe { GetSecurityDescriptorDacl(self.descriptor.pointer, &mut present, &mut dacl, &mut defaulted) } == 0
            // SAFETY: the captured descriptor and both output pointers are valid.
            || unsafe { GetSecurityDescriptorControl(self.descriptor.pointer, &mut control, &mut revision) } == 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
        let flags = DACL_SECURITY_INFORMATION
            | if control & SE_DACL_PROTECTED != 0 {
                PROTECTED_DACL_SECURITY_INFORMATION
            } else {
                UNPROTECTED_DACL_SECURITY_INFORMATION
            };
        // SAFETY: the handle retains WRITE_DAC and dacl belongs to the live snapshot.
        let error = unsafe {
            SetSecurityInfo(
                self.file.as_raw_handle(),
                SE_FILE_OBJECT,
                flags,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                dacl,
                std::ptr::null_mut(),
            )
        };
        if error != 0 {
            return Err(std::io::Error::from_raw_os_error(error as i32).into());
        }
        self.restored = true;
        Ok(())
    }
}
