use super::*;
use host_config::{CliConfig, ConfigFile};
use sha2::{Digest, Sha256};
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
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
    Security::DACL_SECURITY_INFORMATION,
    Storage::FileSystem::{
        FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS, FILE_SHARE_READ,
        FILE_SHARE_WRITE, READ_CONTROL, WRITE_DAC,
    },
    System::Services::SetServiceObjectSecurity,
};

pub(super) struct WindowsServiceManager;

use windows_host::service::system_tool;

impl DeviceServiceManager for WindowsServiceManager {
    fn is_installed(&self) -> Result<bool, DynError> {
        Ok(service::installed()?)
    }
    fn install(&self, spec: &DeviceServiceInstallSpec) -> Result<(), DynError> {
        let daemon = PinnedDaemon::open(&spec.exe_path)?;
        validate_gsvd_version(&daemon.path)?;
        let job_name = format!("Local\\gsv-install-{}", uuid::Uuid::new_v4());
        let _job = windows_host::process::ProcessTree::named(&job_name)?;
        let owner = current_user_sid_string()?;
        let source =
            CliConfig::config_path().ok_or("Could not find the enrolling user's configuration")?;
        let config: CliConfig = ConfigFile::new(&source).load()?;
        let workspace = service_workspace(
            config
                .device
                .workspace
                .as_deref()
                .ok_or("Configure a workspace before installing the service")?,
        )?;
        // Workspace authority belongs to the enrolling process. Never delegate
        // these ACL operations to the elevated service-registration child.
        let _workspace_access = workspace_acl_access(&workspace)?;
        let saved_config = service::data_dir().join("config.toml");
        let previous_workspace = if saved_config.exists() {
            ConfigFile::<CliConfig>::new(saved_config)
                .load()?
                .device
                .workspace
                .filter(|path| path != &workspace && path.exists())
        } else {
            None
        };
        let _previous_access = previous_workspace
            .as_deref()
            .map(workspace_acl_access)
            .transpose()?;
        let executable = std::env::current_exe()?;
        let args = windows_arguments_string(&[
            "daemon".into(),
            "windows-install".into(),
            "--config".into(),
            source.to_string_lossy().into_owned(),
            "--owner-sid".into(),
            owner,
            "--workspace".into(),
            workspace.to_string_lossy().into_owned(),
            "--daemon-source".into(),
            daemon.path.to_string_lossy().into_owned(),
            "--daemon-sha256".into(),
            daemon.sha256.clone(),
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
        )?;
        run_command_capture(
            Command::new(system_tool("icacls.exe"))
                .arg(&workspace)
                .args(["/grant", "NT SERVICE\\gsvd:(OI)(CI)M"]),
            "Could not grant access to the selected workspace using your existing permissions",
        )?;
        if let Some(previous) = previous_workspace {
            run_command_capture(
                Command::new(system_tool("icacls.exe"))
                    .arg(previous)
                    .args(["/remove:g", "NT SERVICE\\gsvd"]),
                "Could not remove access to the previous workspace using your existing permissions",
            )?;
        }
        service::start()
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

fn workspace_acl_access(path: &Path) -> Result<File, DynError> {
    fs::OpenOptions::new()
        .access_mode(READ_CONTROL | WRITE_DAC)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .open(path)
        .map_err(|error| {
            format!(
                "Choose a workspace whose permissions you can change without elevation: {}: {error}",
                path.display()
            )
            .into()
        })
}

fn service_workspace(path: &Path) -> Result<PathBuf, DynError> {
    if !path.is_dir() {
        return Err("The service workspace must be an existing directory".into());
    }
    let workspace = path.canonicalize()?;
    let normalize = |path: &Path| {
        path.to_string_lossy()
            .trim_start_matches(r"\\?\")
            .trim_end_matches('\\')
            .to_ascii_lowercase()
    };
    let normalized = normalize(&workspace);
    let system = system_tool("..").canonicalize()?;
    let data = service::data_dir();
    let bin = service::binary_dir();
    let protected_roots = [
        system.as_path(),
        bin.parent().expect("service binary directory has a parent"),
        data.parent().expect("service data directory has a parent"),
    ];
    if normalized.len() == 2 && normalized.ends_with(':')
        || protected_roots.iter().any(|root| {
            let root = normalize(root);
            normalized == root || normalized.starts_with(&format!("{root}\\"))
        })
    {
        return Err(
            "Choose a dedicated workspace outside Windows and GSV service directories".into(),
        );
    }
    Ok(workspace)
}

pub(super) fn packaged_daemon_path() -> Result<PathBuf, DynError> {
    let path = std::env::current_exe()?
        .canonicalize()?
        .with_file_name("gsvd.exe");
    let metadata = fs::symlink_metadata(&path).map_err(|error| {
        format!("Could not open bundled gsvd.exe; reinstall the complete GSV distribution: {error}")
    })?;
    if !metadata.is_file() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err("The bundled gsvd.exe must be an ordinary file beside gsv.exe".into());
    }
    Ok(path.canonicalize()?)
}

/// Denies replacement across the UAC prompt. The elevated process verifies an
/// owned byte snapshot before writing it; paths and sharing locks alone cannot
/// authenticate bytes subsequently read from a file.
struct PinnedDaemon {
    path: PathBuf,
    file: File,
    sha256: String,
}

impl PinnedDaemon {
    fn open(path: &Path) -> Result<Self, DynError> {
        let mut file = fs::OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ)
            .open(path)?;
        if !file.metadata()?.is_file() {
            return Err("The bundled daemon must be an ordinary file".into());
        }
        let mut digest = Sha256::new();
        let mut buffer = [0_u8; 65536];
        loop {
            let read = file.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            digest.update(&buffer[..read]);
        }
        file.rewind()?;
        Ok(Self {
            path: path.to_path_buf(),
            file,
            sha256: format!("{:x}", digest.finalize()),
        })
    }

    fn verify(&self, expected_sha256: &str) -> Result<(), DynError> {
        if !self.sha256.eq_ignore_ascii_case(expected_sha256) {
            return Err(
                "The bundled daemon changed after approval was requested; retry gsv daemon install"
                    .into(),
            );
        }
        Ok(())
    }

    fn verified_bytes(&mut self, expected_sha256: &str) -> Result<Vec<u8>, DynError> {
        self.verify(expected_sha256)?;
        self.file.rewind()?;
        let mut bytes = Vec::new();
        self.file.read_to_end(&mut bytes)?;
        self.verify(&format!("{:x}", Sha256::digest(&bytes)))?;
        Ok(bytes)
    }
}

/// Registers the protected service without changing workspace ACLs or starting
/// it. The enrolling process owns those operations at its original privilege.
/// Device credentials never enter arguments.
pub fn install_elevated(
    source: &Path,
    owner: &str,
    workspace: &Path,
    daemon_source: &Path,
    daemon_sha256: &str,
) -> Result<(), DynError> {
    let packaged = packaged_daemon_path()?;
    if daemon_source.canonicalize()? != packaged {
        return Err("Service installation requires the bundled gsvd.exe beside gsv.exe".into());
    }
    let mut daemon = PinnedDaemon::open(&packaged)?;
    let daemon_bytes = daemon.verified_bytes(daemon_sha256)?;
    // Validate the SID before using it in Windows security descriptors or ACL arguments.
    let _ = SecurityDescriptor::new(owner)?;
    let manager = ServiceManager::local_computer(
        None::<&str>,
        ServiceManagerAccess::CONNECT | ServiceManagerAccess::CREATE_SERVICE,
    )?;
    let config: CliConfig = ConfigFile::new(source).load()?;
    let mut machine = CliConfig {
        device: config.device.clone(),
        ..CliConfig::default()
    };
    machine.device.gateway_url = Some(config.device_gateway_url());
    machine.device.gateway_username = config.device_gateway_username();
    machine.device.auto_update = Some(false);
    machine.release = config.release;
    let workspace = service_workspace(workspace)?;
    let data = service::data_dir();
    let bin = service::binary_dir();
    let binary_root = bin.parent().expect("service binary directory has a parent");
    let data_root = data.parent().expect("service data directory has a parent");
    machine.device.workspace = Some(workspace.clone());
    let protected = "O:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;GRGX;;;BU)";
    protect_directory(binary_root, protected)?;
    protect_directory(&bin, protected)?;
    protect_directory(data_root, protected)?;
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
    if executable.canonicalize().ok().as_ref() != Some(&daemon.path) {
        let mut destination = File::create(&executable)?;
        destination.write_all(&daemon_bytes)?;
        destination.sync_all()?;
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
    println!(
        "Registered boot service gsvd. Workspace: {}. Account: {}",
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
    let mut source = CliConfig::load();
    source.device.workspace = source
        .device
        .workspace
        .as_ref()
        .map(fs::canonicalize)
        .transpose()?;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_acl_access_uses_the_callers_existing_authority() {
        use std::{
            os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
            ptr,
        };
        use windows_sys::Win32::{
            Security::{
                CreateRestrictedToken, ImpersonateLoggedOnUser, RevertToSelf,
                DISABLE_MAX_PRIVILEGE, LUA_TOKEN, TOKEN_DUPLICATE, TOKEN_QUERY,
            },
            System::Threading::{GetCurrentProcess, OpenProcessToken},
        };

        let workspace = tempfile::tempdir().expect("user workspace");
        let protected = service::binary_dir()
            .parent()
            .and_then(Path::parent)
            .expect("Program Files contains the GSV service directory")
            .to_path_buf();
        let mut process_token = ptr::null_mut();
        // SAFETY: GetCurrentProcess is live and the output pointer is writable.
        assert_ne!(
            unsafe {
                OpenProcessToken(
                    GetCurrentProcess(),
                    TOKEN_DUPLICATE | TOKEN_QUERY,
                    &mut process_token,
                )
            },
            0
        );
        // SAFETY: OpenProcessToken returned a newly owned handle.
        let process_token = unsafe { OwnedHandle::from_raw_handle(process_token) };
        let mut restricted = ptr::null_mut();
        // SAFETY: the source handle is live, empty SID lists are null, and the
        // output is writable. LUA_TOKEN removes the caller's administrator grant.
        assert_ne!(
            unsafe {
                CreateRestrictedToken(
                    process_token.as_raw_handle(),
                    DISABLE_MAX_PRIVILEGE | LUA_TOKEN,
                    0,
                    ptr::null(),
                    0,
                    ptr::null(),
                    0,
                    ptr::null(),
                    &mut restricted,
                )
            },
            0
        );
        // SAFETY: CreateRestrictedToken returned a newly owned handle.
        let restricted = unsafe { OwnedHandle::from_raw_handle(restricted) };
        struct Revert;
        impl Drop for Revert {
            fn drop(&mut self) {
                // SAFETY: only this test thread is impersonating the token.
                assert_ne!(unsafe { RevertToSelf() }, 0);
            }
        }
        // SAFETY: the restricted primary token has QUERY and DUPLICATE access.
        assert_ne!(
            unsafe { ImpersonateLoggedOnUser(restricted.as_raw_handle()) },
            0
        );
        let _revert = Revert;
        workspace_acl_access(workspace.path()).expect("user controls the workspace ACL");
        assert!(workspace_acl_access(&protected).is_err());
    }

    #[test]
    fn pinned_daemon_prevents_replacement_until_installation_finishes() {
        let directory = tempfile::tempdir().expect("test directory");
        let path = directory.path().join("gsvd.exe");
        fs::write(&path, b"abc").expect("test daemon");
        let mut daemon = PinnedDaemon::open(&path).expect("pin test daemon");
        daemon
            .verify("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
            .expect("known SHA-256 digest");

        assert!(fs::write(&path, b"replacement").is_err());
        assert!(fs::remove_file(&path).is_err());
        assert!(fs::rename(&path, directory.path().join("moved.exe")).is_err());
        let child = PinnedDaemon::open(&path).expect("child can read pinned daemon");
        child.verify(&daemon.sha256).expect("same daemon bytes");
        let copied = daemon
            .verified_bytes(&child.sha256)
            .expect("snapshot pinned bytes");
        assert_eq!(copied, b"abc");

        drop(child);
        drop(daemon);
        fs::write(&path, b"replacement").expect("pin released after installation");
        assert_eq!(copied, b"abc");
    }

    #[test]
    fn pinned_daemon_rejects_changed_bytes() {
        let directory = tempfile::tempdir().expect("test directory");
        let path = directory.path().join("gsvd.exe");
        fs::write(&path, b"approved daemon").expect("test daemon");
        let daemon = PinnedDaemon::open(&path).expect("pin test daemon");
        let approved_sha256 = daemon.sha256.clone();
        drop(daemon);
        fs::write(&path, b"replacement daemon").expect("replace unpinned daemon");
        let mut replaced = PinnedDaemon::open(&path).expect("pin replacement");
        assert!(replaced.verified_bytes(&approved_sha256).is_err());
    }
}
