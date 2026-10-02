use super::*;

/// A complete replacement is durable before SCM is stopped. The old image is
/// retained under a second name until all fallible registration work completes.
pub(super) struct ServiceReplacement {
    executable: PathBuf,
    staged: PathBuf,
    backup: Option<PathBuf>,
    previous_config: Option<CliConfig>,
    installed: bool,
    was_running: bool,
    applied: bool,
    pending: bool,
    config_changed: bool,
}

impl ServiceReplacement {
    pub(super) fn stage(bytes: &[u8]) -> Result<Self, DynError> {
        let executable = service::binary_dir().join("gsvd.exe");
        let staged = executable.with_file_name(format!(".gsvd-{}.new", uuid::Uuid::new_v4()));
        let installed = service::installed()?;
        if installed {
            validate_registration(&service::open(ServiceAccess::QUERY_CONFIG)?.query_config()?)?;
        }
        let was_running = installed
            && service::open(ServiceAccess::QUERY_STATUS)?
                .query_status()?
                .current_state
                != ServiceState::Stopped;
        let config = ConfigFile::<CliConfig>::new(service::data_dir().join("config.toml"));
        let previous_config = if installed {
            Some(config.load()?)
        } else {
            None
        };
        let descriptor = SecurityDescriptor::from_sddl(
            "O:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;GRGX;;;BU)(A;;GRGX;;;SU)",
        )?;
        let attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor.pointer,
            bInheritHandle: 0,
        };
        let name: Vec<u16> = staged.as_os_str().encode_wide().chain(Some(0)).collect();
        // SAFETY: path and descriptor remain live, and CREATE_NEW never opens
        // an existing link. Explicit BA ownership protects the image at birth.
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
        let result = file.write_all(bytes).and_then(|()| file.sync_all());
        drop(file);
        if let Err(error) = result {
            let _ = fs::remove_file(&staged);
            return Err(error.into());
        }
        Ok(Self {
            executable,
            staged,
            backup: None,
            previous_config,
            installed,
            was_running,
            applied: false,
            pending: false,
            config_changed: false,
        })
    }

    pub(super) fn was_running(&self) -> bool {
        self.was_running
    }

    pub(super) fn apply(&mut self) -> Result<(), DynError> {
        if self.executable.exists() {
            let backup = self
                .executable
                .with_file_name(format!(".gsvd-{}.backup", uuid::Uuid::new_v4()));
            fs::hard_link(&self.executable, &backup)?;
            self.backup = Some(backup);
        }
        self.pending = true;
        if self.installed {
            service::stop()?;
        }
        // Windows rename replaces the directory entry atomically. Cancellation
        // can leave either complete image, never a truncated live executable.
        fs::rename(&self.staged, &self.executable)?;
        self.applied = true;
        Ok(())
    }

    pub(super) fn save_config(&mut self, config: &CliConfig) -> Result<(), DynError> {
        ConfigFile::new(service::data_dir().join("config.toml")).save(config)?;
        self.config_changed = true;
        Ok(())
    }

    fn rollback(&mut self) -> Result<(), DynError> {
        if service::installed()? {
            service::stop()?;
        }
        if self.applied {
            if let Some(backup) = &self.backup {
                fs::rename(backup, &self.executable)?;
                self.backup = None;
            } else {
                fs::remove_file(&self.executable)?;
            }
        }
        self.applied = false;
        if self.config_changed {
            if let Some(config) = &self.previous_config {
                ConfigFile::new(service::data_dir().join("config.toml")).save(config)?;
            }
        }
        if !self.installed && service::installed()? {
            service::open(ServiceAccess::DELETE)?.delete()?;
        }
        if self.was_running {
            service::start()?;
        }
        self.pending = false;
        Ok(())
    }

    pub(super) fn finish(mut self, result: Result<(), DynError>) -> Result<(), DynError> {
        if let Err(error) = result {
            if let Err(rollback) = self.rollback() {
                return Err(format!(
                    "{error}; service rollback failed: {rollback}. Previous image retained at {:?}",
                    self.backup
                )
                .into());
            }
            return Err(error);
        }
        self.pending = false;
        Ok(())
    }
}

impl Drop for ServiceReplacement {
    fn drop(&mut self) {
        if self.pending {
            if let Err(error) = self.rollback() {
                eprintln!(
                    "Could not restore the previous gsvd service: {error}; backup: {:?}",
                    self.backup
                );
                return;
            }
        }
        let _ = fs::remove_file(&self.staged);
        if let Some(backup) = &self.backup {
            let _ = fs::remove_file(backup);
        }
    }
}
