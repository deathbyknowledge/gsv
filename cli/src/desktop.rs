use std::{
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

#[cfg(unix)]
use std::fs;

use gsv_desktop_control::{
    ClientOptions, DesktopControlClient, DesktopControlEndpoint, DesktopStatus, Error,
    GatewayState, ProcessId, WindowState,
};

use crate::cli::DesktopAction;

type DynError = Box<dyn std::error::Error>;

const DESKTOP_STARTUP_TIMEOUT: Duration = Duration::from_secs(10);
const DESKTOP_STARTUP_POLL_INTERVAL: Duration = Duration::from_millis(50);
const DESKTOP_CONNECT_TIMEOUT: Duration = Duration::from_millis(250);
const DESKTOP_IO_TIMEOUT: Duration = Duration::from_secs(3);
const DESKTOP_RESPONSE_TIMEOUT: Duration = Duration::from_secs(12);

pub(crate) async fn run_desktop(action: Option<DesktopAction>) -> Result<(), DynError> {
    let endpoint = DesktopControlEndpoint::current_user()?;
    let client = DesktopControlClient::new(
        endpoint,
        ClientOptions::default()
            .with_connect_timeout(DESKTOP_CONNECT_TIMEOUT)
            .with_io_timeout(DESKTOP_IO_TIMEOUT)
            .with_response_timeout(DESKTOP_RESPONSE_TIMEOUT),
    );

    match action {
        None => activate_or_launch(&client).await,
        Some(DesktopAction::Status { json }) => {
            let status = client.status().await.map_err(not_running_error)?;
            print_status(&status, json)?;
            Ok(())
        }
        Some(DesktopAction::New) => {
            activate_or_launch(&client).await?;
            let process_id = client.new_conversation().await?;
            println!("{process_id}");
            Ok(())
        }
        Some(DesktopAction::Use { pid }) => {
            let process_id = ProcessId::new(pid)?;
            activate_or_launch(&client).await?;
            let selected = client.use_process(process_id).await?;
            println!("{selected}");
            Ok(())
        }
    }
}

async fn activate_or_launch(client: &DesktopControlClient) -> Result<(), DynError> {
    match client.activate().await {
        Ok(()) => return Ok(()),
        Err(error) if desktop_is_absent(&error) => {}
        Err(error) => return Err(error.into()),
    }

    let executable = resolve_desktop_executable()?;
    launch_desktop(&executable)?;
    let started_at = Instant::now();

    loop {
        match client.activate().await {
            Ok(()) => return Ok(()),
            Err(error)
                if desktop_is_starting(&error)
                    && started_at.elapsed() < DESKTOP_STARTUP_TIMEOUT =>
            {
                tokio::time::sleep(DESKTOP_STARTUP_POLL_INTERVAL).await;
            }
            Err(error) if desktop_is_starting(&error) => {
                return Err(format!(
                    "GSV Desktop did not expose its control endpoint within {DESKTOP_STARTUP_TIMEOUT:?}"
                )
                .into());
            }
            Err(error) => return Err(error.into()),
        }
    }
}

fn desktop_is_starting(error: &Error) -> bool {
    desktop_is_absent(error)
        || matches!(
            error,
            Error::Timeout {
                stage: gsv_desktop_control::TimeoutStage::Connect,
                ..
            }
        )
}

fn not_running_error(error: Error) -> DynError {
    if desktop_is_absent(&error) {
        "GSV Desktop is not running; start it with `gsv desktop`".into()
    } else {
        error.into()
    }
}

fn desktop_is_absent(error: &Error) -> bool {
    matches!(
        error,
        Error::Io(source)
            if matches!(
                source.kind(),
                std::io::ErrorKind::NotFound
                    | std::io::ErrorKind::ConnectionRefused
                    | std::io::ErrorKind::NotConnected
                    | std::io::ErrorKind::AddrNotAvailable
            )
    )
}

fn resolve_desktop_executable() -> Result<PathBuf, DynError> {
    if let Some(explicit) = std::env::var_os("GSV_DESKTOP_PATH") {
        return validate_desktop_executable(PathBuf::from(explicit), "GSV_DESKTOP_PATH");
    }

    let executable_names: &[&str] = if cfg!(windows) {
        &["gsv-desktop.exe", "gsv-native.exe"]
    } else {
        &["gsv-desktop", "gsv-native"]
    };
    let current = std::env::current_exe()?;
    if let Some(parent) = current.parent() {
        #[cfg(target_os = "macos")]
        if let Some(bundle_executable) = macos_bundle_executable(parent) {
            if is_runnable_file(&bundle_executable) {
                return Ok(bundle_executable
                    .canonicalize()
                    .unwrap_or(bundle_executable));
            }
        }
        for name in executable_names {
            let sibling = parent.join(name);
            if is_runnable_file(&sibling) {
                return Ok(sibling.canonicalize().unwrap_or(sibling));
            }
        }
    }

    if let Some(path) = find_executable_on_path(executable_names) {
        return Ok(path.canonicalize().unwrap_or(path));
    }

    Err("Could not find the `gsv-desktop` executable. Install the complete GSV distribution or set GSV_DESKTOP_PATH."
        .to_string()
        .into())
}

#[cfg(target_os = "macos")]
fn macos_bundle_executable(cli_parent: &Path) -> Option<PathBuf> {
    let app_bundle = cli_parent.parent()?.join("GSV.app");
    ["gsv-desktop", "gsv-native"]
        .into_iter()
        .map(|name| app_bundle.join("Contents").join("MacOS").join(name))
        .find(|candidate| candidate.is_file())
}

fn validate_desktop_executable(path: PathBuf, source: &str) -> Result<PathBuf, DynError> {
    if !is_runnable_file(&path) {
        return Err(format!(
            "{source} does not name an executable file: {}",
            path.display()
        )
        .into());
    }
    Ok(path.canonicalize().unwrap_or(path))
}

fn find_executable_on_path(names: &[&str]) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .flat_map(|directory| names.iter().map(move |name| directory.join(name)))
        .find(|candidate| is_runnable_file(candidate))
}

fn is_runnable_file(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::metadata(path)
            .map(|metadata| metadata.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn launch_desktop(executable: &Path) -> Result<(), DynError> {
    Command::new(executable)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|error| {
            format!(
                "Failed to launch GSV Desktop at {}: {error}",
                executable.display()
            )
            .into()
        })
}

fn print_status(status: &DesktopStatus, json: bool) -> Result<(), DynError> {
    if json {
        println!("{}", serde_json::to_string(status)?);
        return Ok(());
    }

    println!("gateway: {}", gateway_state_name(status.gateway));
    println!("window: {}", window_state_name(status.window));
    println!(
        "selected process: {}",
        status
            .selected_process
            .as_ref()
            .map(ProcessId::as_str)
            .unwrap_or("none")
    );
    Ok(())
}

fn gateway_state_name(state: GatewayState) -> &'static str {
    match state {
        GatewayState::Disconnected => "disconnected",
        GatewayState::Connecting => "connecting",
        GatewayState::Connected => "connected",
    }
}

fn window_state_name(state: WindowState) -> &'static str {
    match state {
        WindowState::Hidden => "hidden",
        WindowState::Visible => "visible",
        WindowState::Focused => "focused",
    }
}

#[cfg(test)]
mod tests {
    use std::io;

    use super::*;

    #[test]
    fn only_transport_absence_triggers_a_desktop_launch() {
        assert!(desktop_is_absent(&Error::Io(io::Error::from(
            io::ErrorKind::NotFound
        ))));
        assert!(desktop_is_absent(&Error::Io(io::Error::from(
            io::ErrorKind::ConnectionRefused
        ))));
        assert!(!desktop_is_absent(&Error::PeerIdentity));
        assert!(!desktop_is_absent(&Error::UnexpectedResponse));
        assert!(desktop_is_starting(&Error::Timeout {
            stage: gsv_desktop_control::TimeoutStage::Connect,
            duration: Duration::from_millis(1),
        }));
        assert!(!desktop_is_starting(&Error::Timeout {
            stage: gsv_desktop_control::TimeoutStage::Read,
            duration: Duration::from_millis(1),
        }));
    }

    #[test]
    fn state_names_are_stable_for_human_output() {
        assert_eq!(gateway_state_name(GatewayState::Connected), "connected");
        assert_eq!(window_state_name(WindowState::Focused), "focused");
    }
}
