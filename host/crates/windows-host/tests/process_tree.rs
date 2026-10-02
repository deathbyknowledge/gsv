#![cfg(windows)]
use std::{
    os::windows::{
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
        process::CommandExt,
    },
    process::{Command, Stdio},
    time::{Duration, Instant},
};
use windows_host::process::{resume, ProcessTree};
use windows_sys::Win32::System::Threading::{
    OpenProcess, WaitForSingleObject, SYNCHRONIZATION_SYNCHRONIZE,
};

#[test]
fn cancellation_terminates_a_spawned_grandchild() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("child.pid");
    let script = format!("$child = Start-Process powershell.exe -ArgumentList '-NoProfile -Command Start-Sleep -Seconds 60' -PassThru; [IO.File]::WriteAllText('{}', [string]$child.Id); Start-Sleep -Seconds 60", path.display().to_string().replace('\'', "''"));
    let tree = ProcessTree::new().unwrap();
    let mut child = Command::new("powershell.exe")
        .args(["-NoProfile", "-Command", &script])
        .creation_flags(0x08000000 | 0x00000004)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    tree.assign(child.id()).unwrap();
    resume(child.id()).unwrap();
    let deadline = Instant::now() + Duration::from_secs(15);
    let pid = loop {
        if let Ok(value) = std::fs::read_to_string(&path) {
            if let Ok(pid) = value.trim().parse() {
                break pid;
            }
        }
        assert!(Instant::now() < deadline, "grandchild did not start");
        std::thread::sleep(Duration::from_millis(20));
    };
    // SAFETY: query only the synchronization state of this freshly spawned child.
    let handle = unsafe { OpenProcess(SYNCHRONIZATION_SYNCHRONIZE, 0, pid) };
    assert!(!handle.is_null());
    // SAFETY: OpenProcess returned a newly owned handle.
    let grandchild = unsafe { OwnedHandle::from_raw_handle(handle) };
    tree.terminate();
    assert!(!child.wait().unwrap().success());
    // SAFETY: grandchild remains a valid owned process handle.
    assert_eq!(
        unsafe { WaitForSingleObject(grandchild.as_raw_handle(), 5000) },
        0
    );
}
