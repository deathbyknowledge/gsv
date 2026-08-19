use crate::Error;

#[cfg(unix)]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DesktopControlEndpoint {
    path: std::path::PathBuf,
}

#[cfg(unix)]
impl DesktopControlEndpoint {
    pub fn current_user() -> Result<Self, Error> {
        use std::path::PathBuf;

        let parent = std::env::var_os("XDG_RUNTIME_DIR")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir)
            // SAFETY: geteuid has no preconditions and does not dereference pointers.
            .join(format!("gsv-{}", unsafe { libc::geteuid() }));
        Ok(Self {
            path: parent.join("desktop-control-v1.sock"),
        })
    }

    /// Creates an endpoint at an explicit path.
    ///
    /// The server still enforces ownership, object type, and private
    /// permissions before binding. This is primarily useful for tests and
    /// installations with a non-standard runtime directory.
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
pub struct DesktopControlEndpoint {
    pipe_name: std::ffi::OsString,
}

#[cfg(windows)]
impl DesktopControlEndpoint {
    pub fn current_user() -> Result<Self, Error> {
        let sid = crate::transport::windows::current_user_sid_string()?;
        Ok(Self {
            pipe_name: format!(r"\\.\pipe\gsv-desktop-control-v1-{sid}").into(),
        })
    }

    /// Creates an endpoint with an explicit Windows named-pipe name.
    ///
    /// Server creation still installs a current-user-only DACL and rejects
    /// remote clients. Production callers should use [`Self::current_user`].
    #[must_use]
    pub fn from_pipe_name(pipe_name: impl Into<std::ffi::OsString>) -> Self {
        Self {
            pipe_name: pipe_name.into(),
        }
    }

    #[must_use]
    pub fn pipe_name(&self) -> &std::ffi::OsStr {
        &self.pipe_name
    }
}
