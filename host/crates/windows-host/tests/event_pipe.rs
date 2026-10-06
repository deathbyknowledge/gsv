#![cfg(windows)]
use std::{
    io::{Read, Write},
    process::Command,
    time::Duration,
};
use windows_host::pipe;

#[test]
fn helper_pipe_child() {
    let Some(name) = std::env::var_os("GSV_TEST_EVENT_PIPE") else {
        return;
    };
    let parent = std::env::var("GSV_TEST_EVENT_PARENT")
        .unwrap()
        .parse()
        .unwrap();
    let mut stream = pipe::connect(&name, parent).unwrap();
    stream.write_all("hello 日本語".as_bytes()).unwrap();
}

#[test]
fn event_pipe_authenticates_helper_and_transfers_utf8() {
    let directory = tempfile::tempdir().unwrap();
    let name = format!(
        r"\\.\pipe\gsv-event-test-{}-{}",
        std::process::id(),
        directory.path().file_name().unwrap().to_string_lossy()
    );
    let mut stream = pipe::create(name.as_ref()).unwrap();
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "helper_pipe_child"])
        .env("GSV_TEST_EVENT_PIPE", &name)
        .env("GSV_TEST_EVENT_PARENT", std::process::id().to_string())
        .spawn()
        .unwrap();
    pipe::accept(&stream, child.id(), Duration::from_secs(5)).unwrap();
    let mut bytes = vec![0; "hello 日本語".len()];
    stream.read_exact(&mut bytes).unwrap();
    assert_eq!(bytes, "hello 日本語".as_bytes());
    assert!(child.wait().unwrap().success());
}

#[test]
fn event_pipe_rejects_the_wrong_helper_pid() {
    let directory = tempfile::tempdir().unwrap();
    let name = format!(
        r"\\.\pipe\gsv-event-reject-{}-{}",
        std::process::id(),
        directory.path().file_name().unwrap().to_string_lossy()
    );
    let stream = pipe::create(name.as_ref()).unwrap();
    let client = std::thread::spawn(move || pipe::connect(name.as_ref(), std::process::id()));
    let error = pipe::accept(&stream, u32::MAX, Duration::from_secs(5)).unwrap_err();
    assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);
    drop(stream);
    assert!(client.join().unwrap().is_err());
}
