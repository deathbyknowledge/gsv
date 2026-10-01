use super::*;
use host_config::{CliConfig, ConfigFile};
use windows_host::{
    security::{current_user_sid_string, protect_directory, SecurityDescriptor},
    service::{
        self,
        windows_service::{
            service::{
                ServiceAccess, ServiceAction, ServiceActionType, ServiceErrorControl,
                ServiceFailureActions, ServiceFailureResetPeriod, ServiceInfo, ServiceSidType,
                ServiceStartType, ServiceType,
            },
            service_manager::{ServiceManager, ServiceManagerAccess},
        },
    },
};
use windows_sys::Win32::{
    Security::DACL_SECURITY_INFORMATION, System::Services::SetServiceObjectSecurity,
};

pub(super) struct WindowsServiceManager;

use windows_host::service::system_tool;

impl DeviceServiceManager for WindowsServiceManager {
    fn is_installed(&self) -> Result<bool, DynError> {
        Ok(service::installed()?)
    }
    fn install(&self, _spec: &DeviceServiceInstallSpec) -> Result<(), DynError> {
        let job_name = format!("Local\\gsv-install-{}", uuid::Uuid::new_v4());
        let _job = windows_host::process::ProcessTree::named(&job_name)?;
        let owner = current_user_sid_string()?;
        let source =
            CliConfig::config_path().ok_or("Could not find the enrolling user's configuration")?;
        let executable = std::env::current_exe()?;
        let args = windows_arguments_string(&[
            "daemon".into(),
            "windows-install".into(),
            "--config".into(),
            source.to_string_lossy().into_owned(),
            "--owner-sid".into(),
            owner,
            "--job".into(),
            job_name,
        ]);
        let script = format!(
            "$ErrorActionPreference = 'Stop'\n$p = Start-Process -FilePath {} -ArgumentList {} -Verb RunAs -Wait -PassThru\nif ($p.ExitCode -ne 0) {{ throw 'GSV service installation failed; run gsv daemon install from an administrator terminal for details.' }}",
            powershell_single_quote(&executable.to_string_lossy()), powershell_single_quote(&args),
        );
        run_windows_powershell_script(
            &script,
            "Administrator approval is required to install the boot service",
        )
    }
    fn uninstall(&self) -> Result<(), DynError> {
        service::stop()?;
        let config: CliConfig = ConfigFile::new(service::data_dir().join("config.toml")).load()?;
        if let Some(workspace) = config.device.workspace {
            if workspace.exists() {
                run_command_capture(Command::new(system_tool("icacls.exe")).arg(workspace).args(["/remove:g", "NT SERVICE\\gsvd"]), "Could not remove the service workspace grant; retry uninstall from an administrator terminal")?;
            }
        }
        service::open(ServiceAccess::DELETE)?.delete()?;
        println!(
            "Service removed. Enrollment and workspace remain at {}",
            service::data_dir().display()
        );
        Ok(())
    }
    fn start(&self) -> Result<(), DynError> {
        service::start()
    }
    fn restart(&self) -> Result<(), DynError> {
        service::stop()?;
        service::start()
    }
    fn stop(&self) -> Result<(), DynError> {
        service::stop()
    }
    fn status(&self) -> Result<(), DynError> {
        let svc = service::open(ServiceAccess::QUERY_STATUS | ServiceAccess::QUERY_CONFIG)?;
        let status = svc.query_status()?;
        println!(
            "gsvd: {:?}; execution account: {}",
            status.current_state,
            svc.query_config()?
                .account_name
                .unwrap_or_default()
                .to_string_lossy()
        );
        Ok(())
    }
    fn needs_migration(&self, _spec: &DeviceServiceInstallSpec) -> Result<bool, DynError> {
        Ok(false)
    }
}

/// Runs only in the administrator process. Configuration contents never enter arguments.
pub fn install_elevated(source: &Path, owner: &str) -> Result<(), DynError> {
    // Validate the SID before using it in Windows security descriptors or ACL arguments.
    let _ = SecurityDescriptor::new(owner)?;
    let manager = ServiceManager::local_computer(
        None::<&str>,
        ServiceManagerAccess::CONNECT | ServiceManagerAccess::CREATE_SERVICE,
    )?;
    let config: CliConfig = ConfigFile::new(source).load()?;
    let mut machine = CliConfig::default();
    machine.device = config.device.clone();
    machine.device.gateway_url = Some(config.device_gateway_url());
    machine.device.gateway_username = config.device_gateway_username();
    machine.device.auto_update = Some(false);
    machine.release = config.release;
    let workspace = machine
        .device
        .workspace
        .clone()
        .ok_or("Configure a workspace before installing the service")?;
    if !workspace.is_dir() {
        return Err("The service workspace must be an existing directory".into());
    }
    let workspace = workspace.canonicalize()?;
    let normalize = |path: &Path| {
        path.to_string_lossy()
            .trim_start_matches(r"\\?\")
            .trim_end_matches('\\')
            .to_ascii_lowercase()
    };
    let normalized = normalize(&workspace);
    let system = system_tool("..").canonicalize()?;
    let service_bin = service::binary_dir();
    let protected_roots = [system.as_path(), service_bin.parent().unwrap()];
    if normalized.len() == 2 && normalized.ends_with(':')
        || protected_roots.iter().any(|root| {
            let root = normalize(root);
            normalized == root || normalized.starts_with(&format!("{root}\\"))
        })
        || normalized == normalize(service::data_dir().parent().unwrap())
        || normalized.starts_with(&format!(
            "{}\\",
            normalize(service::data_dir().parent().unwrap())
        ))
    {
        return Err(
            "Choose a dedicated workspace outside Windows and GSV service directories".into(),
        );
    }
    machine.device.workspace = Some(workspace.clone());
    let data = service::data_dir();
    let bin = service::binary_dir();
    let protected = "O:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;GRGX;;;BU)";
    protect_directory(bin.parent().unwrap(), protected)?;
    protect_directory(&bin, protected)?;
    protect_directory(data.parent().unwrap(), protected)?;
    let executable = bin.join("gsvd.exe");
    let installed = service::installed()?;
    if data.join("owner.sid").exists() {
        let existing_owner = fs::read_to_string(data.join("owner.sid"))?;
        if existing_owner.trim() != owner {
            return Err("This machine has enrollment owned by another Windows user. An administrator must explicitly retire its saved enrollment before replacing it.".into());
        }
    }
    if installed {
        service::stop()?;
    }
    let source_executable = resolve_gsvd_executable()?;
    if source_executable != executable {
        fs::copy(source_executable, &executable)?;
    }
    let info = ServiceInfo {
        name: service::NAME.into(),
        display_name: "GSV machine daemon".into(),
        service_type: ServiceType::OWN_PROCESS,
        start_type: ServiceStartType::AutoStart,
        error_control: ServiceErrorControl::Normal,
        executable_path: executable,
        launch_arguments: vec!["--windows-service".into()],
        dependencies: vec![],
        account_name: if installed {
            None
        } else {
            Some(service::ACCOUNT.into())
        },
        account_password: None,
    };
    let svc = if installed {
        let svc = service::open(ServiceAccess::ALL_ACCESS)?;
        svc.change_config(&info)?;
        svc
    } else {
        manager.create_service(&info, ServiceAccess::ALL_ACCESS)?
    };
    svc.set_config_service_sid_info(ServiceSidType::Unrestricted)?;
    run_command_capture(
        Command::new(system_tool("icacls.exe"))
            .arg(&bin)
            .args(["/grant", "NT SERVICE\\gsvd:(OI)(CI)RX"]),
        "Could not grant service executable access",
    )?;
    svc.set_description("Connects this machine to its owner's GSV space before Windows login.")?;
    svc.update_failure_actions(ServiceFailureActions {
        reset_period: ServiceFailureResetPeriod::After(Duration::from_secs(86400)),
        reboot_msg: None,
        command: None,
        actions: Some(
            vec![10, 30, 60]
                .into_iter()
                .map(|seconds| ServiceAction {
                    action_type: ServiceActionType::Restart,
                    delay: Duration::from_secs(seconds),
                })
                .collect(),
        ),
    })?;
    svc.set_failure_actions_on_non_crash_failures(true)?;
    // The enrolling user may inspect, start, stop and remove their service, but
    // cannot change its privileged registration or executable through this ACL.
    let descriptor = SecurityDescriptor::from_sddl(&format!(
        "D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;CCLCSWRPWPLOCRRCSD;;;{owner})"
    ))?;
    // SAFETY: the live service handle has WRITE_DAC and the descriptor remains valid.
    if unsafe {
        SetServiceObjectSecurity(
            svc.raw_handle(),
            DACL_SECURITY_INFORMATION,
            descriptor.pointer,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error().into());
    }
    // Resolve the service SID through its registered account, then install an
    // exact DACL rather than retaining permissions from a pre-existing folder.
    protect_directory(
        &data,
        &format!("O:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1301bf;;;{owner})"),
    )?;
    run_command_capture(
        Command::new(system_tool("icacls.exe"))
            .arg(&data)
            .args(["/grant", "NT SERVICE\\gsvd:(OI)(CI)M"]),
        "Could not grant service state access",
    )?;
    fs::write(data.join("owner.sid"), owner)?;
    ConfigFile::new(data.join("config.toml")).save(&machine)?;
    run_command_capture(
        Command::new(system_tool("icacls.exe"))
            .arg(&workspace)
            .args(["/grant", "NT SERVICE\\gsvd:(OI)(CI)M"]),
        "Could not grant access to the selected workspace",
    )?;
    service::start()?;
    println!(
        "Installed boot service gsvd. Workspace: {}. Account: {}",
        workspace.display(),
        svc.query_config()?
            .account_name
            .unwrap_or_default()
            .to_string_lossy()
    );
    Ok(())
}

pub fn sync_configuration() -> Result<(), DynError> {
    if !service::installed()? {
        return Ok(());
    }
    let data = service::data_dir();
    if fs::read_to_string(data.join("owner.sid"))?.trim() != current_user_sid_string()? {
        return Err("Only the enrolled Windows owner may change daemon configuration".into());
    }
    let source = CliConfig::load();
    ConfigFile::<CliConfig>::new(data.join("config.toml")).update(|config| {
        // Workspace ACL changes are an installation operation, not a reload.
        if source.device.workspace != config.device.workspace {
            return Err(host_config::ConfigError::Io(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "Run gsv daemon install to change the service workspace",
            )));
        }
        config.device = source.device.clone();
        config.device.gateway_url = Some(source.device_gateway_url());
        config.device.gateway_username = source.device_gateway_username();
        config.device.auto_update = Some(false);
        config.release = source.release.clone();
        Ok(())
    })?;
    Ok(())
}

/// Inspect the executable registered with SCM, including when it is stopped.
pub(super) fn registered_executable() -> Result<PathBuf, DynError> {
    let config = service::open(ServiceAccess::QUERY_CONFIG)?.query_config()?;
    let path = service::binary_dir().join("gsvd.exe");
    let expected = windows_arguments_string(&[
        path.to_string_lossy().into_owned(),
        "--windows-service".to_owned(),
    ]);
    if !config
        .executable_path
        .to_string_lossy()
        .eq_ignore_ascii_case(&expected)
    {
        return Err("Unexpected Windows service executable or arguments; run gsv daemon install to repair its registration".into());
    }
    println!("service startup: {:?}", config.start_type);
    println!(
        "service account: {}",
        config.account_name.unwrap_or_default().to_string_lossy()
    );
    validate_gsvd_version(&path)?;
    Ok(path)
}
