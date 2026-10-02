use super::*;
use host_config::{CliConfig, ConfigFile};
use sha2::{Digest, Sha256};
use std::os::windows::{
    ffi::OsStrExt,
    fs::{MetadataExt, OpenOptionsExt},
    io::FromRawHandle,
};
use windows_host::{
    security::{
        current_user_sid_string, protect_directory, validate_service_directory, SecurityDescriptor,
    },
    service::{
        self,
        windows_service::{
            service::{
                ServiceAccess, ServiceAction, ServiceActionType, ServiceConfig,
                ServiceErrorControl, ServiceFailureActions, ServiceFailureResetPeriod, ServiceInfo,
                ServiceSidType, ServiceStartType, ServiceState, ServiceType,
            },
            service_manager::{ServiceManager, ServiceManagerAccess},
        },
    },
};
use windows_sys::Win32::{
    Foundation::{GENERIC_WRITE, INVALID_HANDLE_VALUE},
    Security::{DACL_SECURITY_INFORMATION, SECURITY_ATTRIBUTES},
    Storage::FileSystem::{
        CreateFileW, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_REPARSE_POINT,
        FILE_FLAG_BACKUP_SEMANTICS, FILE_READ_ATTRIBUTES, FILE_SHARE_READ, FILE_SHARE_WRITE,
        READ_CONTROL, WRITE_DAC,
    },
    System::Services::{
        ChangeServiceConfig2W, SetServiceObjectSecurity, SERVICE_CONFIG_REQUIRED_PRIVILEGES_INFO,
        SERVICE_REQUIRED_PRIVILEGES_INFOW,
    },
};

#[path = "windows_service/enrollment.rs"]
mod enrollment;
#[path = "windows_service/workspace_permissions.rs"]
mod workspace_permissions;
use workspace_permissions::change_workspace_grant;
#[path = "windows_service/workspace_escrow.rs"]
mod workspace_escrow;
use workspace_escrow::{WorkspaceEscrow, WorkspaceRollback};

#[path = "windows_service/transaction.rs"]
mod transaction;
use transaction::ServiceReplacement;

pub(super) struct WindowsServiceManager;

use windows_host::service::system_tool;

impl DeviceServiceManager for WindowsServiceManager {
    fn is_installed(&self) -> Result<bool, DynError> {
        Ok(service::installed()?)
    }
    fn install(&self, spec: &DeviceServiceInstallSpec) -> Result<(), DynError> {
        let daemon = PinnedDaemon::open(&spec.exe_path)?;
        validate_gsvd_version(&daemon.path)?;
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
        // New workspace grants belong to the enrolling process. Only these
        // already-authorized handles may cross elevation for later rollback.
        let workspace_access = workspace_acl_access(&workspace)?;
        let saved_config = service::data_dir().join("config.toml");
        let previous_workspace = if service::installed()? && saved_config.exists() {
            ConfigFile::<CliConfig>::new(saved_config)
                .load()?
                .device
                .workspace
                .filter(|path| path != &workspace && path.exists())
        } else {
            None
        };
        let previous_access = previous_workspace
            .as_deref()
            .map(workspace_acl_access)
            .transpose()?;
        let transaction = uuid::Uuid::new_v4().to_string();
        let escrow = WorkspaceEscrow::create(
            &transaction,
            &owner,
            &workspace_access,
            previous_access.as_ref(),
        )?;
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
            "--transaction".into(),
            transaction,
            "--parent-pid".into(),
            std::process::id().to_string(),
        ]);
        enrollment::run(&executable, &args, escrow, || {
            change_workspace_grant(&workspace_access, true)?;
            if let Some(previous) = &previous_access {
                change_workspace_grant(previous, false)?;
            }
            service::start()
        })
    }
    fn uninstall(&self) -> Result<(), DynError> {
        service::stop()?;
        let cleanup = (|| -> Result<(), DynError> {
            let config: CliConfig =
                ConfigFile::new(service::data_dir().join("config.toml")).load()?;
            if let Some(workspace) = config.device.workspace {
                if workspace.exists() {
                    change_workspace_grant(&workspace_acl_access(&workspace)?, false)?;
                }
            }
            Ok(())
        })();
        service::open(ServiceAccess::DELETE)?.delete()?;
        if cleanup.is_err() {
            eprintln!("Could not revoke workspace access. An administrator can remove the NT SERVICE\\gsvd grant from the previous workspace manually.");
        }
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
        .access_mode(READ_CONTROL | WRITE_DAC | FILE_READ_ATTRIBUTES)
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

fn save_owner_sid(owner: &str) -> Result<(), DynError> {
    let path = service::owner_sid_path();
    let temporary = path.with_file_name(format!(".owner-{}.sid", uuid::Uuid::new_v4()));
    let descriptor = SecurityDescriptor::from_sddl("O:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;GR;;;BU)")?;
    let attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.pointer,
        bInheritHandle: 0,
    };
    let name: Vec<u16> = temporary.as_os_str().encode_wide().chain(Some(0)).collect();
    // SAFETY: the path is terminated and the descriptor remains live. Creating
    // with the final owner/DACL avoids a window where the enrolling user could
    // control a new file through the administrator token's default owner policy.
    let handle = unsafe {
        CreateFileW(
            name.as_ptr(),
            GENERIC_WRITE,
            FILE_SHARE_READ,
            &attributes,
            CREATE_NEW,
            FILE_ATTRIBUTE_NORMAL,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(std::io::Error::last_os_error().into());
    }
    // SAFETY: CreateFileW returned a newly owned file handle.
    let mut file = unsafe { File::from_raw_handle(handle) };
    let result = file
        .write_all(owner.as_bytes())
        .and_then(|()| file.sync_all());
    drop(file);
    // Both names are inside the already protected parent. Atomic replacement
    // never follows or writes through an existing owner marker's file identity.
    let result = result.and_then(|()| fs::rename(&temporary, path));
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    Ok(result?)
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
    transaction: Option<(&str, u32)>,
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
    // Import rollback authority before mutating the installation. These exact
    // handles were opened by the original caller, and survive that caller's exit.
    let mut workspace_rollback = transaction
        .map(|(id, pid)| WorkspaceRollback::receive(id, pid))
        .transpose()?;
    let data = service::data_dir();
    let bin = service::binary_dir();
    let installed = service::installed()?;
    if installed {
        validate_registration(&service::open(ServiceAccess::QUERY_CONFIG)?.query_config()?)?;
        validate_service_directory(&data)?;
    }
    let binary_root = bin.parent().expect("service binary directory has a parent");
    let data_root = data.parent().expect("service data directory has a parent");
    machine.device.workspace = Some(workspace.clone());
    let protected = "O:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;GRGX;;;BU)";
    protect_directory(binary_root, protected)?;
    protect_directory(&bin, protected)?;
    protect_directory(data_root, protected)?;
    let executable = bin.join("gsvd.exe");
    let owner_path = service::owner_sid_path();
    if owner_path.exists() {
        let existing_owner = fs::read_to_string(&owner_path)?;
        if existing_owner.trim() != owner {
            return Err("This machine has enrollment owned by another Windows user. An administrator must explicitly retire its saved enrollment before replacing it.".into());
        }
    }
    // Stage and sync the complete image before stopping the existing service.
    // The guard restores its executable, configuration and running state if
    // registration or enrollment fails after the replacement.
    let mut replacement = ServiceReplacement::stage(&daemon_bytes)?;
    replacement.apply()?;
    let result = (|| {
        let info = ServiceInfo {
            name: service::NAME.into(),
            display_name: "GSV machine daemon".into(),
            service_type: ServiceType::OWN_PROCESS,
            start_type: ServiceStartType::AutoStart,
            error_control: ServiceErrorControl::Normal,
            executable_path: executable,
            launch_arguments: vec!["--windows-service".into()],
            dependencies: vec![],
            account_name: Some(service::ACCOUNT.into()),
            account_password: None,
        };
        let svc = if installed {
            service::open(ServiceAccess::QUERY_CONFIG)?
        } else {
            manager.create_service(&info, ServiceAccess::ALL_ACCESS)?
        };
        // Existing registrations belong to their administrator. Replacing the
        // executable must not rewrite settings that a rollback cannot restore.
        if !installed {
            svc.set_config_service_sid_info(ServiceSidType::Unrestricted)?;
            // Commands share the daemon's OS identity. The SCM token needs directory
            // traversal, not the impersonation/backup privileges often given to services.
            let mut privileges: Vec<u16> = "SeChangeNotifyPrivilege\0\0".encode_utf16().collect();
            let required = SERVICE_REQUIRED_PRIVILEGES_INFOW {
                pmszRequiredPrivileges: privileges.as_mut_ptr(),
            };
            // SAFETY: the service handle allows configuration and both buffers stay live.
            if unsafe {
                ChangeServiceConfig2W(
                    svc.raw_handle(),
                    SERVICE_CONFIG_REQUIRED_PRIVILEGES_INFO,
                    (&required as *const SERVICE_REQUIRED_PRIVILEGES_INFOW).cast(),
                )
            } == 0
            {
                return Err(std::io::Error::last_os_error().into());
            }

            svc.set_description(
                "Connects this machine to its owner's GSV space before Windows login.",
            )?;
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
        }
        run_command_capture(
            Command::new(system_tool("icacls.exe"))
                .arg(&bin)
                .args(["/grant", "NT SERVICE\\gsvd:(OI)(CI)RX"]),
            "Could not grant service executable access",
        )?;
        if !installed {
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
        }
        save_owner_sid(owner)?;
        replacement.save_config(&machine)?;
        println!(
            "Registered boot service gsvd. Workspace: {}. Account: {}",
            workspace.display(),
            svc.query_config()?
                .account_name
                .unwrap_or_default()
                .to_string_lossy()
        );
        Ok(())
    })();
    let result = result.and_then(|()| {
        if let Some(rollback) = workspace_rollback.as_mut() {
            if let Err(error) = rollback.wait_for_caller() {
                // Restore caller-authorized ACLs before the previous daemon is
                // restarted, including when the original caller no longer exists.
                rollback.restore()?;
                return Err(error);
            }
        }
        Ok(())
    });
    replacement.finish(result)
}

/// Called only by the installer's protected, checksum-pinned CLI snapshot.
pub async fn update_elevated(daemon_sha256: &str) -> Result<(), DynError> {
    if !service::installed()? {
        return Err("The Windows service is no longer installed".into());
    }
    let mut daemon = PinnedDaemon::open(&packaged_daemon_path()?)?;
    let bytes = daemon.verified_bytes(daemon_sha256)?;
    let mut replacement = ServiceReplacement::stage(&bytes)?;
    replacement.apply()?;
    let result = async {
        service::start()?;
        let client = daemon_protocol::DaemonControlClient::new(
            daemon_protocol::DaemonControlEndpoint::current_user()?,
            daemon_protocol::ClientOptions::default(),
        );
        let mut healthy = false;
        for _ in 0..15 {
            if client.diagnostics().await.is_ok() {
                healthy = true;
                break;
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
        if !healthy {
            return Err("The updated gsvd service did not become healthy".into());
        }
        if !replacement.was_running() {
            service::stop()?;
        }
        Ok(())
    }
    .await;
    replacement.finish(result)
}

pub fn sync_configuration() -> Result<(), DynError> {
    if !service::installed()? {
        return Ok(());
    }
    let data = service::data_dir();
    if fs::read_to_string(service::owner_sid_path())?.trim() != current_user_sid_string()? {
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
    validate_registration(&config)?;
    let path = service::binary_dir().join("gsvd.exe");
    println!("service startup: {:?}", config.start_type);
    println!(
        "service account: {}",
        config.account_name.unwrap_or_default().to_string_lossy()
    );
    validate_gsvd_version(&path)?;
    Ok(path)
}

fn validate_registration(config: &ServiceConfig) -> Result<(), DynError> {
    let path = service::binary_dir().join("gsvd.exe");
    let expected = windows_arguments_string(&[
        path.to_string_lossy().into_owned(),
        "--windows-service".to_owned(),
    ]);
    if config.service_type != ServiceType::OWN_PROCESS
        || !config
            .executable_path
            .to_string_lossy()
            .eq_ignore_ascii_case(&expected)
    {
        return Err("The existing gsvd registration is not the expected GSV service. An administrator must restore or remove that registration before installing GSV; it has not been changed.".into());
    }
    Ok(())
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
        // SAFETY: GetCurrentProcess returns a non-owned pseudo-handle.
        let process = unsafe { GetCurrentProcess() };
        assert_ne!(
            // SAFETY: GetCurrentProcess is live and the output pointer is writable.
            unsafe { OpenProcessToken(process, TOKEN_DUPLICATE | TOKEN_QUERY, &mut process_token) },
            0
        );
        // SAFETY: OpenProcessToken returned a newly owned handle.
        let process_token = unsafe { OwnedHandle::from_raw_handle(process_token) };
        let mut restricted = ptr::null_mut();
        assert_ne!(
            // SAFETY: the source handle is live, empty SID lists are null, and the
            // output is writable. LUA_TOKEN removes the caller's administrator grant.
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
        assert_ne!(
            // SAFETY: the restricted primary token has QUERY and DUPLICATE access.
            unsafe { ImpersonateLoggedOnUser(restricted.as_raw_handle()) },
            0
        );
        let _revert = Revert;
        workspace_acl_access(workspace.path()).expect("user controls the workspace ACL");
        workspace_acl_access(&protected).unwrap_err();
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
        replaced.verified_bytes(&approved_sha256).unwrap_err();
    }
}
