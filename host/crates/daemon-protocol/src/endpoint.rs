use crate::Error;

#[cfg(unix)]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DaemonControlEndpoint {
    path: std::path::PathBuf,
}

#[cfg(unix)]
impl DaemonControlEndpoint {
    pub fn current_user() -> Result<Self, Error> {
        use std::path::PathBuf;

        let parent = std::env::var_os("XDG_RUNTIME_DIR")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir)
            // SAFETY: geteuid has no preconditions and does not dereference pointers.
            .join(format!("gsv-{}", unsafe { libc::geteuid() }));
        Ok(Self {
            path: parent.join("daemon-control-v1.sock"),
        })
    }

    #[must_use]
    pub fn from_path(path: impl Into<std::path::PathBuf>) -> Self {
        Self { path: path.into() }
    }

    #[must_use]
    pub fn path(&self) -> &std::path::Path {
        &self.path
    }
}

#[cfg(windows)]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DaemonControlEndpoint {
    pipe_name: std::ffi::OsString,
    service: bool,
}

#[cfg(windows)]
impl DaemonControlEndpoint {
    pub fn current_user() -> Result<Self, Error> {
        if windows_host::service::is_service_process()
            || windows_host::service::installed()
                .map_err(|error| Error::Io(std::io::Error::other(error)))?
        {
            return Ok(Self {
                pipe_name: r"\\.\pipe\gsv-daemon-service-v1".into(),
                service: true,
            });
        }
        let sid = crate::transport::windows::current_user_sid_string()?;
        Ok(Self {
            pipe_name: format!(r"\\.\pipe\gsv-daemon-control-v1-{sid}").into(),
            service: false,
        })
    }

    #[must_use]
    pub fn from_pipe_name(name: impl Into<std::ffi::OsString>) -> Self {
        Self {
            pipe_name: name.into(),
            service: false,
        }
    }

    pub(crate) fn is_service(&self) -> bool {
        self.service
    }

    #[must_use]
    pub fn pipe_name(&self) -> &std::ffi::OsStr {
        &self.pipe_name
    }
}
