use super::*;
use host_config::{CliConfig, ConfigFile};
use windows_host::{
    security::{current_user_sid_string, SecurityDescriptor},
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

fn system_tool(name: &str) -> PathBuf {
    PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into()))
        .join("System32")
        .join(name)
}

impl DeviceServiceManager for WindowsServiceManager {
    fn is_installed(&self) -> Result<bool, DynError> {
        Ok(service::installed()?)
    }
    fn install(&self, _spec: &DeviceServiceInstallSpec) -> Result<(), DynError> {
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

/// Runs only in the administrator process. The source file never travels in arguments.
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
    let data = service::data_dir();
    let bin = PathBuf::from(std::env::var_os("ProgramFiles").ok_or("ProgramFiles is unavailable")?)
        .join("GSV")
        .join("service");
    let executable = bin.join("gsvd.exe");
    let installed = service::installed()?;
    if installed {
        let existing_owner = fs::read_to_string(data.join("owner.sid"))?;
        if existing_owner.trim() != owner {
            return Err("This machine is enrolled by another Windows user. Uninstall its service before replacing it.".into());
        }
        service::stop()?;
    }
    fs::create_dir_all(&bin)?;
    // A service executable must never be writable by the account executing agent commands.
    run_command_capture(
        Command::new(system_tool("icacls.exe")).arg(&bin).args([
            "/inheritance:r",
            "/grant:r",
            "*S-1-5-18:(OI)(CI)F",
            "*S-1-5-32-544:(OI)(CI)F",
            "*S-1-5-32-545:(OI)(CI)RX",
        ]),
        "Could not protect service binaries",
    )?;
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
    fs::create_dir_all(&data)?;
    run_command_capture(
        Command::new(system_tool("icacls.exe")).arg(&data).args([
            "/inheritance:r",
            "/grant:r",
            "*S-1-5-18:(OI)(CI)F",
            "*S-1-5-32-544:(OI)(CI)F",
            &format!("*{owner}:(OI)(CI)M"),
            "NT SERVICE\\gsvd:(OI)(CI)M",
        ]),
        "Could not protect daemon state",
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
