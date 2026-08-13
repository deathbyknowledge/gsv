use std::{
    future::Future,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

#[cfg(unix)]
use std::fs;

use gsv_desktop_control::{
    ClientOptions, DesktopControlClient, DesktopControlEndpoint, DesktopStatus, Error,
    GatewayState, MicrophoneEnvironmentOverride, MicrophoneName, MicrophoneSelection,
    MicrophoneStatus, ProcessId, WindowState,
};

use crate::cli::{DesktopAction, MicrophoneAction};

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
        Some(DesktopAction::Microphone { action }) => run_microphone(&client, action).await,
    }
}

async fn run_microphone(
    client: &DesktopControlClient,
    action: MicrophoneAction,
) -> Result<(), DynError> {
    match action {
        MicrophoneAction::List => {
            let status = request_or_launch(|| client.microphone_list()).await?;
            println!("{}", format_microphone_list(&status));
        }
        MicrophoneAction::Use { name } => {
            let name = MicrophoneName::new(name)?;
            let status = request_or_launch(|| client.microphone_use(name.clone())).await?;
            println!("{}", format_microphone_confirmation(&status));
        }
        MicrophoneAction::Default => {
            let status = request_or_launch(|| client.microphone_default()).await?;
            println!("{}", format_microphone_confirmation(&status));
        }
    }
    Ok(())
}

async fn activate_or_launch(client: &DesktopControlClient) -> Result<(), DynError> {
    request_or_launch(|| client.activate()).await
}

async fn request_or_launch<T, Request, RequestFuture>(request: Request) -> Result<T, DynError>
where
    Request: FnMut() -> RequestFuture,
    RequestFuture: Future<Output = Result<T, Error>>,
{
    request_or_launch_with(
        request,
        || {
            let executable = resolve_desktop_executable()?;
            launch_desktop(&executable)
        },
        DESKTOP_STARTUP_TIMEOUT,
        DESKTOP_STARTUP_POLL_INTERVAL,
    )
    .await
}

async fn request_or_launch_with<T, Request, RequestFuture, Launch>(
    mut request: Request,
    launch: Launch,
    startup_timeout: Duration,
    poll_interval: Duration,
) -> Result<T, DynError>
where
    Request: FnMut() -> RequestFuture,
    RequestFuture: Future<Output = Result<T, Error>>,
    Launch: FnOnce() -> Result<(), DynError>,
{
    match request().await {
        Ok(value) => return Ok(value),
        Err(error) if desktop_is_absent(&error) => {}
        Err(error) => return Err(error.into()),
    }

    launch()?;
    let started_at = Instant::now();

    loop {
        match request().await {
            Ok(value) => return Ok(value),
            Err(error) if desktop_is_starting(&error) && started_at.elapsed() < startup_timeout => {
                tokio::time::sleep(poll_interval).await;
            }
            Err(error) if desktop_is_starting(&error) => {
                return Err(format!(
                    "GSV Desktop did not expose its control endpoint within {startup_timeout:?}"
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

fn format_microphone_list(status: &MicrophoneStatus) -> String {
    let selection = match status.selected() {
        MicrophoneSelection::Ask => "not configured".to_string(),
        MicrophoneSelection::SystemDefault => "system default".to_string(),
        MicrophoneSelection::Device { name } => name.to_string(),
    };
    let mut lines = vec![format!("selection: {selection}")];
    if let Some(environment_override) = status.environment_override() {
        lines.push(format_environment_override(environment_override));
    }

    if status.devices().is_empty() {
        lines.push("no microphones found".to_string());
    }
    let override_matches = status
        .environment_override()
        .and_then(|environment_override| match environment_override {
            MicrophoneEnvironmentOverride::Active { name } => {
                Some(legacy_microphone_name_matches(status.devices(), name))
            }
            MicrophoneEnvironmentOverride::Invalid => None,
        })
        .unwrap_or_default();
    for (index, device) in status.devices().iter().enumerate() {
        let duplicate_count = status
            .devices()
            .iter()
            .filter(|candidate| candidate.name == device.name)
            .count();
        let duplicate_ordinal = status.devices()[..=index]
            .iter()
            .filter(|candidate| candidate.name == device.name)
            .count();
        let display_name = if duplicate_count > 1 {
            format!("{} · {duplicate_ordinal}", device.name)
        } else {
            device.name.to_string()
        };
        let mut labels = Vec::new();
        if device.is_default {
            labels.push("OS default");
        }
        let is_selected = match status.selected() {
            MicrophoneSelection::Ask => false,
            MicrophoneSelection::SystemDefault => device.is_default,
            MicrophoneSelection::Device { name } => duplicate_count == 1 && name == &device.name,
        };
        if is_selected {
            labels.push("selected");
        }
        if override_matches.contains(&index) {
            labels.push("environment override");
        }
        lines.push(format_microphone_line(&display_name, &labels));
    }

    if let MicrophoneSelection::Device { name } = status.selected() {
        if !status.devices().iter().any(|device| &device.name == name) {
            lines.push(format_microphone_line(
                name.as_str(),
                &["selected", "unavailable"],
            ));
        }
    }
    if let Some(MicrophoneEnvironmentOverride::Active { name }) = status.environment_override() {
        if override_matches.is_empty() {
            lines.push(format_microphone_line(
                name.as_str(),
                &["environment override", "unavailable"],
            ));
        }
    }
    lines.join("\n")
}

fn format_environment_override(environment_override: &MicrophoneEnvironmentOverride) -> String {
    match environment_override {
        MicrophoneEnvironmentOverride::Active { name } => {
            format!("environment override: {name}")
        }
        MicrophoneEnvironmentOverride::Invalid => {
            "environment override: invalid (remove GSV_VOICE_DEVICE)".to_string()
        }
    }
}

fn legacy_microphone_name_matches(
    devices: &[gsv_desktop_control::MicrophoneDevice],
    preferred: &MicrophoneName,
) -> Vec<usize> {
    let preferred = preferred.as_str().to_lowercase();
    let exact = devices
        .iter()
        .enumerate()
        .filter_map(|(index, device)| {
            (device.name.as_str().to_lowercase() == preferred).then_some(index)
        })
        .collect::<Vec<_>>();
    if !exact.is_empty() {
        return exact;
    }

    let partial = devices
        .iter()
        .enumerate()
        .filter_map(|(index, device)| {
            device
                .name
                .as_str()
                .to_lowercase()
                .contains(&preferred)
                .then_some(index)
        })
        .collect::<Vec<_>>();
    let Some(first_name) = partial
        .first()
        .map(|index| devices[*index].name.as_str().to_lowercase())
    else {
        return Vec::new();
    };
    if partial
        .iter()
        .all(|index| devices[*index].name.as_str().to_lowercase() == first_name)
    {
        partial
    } else {
        Vec::new()
    }
}

fn format_microphone_confirmation(status: &MicrophoneStatus) -> String {
    let selection = match status.selected() {
        MicrophoneSelection::Ask => "not configured".to_string(),
        MicrophoneSelection::SystemDefault => status
            .devices()
            .iter()
            .find(|device| device.is_default)
            .map(|device| format!("system default ({})", device.name))
            .unwrap_or_else(|| "system default".to_string()),
        MicrophoneSelection::Device { name } => name.to_string(),
    };
    let mut lines = vec![format!("selected microphone: {selection}")];
    if let Some(environment_override) = status.environment_override() {
        lines.push(format_environment_override(environment_override));
    }
    lines.join("\n")
}

fn format_microphone_line(name: &str, labels: &[&str]) -> String {
    if labels.is_empty() {
        return name.to_string();
    }
    format!("{name} [{}]", labels.join(", "))
}

#[cfg(test)]
mod tests {
    use std::{cell::Cell, collections::VecDeque, io};

    use gsv_desktop_control::MicrophoneDevice;

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
        assert!(!desktop_is_absent(&Error::UnsupportedVersion {
            actual: 1,
            expected: gsv_desktop_control::PROTOCOL_VERSION,
        }));
        assert!(desktop_is_starting(&Error::Timeout {
            stage: gsv_desktop_control::TimeoutStage::Connect,
            duration: Duration::from_millis(1),
        }));
        assert!(!desktop_is_starting(&Error::Timeout {
            stage: gsv_desktop_control::TimeoutStage::Read,
            duration: Duration::from_millis(1),
        }));
    }

    #[tokio::test]
    async fn direct_desktop_request_does_not_launch_or_send_an_extra_operation() {
        let requests = Cell::new(0);
        let launches = Cell::new(0);

        let value = request_or_launch_with(
            || {
                requests.set(requests.get() + 1);
                std::future::ready(Ok::<_, Error>(7_u8))
            },
            || {
                launches.set(launches.get() + 1);
                Ok(())
            },
            Duration::from_secs(1),
            Duration::ZERO,
        )
        .await
        .expect("direct request succeeds");

        assert_eq!(value, 7);
        assert_eq!(requests.get(), 1);
        assert_eq!(launches.get(), 0);
    }

    #[tokio::test]
    async fn absent_endpoint_launches_once_and_retries_only_the_requested_operation() {
        let responses = std::cell::RefCell::new(VecDeque::from([
            Err(Error::Io(io::Error::from(io::ErrorKind::NotFound))),
            Err(Error::Timeout {
                stage: gsv_desktop_control::TimeoutStage::Connect,
                duration: Duration::from_millis(1),
            }),
            Ok(11_u8),
        ]));
        let requests = Cell::new(0);
        let launches = Cell::new(0);

        let value = request_or_launch_with(
            || {
                requests.set(requests.get() + 1);
                std::future::ready(
                    responses
                        .borrow_mut()
                        .pop_front()
                        .expect("test response remains"),
                )
            },
            || {
                launches.set(launches.get() + 1);
                Ok(())
            },
            Duration::from_secs(1),
            Duration::ZERO,
        )
        .await
        .expect("request succeeds after launch");

        assert_eq!(value, 11);
        assert_eq!(requests.get(), 3);
        assert_eq!(launches.get(), 1);
    }

    #[tokio::test]
    async fn protocol_mismatch_fails_closed_without_launching() {
        let launches = Cell::new(0);

        let error = request_or_launch_with(
            || {
                std::future::ready(Err::<u8, _>(Error::UnsupportedVersion {
                    actual: 1,
                    expected: gsv_desktop_control::PROTOCOL_VERSION,
                }))
            },
            || {
                launches.set(launches.get() + 1);
                Ok(())
            },
            Duration::from_secs(1),
            Duration::ZERO,
        )
        .await
        .expect_err("version mismatch fails");

        assert!(error.to_string().contains("unsupported"));
        assert_eq!(launches.get(), 0);
    }

    #[test]
    fn state_names_are_stable_for_human_output() {
        assert_eq!(gateway_state_name(GatewayState::Connected), "connected");
        assert_eq!(window_state_name(WindowState::Focused), "focused");
    }

    #[test]
    fn microphone_list_marks_defaults_selections_and_overrides() {
        let status = MicrophoneStatus::new(
            vec![
                microphone("Built-in Microphone", true),
                microphone("Shure MV6", false),
            ],
            MicrophoneSelection::Device {
                name: MicrophoneName::new("Shure MV6").expect("valid microphone name"),
            },
            Some(active_override("Studio Mic")),
        )
        .expect("valid microphone status");

        assert_eq!(
            format_microphone_list(&status),
            "selection: Shure MV6\nenvironment override: Studio Mic\nBuilt-in Microphone [OS default]\nShure MV6 [selected]\nStudio Mic [environment override, unavailable]"
        );
    }

    #[test]
    fn microphone_output_distinguishes_ask_from_explicit_default() {
        let ask = MicrophoneStatus::new(Vec::new(), MicrophoneSelection::Ask, None)
            .expect("valid microphone status");
        assert_eq!(
            format_microphone_list(&ask),
            "selection: not configured\nno microphones found"
        );

        let default = MicrophoneStatus::new(
            vec![microphone("Built-in Microphone", true)],
            MicrophoneSelection::SystemDefault,
            None,
        )
        .expect("valid microphone status");
        assert_eq!(
            format_microphone_list(&default),
            "selection: system default\nBuilt-in Microphone [OS default, selected]"
        );
        assert_eq!(
            format_microphone_confirmation(&default),
            "selected microphone: system default (Built-in Microphone)"
        );
    }

    #[test]
    fn microphone_confirmation_reports_environment_override() {
        let status = MicrophoneStatus::new(
            vec![microphone("Shure MV6", false)],
            MicrophoneSelection::Device {
                name: MicrophoneName::new("Shure MV6").expect("valid microphone name"),
            },
            Some(active_override("Built-in Microphone")),
        )
        .expect("valid microphone status");

        assert_eq!(
            format_microphone_confirmation(&status),
            "selected microphone: Shure MV6\nenvironment override: Built-in Microphone"
        );
    }

    #[test]
    fn microphone_override_marks_a_unique_case_insensitive_substring_match() {
        let status = MicrophoneStatus::new(
            vec![
                microphone("Built-in Microphone", true),
                microphone("Shure MV6, USB Audio", false),
            ],
            MicrophoneSelection::Ask,
            Some(active_override("sHuRe Mv6")),
        )
        .expect("valid microphone status");

        assert_eq!(
            format_microphone_list(&status),
            "selection: not configured\nenvironment override: sHuRe Mv6\nBuilt-in Microphone [OS default]\nShure MV6, USB Audio [environment override]"
        );
    }

    #[test]
    fn microphone_override_prefers_exact_match_over_partial_matches() {
        let devices = vec![
            microphone("Monitor of Shure MV6", false),
            microphone("Shure MV6", false),
        ];
        let preferred = MicrophoneName::new("shure mv6").expect("valid microphone name");

        assert_eq!(
            legacy_microphone_name_matches(&devices, &preferred),
            vec![1]
        );
    }

    #[test]
    fn ambiguous_microphone_override_remains_unavailable() {
        let status = MicrophoneStatus::new(
            vec![
                microphone("Monitor of Shure MV6", false),
                microphone("Shure MV6, USB Audio", false),
            ],
            MicrophoneSelection::Ask,
            Some(active_override("shure")),
        )
        .expect("valid microphone status");

        assert_eq!(
            format_microphone_list(&status),
            "selection: not configured\nenvironment override: shure\nMonitor of Shure MV6\nShure MV6, USB Audio\nshure [environment override, unavailable]"
        );
    }

    #[test]
    fn invalid_microphone_override_is_reported_without_its_value() {
        let status = MicrophoneStatus::new(
            vec![microphone("Built-in Microphone", true)],
            MicrophoneSelection::SystemDefault,
            Some(MicrophoneEnvironmentOverride::Invalid),
        )
        .expect("valid microphone status");

        assert_eq!(
            format_microphone_list(&status),
            "selection: system default\nenvironment override: invalid (remove GSV_VOICE_DEVICE)\nBuilt-in Microphone [OS default, selected]"
        );
        assert_eq!(
            format_microphone_confirmation(&status),
            "selected microphone: system default (Built-in Microphone)\nenvironment override: invalid (remove GSV_VOICE_DEVICE)"
        );
    }

    #[test]
    fn duplicate_microphone_names_are_listed_without_guessing_the_selected_device() {
        let status = MicrophoneStatus::new(
            vec![
                microphone("USB microphone", true),
                microphone("USB microphone", false),
            ],
            MicrophoneSelection::Device {
                name: MicrophoneName::new("USB microphone").expect("valid microphone name"),
            },
            None,
        )
        .expect("valid microphone status");

        assert_eq!(
            format_microphone_list(&status),
            "selection: USB microphone\nUSB microphone · 1 [OS default]\nUSB microphone · 2"
        );
    }

    fn active_override(name: &str) -> MicrophoneEnvironmentOverride {
        MicrophoneEnvironmentOverride::Active {
            name: MicrophoneName::new(name).expect("valid microphone name"),
        }
    }

    fn microphone(name: &str, is_default: bool) -> MicrophoneDevice {
        MicrophoneDevice {
            name: MicrophoneName::new(name).expect("valid microphone name"),
            is_default,
        }
    }
}
