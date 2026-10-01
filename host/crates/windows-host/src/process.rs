use std::{
    io, mem,
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    ptr,
};
use windows_sys::Win32::{
    Foundation::HANDLE,
    System::{
        JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        },
        Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE},
    },
};

/// Owns every descendant of an operation; closing the job stops the whole tree.
#[derive(Debug)]
pub struct ProcessTree(OwnedHandle);
impl ProcessTree {
    pub fn new() -> io::Result<Self> {
        // SAFETY: an unnamed job with the caller's default security descriptor.
        let handle = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: the job handle was newly allocated and ownership moves to this guard.
        let job = Self(unsafe { OwnedHandle::from_raw_handle(handle) });
        // SAFETY: this Windows POD structure accepts an all-zero baseline.
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: limits is initialized and has the size required for this information class.
        if unsafe {
            SetInformationJobObject(
                job.0.as_raw_handle(),
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                mem::size_of_val(&limits) as u32,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(job)
    }
    pub fn assign(&self, pid: u32) -> io::Result<()> {
        // SAFETY: OpenProcess validates the ID; the returned handle is owned below.
        let handle = unsafe { OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: the live process handle is uniquely owned.
        let process = unsafe { OwnedHandle::from_raw_handle(handle) };
        // SAFETY: both handles remain live for the assignment.
        if unsafe {
            AssignProcessToJobObject(self.0.as_raw_handle(), process.as_raw_handle() as HANDLE)
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
    pub fn terminate(&self) {
        // SAFETY: only descendants assigned to this owned job are affected.
        unsafe {
            TerminateJobObject(self.0.as_raw_handle(), 1);
        }
    }
}

/// Resume a CREATE_SUSPENDED child only after assigning its entire future tree.
pub fn resume(pid: u32) -> io::Result<()> {
    use windows_sys::Win32::{
        Foundation::INVALID_HANDLE_VALUE,
        System::{
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD,
                THREADENTRY32,
            },
            Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME},
        },
    };
    // SAFETY: requesting a read-only system thread snapshot.
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: the snapshot handle is newly allocated.
    let snapshot = unsafe { OwnedHandle::from_raw_handle(snapshot) };
    // SAFETY: THREADENTRY32 is POD; dwSize is initialized before the API call.
    let mut entry: THREADENTRY32 = unsafe { mem::zeroed() };
    entry.dwSize = mem::size_of::<THREADENTRY32>() as u32;
    // SAFETY: entry points to initialized storage of the declared size.
    let mut found = unsafe { Thread32First(snapshot.as_raw_handle(), &mut entry) };
    while found != 0 {
        if entry.th32OwnerProcessID == pid {
            // SAFETY: the snapshot supplied the thread ID; access is limited to resume.
            let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
            if thread.is_null() {
                return Err(io::Error::last_os_error());
            }
            // SAFETY: OpenThread returned a newly owned handle.
            let thread = unsafe { OwnedHandle::from_raw_handle(thread) };
            // SAFETY: only the primary thread of our still-suspended child is resumed.
            if unsafe { ResumeThread(thread.as_raw_handle()) } == u32::MAX {
                return Err(io::Error::last_os_error());
            }
            return Ok(());
        }
        // SAFETY: the snapshot and output buffer remain valid.
        found = unsafe { Thread32Next(snapshot.as_raw_handle(), &mut entry) };
    }
    Err(io::Error::new(
        io::ErrorKind::NotFound,
        "suspended child thread disappeared",
    ))
}
