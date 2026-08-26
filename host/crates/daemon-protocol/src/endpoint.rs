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
}

#[cfg(windows)]
impl DaemonControlEndpoint {
    pub fn current_user() -> Result<Self, Error> {
        let sid = crate::transport::windows::current_user_sid_string()?;
        Ok(Self {
            pipe_name: format!(r"\\.\pipe\gsv-daemon-control-v1-{sid}").into(),
        })
    }

    #[must_use]
    pub fn from_pipe_name(name: impl Into<std::ffi::OsString>) -> Self {
        Self {
            pipe_name: name.into(),
        }
    }

    #[must_use]
    pub fn pipe_name(&self) -> &std::ffi::OsStr {
        &self.pipe_name
    }
}
