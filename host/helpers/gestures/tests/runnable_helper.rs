#![cfg(unix)]

use std::fs::File;
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::process::CommandExt as _;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use gesture_protocol::{
    read_frame, HelperEvent, SessionId, EVENT_CHANNEL_CONTRACT_MARKER, EVENT_FD,
    EVENT_FD_MARKER_ENV, PROTOCOL_VERSION, SESSION_HIGH_ENV, SESSION_LOW_ENV,
};

const PARENT_STDIN_WATCHDOG: &str = "GSV_VISION_PARENT_STDIN";
const ENABLED_MARKER: &str = "1";
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
const EXIT_TIMEOUT: Duration = Duration::from_secs(2);
const SESSION: SessionId = SessionId::new(0x1020_3040_5060_7080, 0x90A0_B0C0_D0E0_F001);

#[test]
fn runnable_helper_uses_the_current_event_channel_contract() {
    assert_eq!(PROTOCOL_VERSION, 1);
    assert_ne!(EVENT_CHANNEL_CONTRACT_MARKER, ENABLED_MARKER);

    let (mut event_input, event_output) = anonymous_pipe().expect("event pipe is available");
    let event_output_fd = event_output.as_raw_fd();
    let mut command = Command::new(env!("CARGO_BIN_EXE_gsv-vision"));
    command
        .env_clear()
        .env(PARENT_STDIN_WATCHDOG, ENABLED_MARKER)
        .env(EVENT_FD_MARKER_ENV, EVENT_CHANNEL_CONTRACT_MARKER)
        .env(SESSION_HIGH_ENV, SESSION.high().to_string())
        .env(SESSION_LOW_ENV, SESSION.low().to_string())
        // Hello is emitted before asset resolution. Fail there deliberately so
        // this executable-level contract test can never proceed to the camera.
        // Embedded assets cannot fail at runtime, so camera parsing is the bound.
        .env("GSV_VISION_NATIVE_MODELS", "")
        .env("GSV_VISION_CAMERA", "64")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // SAFETY: the callback performs only async-signal-safe descriptor operations.
    unsafe {
        command.pre_exec(move || map_event_fd(event_output_fd));
    }

    let child = command.spawn().expect("runnable helper starts");
    drop(event_output);
    let mut child = ChildGuard::new(child);
    let parent_input = child
        .child_mut()
        .stdin
        .take()
        .expect("helper parent input is piped");

    let (handshake_sender, handshake_receiver) = mpsc::sync_channel(1);
    let reader = thread::Builder::new()
        .name("gsv-vision-integration-handshake".to_string())
        .spawn(move || {
            let result =
                read_frame::<HelperEvent>(&mut event_input).map_err(|error| error.to_string());
            let _ = handshake_sender.send(result);
        })
        .expect("handshake reader starts");
    let hello = handshake_receiver
        .recv_timeout(HANDSHAKE_TIMEOUT)
        .expect("runnable helper sends a bounded handshake")
        .expect("runnable helper sends a valid frame")
        .expect("runnable helper does not close before Hello");
    reader.join().expect("handshake reader finishes");

    assert_eq!(
        hello,
        HelperEvent::Hello {
            protocol_version: PROTOCOL_VERSION,
            session_id: SESSION,
        }
    );

    drop(parent_input);
    let _ = child
        .wait_timeout(EXIT_TIMEOUT)
        .expect("helper exits and is reaped after parent input closes");
}

struct ChildGuard {
    child: Option<Child>,
}

impl ChildGuard {
    fn new(child: Child) -> Self {
        Self { child: Some(child) }
    }

    fn child_mut(&mut self) -> &mut Child {
        self.child.as_mut().expect("child remains owned")
    }

    fn wait_timeout(&mut self, timeout: Duration) -> io::Result<ExitStatus> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(status) = self.child_mut().try_wait()? {
                self.child = None;
                return Ok(status);
            }
            if Instant::now() >= deadline {
                let mut child = self.child.take().expect("child remains owned");
                let _ = child.kill();
                let _ = child.wait();
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "helper did not exit after parent input closed",
                ));
            }
            thread::sleep(Duration::from_millis(10));
        }
    }
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        let Some(mut child) = self.child.take() else {
            return;
        };
        if child.try_wait().ok().flatten().is_none() {
            let _ = child.kill();
        }
        let _ = child.wait();
    }
}

fn anonymous_pipe() -> io::Result<(File, OwnedFd)> {
    let mut descriptors = [-1; 2];
    #[cfg(any(target_os = "linux", target_os = "android"))]
    let status = {
        // SAFETY: `descriptors` has storage for both descriptors returned by pipe2.
        unsafe { libc::pipe2(descriptors.as_mut_ptr(), libc::O_CLOEXEC) }
    };
    #[cfg(not(any(target_os = "linux", target_os = "android")))]
    let status = {
        // SAFETY: `descriptors` has storage for both descriptors returned by pipe.
        let status = unsafe { libc::pipe(descriptors.as_mut_ptr()) };
        if status == 0 {
            for descriptor in descriptors {
                // SAFETY: the descriptor was returned by pipe and remains open here.
                let flags = unsafe { libc::fcntl(descriptor, libc::F_GETFD) };
                if flags == -1
                    // SAFETY: the descriptor remains live and `flags` came from F_GETFD.
                    || unsafe {
                        libc::fcntl(descriptor, libc::F_SETFD, flags | libc::FD_CLOEXEC)
                    } == -1
                {
                    // SAFETY: both descriptors are owned by this function.
                    unsafe {
                        libc::close(descriptors[0]);
                        libc::close(descriptors[1]);
                    }
                    return Err(io::Error::last_os_error());
                }
            }
        }
        status
    };
    if status == -1 {
        return Err(io::Error::last_os_error());
    }

    // SAFETY: successful pipe creation returned two newly owned descriptors.
    let reader = unsafe { OwnedFd::from_raw_fd(descriptors[0]) };
    // SAFETY: successful pipe creation returned two newly owned descriptors.
    let writer = unsafe { OwnedFd::from_raw_fd(descriptors[1]) };
    Ok((File::from(reader), writer))
}

fn map_event_fd(parent_fd: RawFd) -> io::Result<()> {
    if parent_fd == EVENT_FD {
        // SAFETY: EVENT_FD is inherited and F_GETFD has no pointer arguments.
        let flags = unsafe { libc::fcntl(EVENT_FD, libc::F_GETFD) };
        if flags == -1 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: EVENT_FD remains live and this only clears close-on-exec.
        if unsafe { libc::fcntl(EVENT_FD, libc::F_SETFD, flags & !libc::FD_CLOEXEC) } == -1 {
            return Err(io::Error::last_os_error());
        }
    } else {
        // SAFETY: parent_fd is the live pipe writer and dup2 atomically installs EVENT_FD.
        if unsafe { libc::dup2(parent_fd, EVENT_FD) } == -1 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}
