use std::{
    ffi::OsString,
    fs::{self, File, OpenOptions},
    io::ErrorKind,
    os::fd::AsRawFd,
    os::unix::{
        fs::{DirBuilderExt, FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt},
        net::UnixStream as StdUnixStream,
    },
    path::{Path, PathBuf},
    time::Duration,
};

use tokio::net::{UnixListener, UnixStream};

use crate::{DaemonControlEndpoint, EndpointSafety, Error, TimeoutStage};

pub(crate) struct BoundListener {
    listener: UnixListener,
    _socket_guard: SocketGuard,
    _instance_lock: File,
}

struct SocketGuard {
    path: PathBuf,
    device: u64,
    inode: u64,
}

impl BoundListener {
    pub(crate) fn bind(endpoint: &DaemonControlEndpoint) -> Result<Self, Error> {
        let path = endpoint.path();
        let parent = path
            .parent()
            .ok_or(Error::UnsafeEndpoint(EndpointSafety::ParentNotDirectory))?;
        ensure_private_parent(parent)?;
        let instance_lock = acquire_instance_lock(path)?;
        remove_safe_stale_socket(path)?;

        let std_listener = std::os::unix::net::UnixListener::bind(path).map_err(Error::Io)?;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(Error::Io)?;
        let metadata = fs::symlink_metadata(path).map_err(Error::Io)?;
        validate_socket_metadata(&metadata)?;
        std_listener.set_nonblocking(true).map_err(Error::Io)?;
        Ok(Self {
            listener: UnixListener::from_std(std_listener).map_err(Error::Io)?,
            _socket_guard: SocketGuard {
                path: path.to_path_buf(),
                device: metadata.dev(),
                inode: metadata.ino(),
            },
            _instance_lock: instance_lock,
        })
    }

    pub(crate) async fn accept(&mut self) -> Result<UnixStream, Error> {
        let (stream, _) = self.listener.accept().await.map_err(Error::Io)?;
        verify_peer(&stream)?;
        Ok(stream)
    }
}

fn acquire_instance_lock(socket_path: &Path) -> Result<File, Error> {
    let mut lock_name = OsString::from(socket_path.as_os_str());
    lock_name.push(".lock");
    let lock_path = PathBuf::from(lock_name);
    match fs::symlink_metadata(&lock_path) {
        Ok(metadata) => validate_lock_metadata(&metadata)?,
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(Error::Io(error)),
    }

    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .mode(0o600)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
        .open(&lock_path)
        .map_err(|error| {
            if error.raw_os_error() == Some(libc::ELOOP) {
                Error::UnsafeEndpoint(EndpointSafety::LockIsSymlink)
            } else {
                Error::Io(error)
            }
        })?;
    validate_lock_metadata(&lock.metadata().map_err(Error::Io)?)?;
    // SAFETY: `lock` owns this descriptor and remains alive with the listener.
    let result = unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if result != 0 {
        let error = std::io::Error::last_os_error();
        if matches!(error.kind(), ErrorKind::WouldBlock) {
            return Err(Error::AlreadyRunning);
        }
        return Err(Error::Io(error));
    }
    Ok(lock)
}

fn validate_lock_metadata(metadata: &fs::Metadata) -> Result<(), Error> {
    if metadata.file_type().is_symlink() {
        return Err(Error::UnsafeEndpoint(EndpointSafety::LockIsSymlink));
    }
    if !metadata.file_type().is_file() {
        return Err(Error::UnsafeEndpoint(EndpointSafety::LockWrongType));
    }
    if metadata.uid() != current_uid() {
        return Err(Error::UnsafeEndpoint(EndpointSafety::LockWrongOwner));
    }
    if metadata.mode() & 0o777 != 0o600 {
        return Err(Error::UnsafeEndpoint(EndpointSafety::LockNotPrivate));
    }
    Ok(())
}

impl Drop for SocketGuard {
    fn drop(&mut self) {
        let Ok(metadata) = fs::symlink_metadata(&self.path) else {
            return;
        };
        if metadata.file_type().is_socket()
            && metadata.dev() == self.device
            && metadata.ino() == self.inode
        {
            let _ = fs::remove_file(&self.path);
        }
    }
}

pub(crate) async fn connect(
    endpoint: &DaemonControlEndpoint,
    timeout: Duration,
) -> Result<UnixStream, Error> {
    validate_client_endpoint(endpoint.path())?;
    let stream = tokio::time::timeout(timeout, UnixStream::connect(endpoint.path()))
        .await
        .map_err(|_| Error::Timeout {
            stage: TimeoutStage::Connect,
            duration: timeout,
        })?
        .map_err(Error::Io)?;
    verify_peer(&stream)?;
    Ok(stream)
}

fn ensure_private_parent(path: &Path) -> Result<(), Error> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => validate_parent_metadata(&metadata),
        Err(error) if error.kind() == ErrorKind::NotFound => {
            let mut builder = fs::DirBuilder::new();
            builder.mode(0o700);
            builder.create(path).map_err(Error::Io)?;
            fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(Error::Io)?;
            validate_parent_metadata(&fs::symlink_metadata(path).map_err(Error::Io)?)
        }
        Err(error) => Err(Error::Io(error)),
    }
}

fn validate_parent_metadata(metadata: &fs::Metadata) -> Result<(), Error> {
    if metadata.file_type().is_symlink() {
        return Err(Error::UnsafeEndpoint(EndpointSafety::ParentIsSymlink));
    }
    if !metadata.is_dir() {
        return Err(Error::UnsafeEndpoint(EndpointSafety::ParentNotDirectory));
    }
    if metadata.uid() != current_uid() {
        return Err(Error::UnsafeEndpoint(EndpointSafety::ParentWrongOwner));
    }
    if metadata.mode() & 0o777 != 0o700 {
        return Err(Error::UnsafeEndpoint(EndpointSafety::ParentNotPrivate));
    }
    Ok(())
}

fn validate_client_endpoint(path: &Path) -> Result<(), Error> {
    let parent = path
        .parent()
        .ok_or(Error::UnsafeEndpoint(EndpointSafety::ParentNotDirectory))?;
    validate_parent_metadata(&fs::symlink_metadata(parent).map_err(Error::Io)?)?;
    validate_socket_metadata(&fs::symlink_metadata(path).map_err(Error::Io)?)
}

fn validate_socket_metadata(metadata: &fs::Metadata) -> Result<(), Error> {
    if metadata.file_type().is_symlink() {
        return Err(Error::UnsafeEndpoint(EndpointSafety::EndpointIsSymlink));
    }
    if !metadata.file_type().is_socket() {
        return Err(Error::UnsafeEndpoint(EndpointSafety::EndpointWrongType));
    }
    if metadata.uid() != current_uid() {
        return Err(Error::UnsafeEndpoint(EndpointSafety::EndpointWrongOwner));
    }
    if metadata.mode() & 0o777 != 0o600 {
        return Err(Error::UnsafeEndpoint(EndpointSafety::EndpointNotPrivate));
    }
    Ok(())
}

fn remove_safe_stale_socket(path: &Path) -> Result<(), Error> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(Error::Io(error)),
    };
    if metadata.file_type().is_symlink() {
        return Err(Error::UnsafeEndpoint(EndpointSafety::EndpointIsSymlink));
    }
    if !metadata.file_type().is_socket() {
        return Err(Error::UnsafeEndpoint(EndpointSafety::EndpointWrongType));
    }
    if metadata.uid() != current_uid() {
        return Err(Error::UnsafeEndpoint(EndpointSafety::EndpointWrongOwner));
    }
    match StdUnixStream::connect(path) {
        Ok(_) => Err(Error::AlreadyRunning),
        Err(error) if error.kind() == ErrorKind::ConnectionRefused => {
            fs::remove_file(path).map_err(Error::Io)
        }
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(Error::Io(error)),
    }
}

fn verify_peer(stream: &UnixStream) -> Result<(), Error> {
    if stream.peer_cred().map_err(Error::Io)?.uid() != current_uid() {
        return Err(Error::PeerIdentity);
    }
    Ok(())
}

fn current_uid() -> u32 {
    // SAFETY: geteuid has no preconditions and does not dereference pointers.
    unsafe { libc::geteuid() }
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use tempfile::TempDir;

    use super::*;

    fn endpoint_in(temp: &TempDir) -> DaemonControlEndpoint {
        let parent = temp.path().join("private");
        fs::create_dir(&parent).expect("private directory created");
        fs::set_permissions(&parent, fs::Permissions::from_mode(0o700))
            .expect("private permissions set");
        DaemonControlEndpoint::from_path(parent.join("daemon.sock"))
    }

    #[tokio::test]
    async fn endpoint_is_private_single_instance_and_same_user() {
        let temp = TempDir::new().expect("temp dir");
        let endpoint = endpoint_in(&temp);
        let mut listener = BoundListener::bind(&endpoint).expect("listener binds");
        assert!(matches!(
            BoundListener::bind(&endpoint),
            Err(Error::AlreadyRunning)
        ));
        let client_task = tokio::spawn({
            let endpoint = endpoint.clone();
            async move { connect(&endpoint, Duration::from_secs(1)).await }
        });
        let _server = listener.accept().await.expect("same-user client accepted");
        let _client = client_task
            .await
            .expect("client joins")
            .expect("same-user server accepted");
    }
}
