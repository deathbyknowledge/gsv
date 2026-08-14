use std::env;
use std::ffi::{OsStr, OsString};
use std::fmt;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::thread::JoinHandle;

const PARENT_STDIN_WATCHDOG: &str = "GSV_VISION_PARENT_STDIN";

const HELPER_ENVIRONMENT: &[&str] = &[
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
    "XAUTHORITY",
    "PATH",
    "LD_LIBRARY_PATH",
    "DYLD_LIBRARY_PATH",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "GSV_MEDIAPIPE_LIBRARY",
    "GSV_VISION_MODEL",
    "GSV_VISION_CAMERA",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum VisionDebugError {
    InvalidOverride,
    NotInstalled,
    StartFailed,
}

impl fmt::Display for VisionDebugError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidOverride => "GSV_VISION_HELPER does not name a file",
            Self::NotInstalled => "gsv-vision was not found",
            Self::StartFailed => "gsv-vision could not be started",
        })
    }
}

pub(crate) struct VisionDebug {
    child: Option<Child>,
    // This pipe carries no data. Keeping its write end alive couples the
    // helper to Desktop even when Desktop cannot run its normal Drop path.
    parent_stdin: Option<ChildStdin>,
}

impl VisionDebug {
    pub(crate) fn shutdown(mut self) {
        let _ = self.terminate_and_reap();
    }

    fn terminate_and_reap(&mut self) -> Option<JoinHandle<()>> {
        // Let the helper's EOF watchdog observe orderly Desktop shutdown too.
        self.parent_stdin.take();
        let mut child = self.child.take()?;
        let _ = child.kill();
        reap_in_background(child)
    }
}

fn reap_in_background(mut child: Child) -> Option<JoinHandle<()>> {
    // Camera and native inference teardown can remain stuck below Rust even after kill.
    // Desktop owns termination, but a detached reaper owns the potentially blocking wait.
    std::thread::Builder::new()
        .name("gsv-vision-reaper".to_string())
        .spawn(move || {
            let _ = child.wait();
        })
        .ok()
}

fn spawn_helper(command: &mut Command) -> Result<VisionDebug, VisionDebugError> {
    let mut child = command
        .stdin(Stdio::piped())
        .spawn()
        .map_err(|_| VisionDebugError::StartFailed)?;
    let Some(parent_stdin) = child.stdin.take() else {
        let _ = child.kill();
        let _ = reap_in_background(child);
        return Err(VisionDebugError::StartFailed);
    };
    Ok(VisionDebug {
        child: Some(child),
        parent_stdin: Some(parent_stdin),
    })
}

impl Drop for VisionDebug {
    fn drop(&mut self) {
        let _ = self.terminate_and_reap();
    }
}

pub(crate) fn start_from_env() -> Result<Option<VisionDebug>, VisionDebugError> {
    if !debug_enabled(env::var_os("GSV_GESTURE_DEBUG").as_deref()) {
        return Ok(None);
    }

    let executable = resolve_helper(
        env::var_os("GSV_VISION_HELPER").map(PathBuf::from),
        env::current_exe().ok(),
        Path::new(env!("CARGO_MANIFEST_DIR")),
        env::var_os("CARGO_TARGET_DIR").map(PathBuf::from),
        cfg!(debug_assertions),
    )?;
    let mut command = Command::new(executable);
    command
        .env_clear()
        .envs(allowed_environment(env::vars_os()))
        .env(PARENT_STDIN_WATCHDOG, "1")
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    spawn_helper(&mut command).map(Some)
}

fn debug_enabled(value: Option<&OsStr>) -> bool {
    value == Some(OsStr::new("1"))
}

fn resolve_helper(
    override_path: Option<PathBuf>,
    current_executable: Option<PathBuf>,
    manifest_dir: &Path,
    target_override: Option<PathBuf>,
    debug: bool,
) -> Result<PathBuf, VisionDebugError> {
    if let Some(path) = override_path {
        return path
            .is_file()
            .then_some(path)
            .ok_or(VisionDebugError::InvalidOverride);
    }

    if let Some(current_executable) = current_executable {
        let sibling =
            current_executable.with_file_name(format!("gsv-vision{}", env::consts::EXE_SUFFIX));
        if sibling.is_file() {
            return Ok(sibling);
        }
    }

    development_helper_candidates(manifest_dir, target_override, debug)
        .into_iter()
        .find(|candidate| candidate.is_file())
        .ok_or(VisionDebugError::NotInstalled)
}

fn development_helper_candidates(
    manifest_dir: &Path,
    target_override: Option<PathBuf>,
    debug: bool,
) -> Vec<PathBuf> {
    let workspace_root = manifest_dir.parent().unwrap_or(manifest_dir);
    let mut target_dirs = Vec::with_capacity(2);
    if let Some(target) = target_override {
        target_dirs.push(if target.is_absolute() {
            target
        } else {
            workspace_root.join(target)
        });
    }
    target_dirs.push(workspace_root.join("target"));
    let profiles = if debug {
        ["debug", "release"]
    } else {
        ["release", "debug"]
    };
    target_dirs
        .into_iter()
        .flat_map(|target| {
            profiles.map(move |profile| {
                target
                    .join(profile)
                    .join(format!("gsv-vision{}", env::consts::EXE_SUFFIX))
            })
        })
        .collect()
}

fn allowed_environment(
    environment: impl IntoIterator<Item = (OsString, OsString)>,
) -> Vec<(OsString, OsString)> {
    environment
        .into_iter()
        .filter(|(key, _)| {
            key.to_str()
                .is_some_and(|key| HELPER_ENVIRONMENT.contains(&key))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::time::{Duration, Instant};

    use tempfile::tempdir;

    use super::*;

    #[test]
    fn gesture_debug_requires_exact_opt_in() {
        assert!(debug_enabled(Some(OsStr::new("1"))));
        assert!(!debug_enabled(None));
        assert!(!debug_enabled(Some(OsStr::new("true"))));
        assert!(!debug_enabled(Some(OsStr::new("0"))));
    }

    #[test]
    fn resolution_prefers_override_then_sibling_then_workspace_target() {
        let directory = tempdir().expect("temporary directory");
        let workspace = directory.path();
        let manifest = workspace.join("native");
        let installed = workspace.join("installed");
        fs::create_dir_all(&manifest).expect("native directory");
        fs::create_dir_all(&installed).expect("installed directory");

        let override_path = workspace.join("explicit-vision-helper");
        let current_executable = installed.join(format!("gsv-native{}", env::consts::EXE_SUFFIX));
        let sibling = installed.join(format!("gsv-vision{}", env::consts::EXE_SUFFIX));
        let workspace_helper = workspace
            .join("target/debug")
            .join(format!("gsv-vision{}", env::consts::EXE_SUFFIX));
        fs::write(&override_path, []).expect("override helper");
        fs::write(&sibling, []).expect("sibling helper");
        fs::create_dir_all(workspace_helper.parent().expect("target directory"))
            .expect("target directory");
        fs::write(&workspace_helper, []).expect("workspace helper");

        assert_eq!(
            resolve_helper(
                Some(override_path.clone()),
                Some(current_executable.clone()),
                &manifest,
                None,
                true,
            ),
            Ok(override_path)
        );
        assert_eq!(
            resolve_helper(
                None,
                Some(current_executable.clone()),
                &manifest,
                None,
                true,
            ),
            Ok(sibling.clone())
        );
        fs::remove_file(sibling).expect("remove sibling helper");
        assert_eq!(
            resolve_helper(None, Some(current_executable), &manifest, None, true),
            Ok(workspace_helper)
        );
    }

    #[test]
    fn invalid_override_does_not_fall_back_to_discovered_helper() {
        let directory = tempdir().expect("temporary directory");
        let installed = directory.path().join("installed");
        fs::create_dir_all(&installed).expect("installed directory");
        let current_executable = installed.join(format!("gsv-native{}", env::consts::EXE_SUFFIX));
        let sibling = installed.join(format!("gsv-vision{}", env::consts::EXE_SUFFIX));
        fs::write(&sibling, []).expect("sibling helper");

        assert_eq!(
            resolve_helper(
                Some(directory.path().join("missing")),
                Some(current_executable),
                directory.path(),
                None,
                true,
            ),
            Err(VisionDebugError::InvalidOverride)
        );
    }

    #[test]
    fn helper_environment_is_an_explicit_allowlist() {
        let environment = vec![
            (OsString::from("PATH"), OsString::from("/bin")),
            (
                OsString::from("GSV_MEDIAPIPE_LIBRARY"),
                OsString::from("/debug/libmediapipe.so"),
            ),
            (
                OsString::from("GSV_VISION_MODEL"),
                OsString::from("/debug/model.task"),
            ),
            (OsString::from("GSV_VISION_CAMERA"), OsString::from("2")),
            (OsString::from("GSV_TOKEN"), OsString::from("secret")),
            (
                OsString::from("GSV_GATEWAY_URL"),
                OsString::from("https://private.example"),
            ),
            (
                OsString::from("GSV_VISION_HELPER"),
                OsString::from("/debug/gsv-vision"),
            ),
            (OsString::from("GSV_GESTURE_DEBUG"), OsString::from("1")),
            (OsString::from(PARENT_STDIN_WATCHDOG), OsString::from("0")),
            (OsString::from("HOME"), OsString::from("/private/home")),
        ];

        let allowed = allowed_environment(environment);
        assert_eq!(allowed.len(), 4);
        assert!(allowed.iter().any(|(key, _)| key == "PATH"));
        assert!(allowed
            .iter()
            .any(|(key, _)| key == "GSV_MEDIAPIPE_LIBRARY"));
        assert!(allowed.iter().any(|(key, _)| key == "GSV_VISION_MODEL"));
        assert!(allowed.iter().any(|(key, _)| key == "GSV_VISION_CAMERA"));
        assert!(!allowed.iter().any(|(key, _)| key == "GSV_TOKEN"));
        assert!(!allowed.iter().any(|(key, _)| key == "GSV_GATEWAY_URL"));
        assert!(!allowed.iter().any(|(key, _)| key == "GSV_VISION_HELPER"));
        assert!(!allowed.iter().any(|(key, _)| key == "GSV_GESTURE_DEBUG"));
        assert!(!allowed.iter().any(|(key, _)| key == PARENT_STDIN_WATCHDOG));
        assert!(!allowed.iter().any(|(key, _)| key == "HOME"));
    }

    #[cfg(unix)]
    #[test]
    fn shutdown_terminates_and_reaps_a_running_helper() {
        let child = Command::new("sh")
            .args(["-c", "while :; do sleep 60; done"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("long-running helper");
        let mut helper = VisionDebug {
            child: Some(child),
            parent_stdin: None,
        };

        let reaper = helper
            .terminate_and_reap()
            .expect("vision reaper should start");

        assert!(helper.child.is_none());
        reaper.join().expect("vision helper should be reaped");
    }

    #[cfg(unix)]
    #[test]
    fn helper_stdin_stays_open_for_the_guard_lifetime() {
        let mut command = Command::new("sh");
        command
            .args(["-c", "IFS= read -r _"])
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let mut helper = spawn_helper(&mut command).expect("spawn guarded helper");

        assert!(helper.parent_stdin.is_some());
        assert!(helper
            .child
            .as_mut()
            .expect("child")
            .try_wait()
            .expect("child status")
            .is_none());

        helper.parent_stdin.take();
        let deadline = Instant::now() + Duration::from_secs(1);
        loop {
            if helper
                .child
                .as_mut()
                .expect("child")
                .try_wait()
                .expect("child status")
                .is_some()
            {
                break;
            }
            assert!(Instant::now() < deadline, "child did not observe stdin EOF");
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}
