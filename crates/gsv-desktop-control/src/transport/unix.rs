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

use crate::{DesktopControlEndpoint, EndpointSafety, Error, TimeoutStage};

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
    pub(crate) fn bind(endpoint: &DesktopControlEndpoint) -> Result<Self, Error> {
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

        let listener = UnixListener::from_std(std_listener).map_err(Error::Io)?;
        Ok(Self {
            listener,
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

    // SAFETY: the file descriptor belongs to `lock` and flock does not retain
    // a userspace pointer. The lock remains held until the File is dropped.
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
    endpoint: &DesktopControlEndpoint,
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
            let metadata = fs::symlink_metadata(path).map_err(Error::Io)?;
            validate_parent_metadata(&metadata)
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
    let parent_metadata = fs::symlink_metadata(parent).map_err(Error::Io)?;
    validate_parent_metadata(&parent_metadata)?;

    let metadata = fs::symlink_metadata(path).map_err(Error::Io)?;
    validate_socket_metadata(&metadata)
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
    validate_stale_socket_metadata(&metadata)?;

    match StdUnixStream::connect(path) {
        Ok(_) => Err(Error::AlreadyRunning),
        Err(error) if error.kind() == ErrorKind::ConnectionRefused => {
            fs::remove_file(path).map_err(Error::Io)
        }
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(Error::Io(error)),
    }
}

fn validate_stale_socket_metadata(metadata: &fs::Metadata) -> Result<(), Error> {
    if metadata.file_type().is_symlink() {
        return Err(Error::UnsafeEndpoint(EndpointSafety::EndpointIsSymlink));
    }
    if !metadata.file_type().is_socket() {
        return Err(Error::UnsafeEndpoint(EndpointSafety::EndpointWrongType));
    }
    if metadata.uid() != current_uid() {
        return Err(Error::UnsafeEndpoint(EndpointSafety::EndpointWrongOwner));
    }
    Ok(())
}

fn verify_peer(stream: &UnixStream) -> Result<(), Error> {
    let credentials = stream.peer_cred().map_err(Error::Io)?;
    if credentials.uid() != current_uid() {
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
    use std::os::unix::fs::{symlink, PermissionsExt};

    use tempfile::TempDir;

    use super::*;

    fn endpoint_in(temp: &TempDir) -> DesktopControlEndpoint {
        let parent = temp.path().join("private");
        fs::create_dir(&parent).expect("private directory created");
        fs::set_permissions(&parent, fs::Permissions::from_mode(0o700))
            .expect("private permissions set");
        DesktopControlEndpoint::from_path(parent.join("desktop.sock"))
    }

    fn lock_path(endpoint: &DesktopControlEndpoint) -> PathBuf {
        let mut value = OsString::from(endpoint.path().as_os_str());
        value.push(".lock");
        PathBuf::from(value)
    }

    #[tokio::test]
    async fn bind_is_single_instance_and_drop_removes_only_its_socket() {
        let temp = TempDir::new().expect("temp dir");
        let endpoint = endpoint_in(&temp);
        let first = BoundListener::bind(&endpoint).expect("first server binds");
        assert!(matches!(
            BoundListener::bind(&endpoint),
            Err(Error::AlreadyRunning)
        ));

        drop(first);
        assert!(!endpoint.path().exists());
        let second = BoundListener::bind(&endpoint).expect("socket can be rebound");
        drop(second);
    }

    #[tokio::test]
    async fn replaces_only_an_owned_stale_socket() {
        let temp = TempDir::new().expect("temp dir");
        let endpoint = endpoint_in(&temp);
        let stale =
            std::os::unix::net::UnixListener::bind(endpoint.path()).expect("stale socket binds");
        drop(stale);

        let listener = BoundListener::bind(&endpoint).expect("stale socket replaced");
        drop(listener);
    }

    #[test]
    fn rejects_endpoint_and_parent_symlinks() {
        let temp = TempDir::new().expect("temp dir");
        let endpoint = endpoint_in(&temp);
        let target = temp.path().join("target");
        fs::write(&target, b"not a socket").expect("target created");
        symlink(&target, endpoint.path()).expect("endpoint symlink created");
        assert!(matches!(
            BoundListener::bind(&endpoint),
            Err(Error::UnsafeEndpoint(EndpointSafety::EndpointIsSymlink))
        ));

        let real_parent = temp.path().join("real-parent");
        fs::create_dir(&real_parent).expect("real parent created");
        fs::set_permissions(&real_parent, fs::Permissions::from_mode(0o700))
            .expect("permissions set");
        let linked_parent = temp.path().join("linked-parent");
        symlink(&real_parent, &linked_parent).expect("parent symlink created");
        let linked_endpoint = DesktopControlEndpoint::from_path(linked_parent.join("desktop.sock"));
        assert!(matches!(
            BoundListener::bind(&linked_endpoint),
            Err(Error::UnsafeEndpoint(EndpointSafety::ParentIsSymlink))
        ));
    }

    #[test]
    fn rejects_public_parent_permissions_and_non_socket_targets() {
        let temp = TempDir::new().expect("temp dir");
        let public_parent = temp.path().join("public");
        fs::create_dir(&public_parent).expect("public parent created");
        fs::set_permissions(&public_parent, fs::Permissions::from_mode(0o755))
            .expect("permissions set");
        let endpoint = DesktopControlEndpoint::from_path(public_parent.join("desktop.sock"));
        assert!(matches!(
            BoundListener::bind(&endpoint),
            Err(Error::UnsafeEndpoint(EndpointSafety::ParentNotPrivate))
        ));

        let private_endpoint = endpoint_in(&temp);
        fs::write(private_endpoint.path(), b"ordinary file").expect("file created");
        assert!(matches!(
            BoundListener::bind(&private_endpoint),
            Err(Error::UnsafeEndpoint(EndpointSafety::EndpointWrongType))
        ));
    }

    #[tokio::test]
    async fn rejects_a_symlinked_instance_lock() {
        let temp = TempDir::new().expect("temp dir");
        let endpoint = endpoint_in(&temp);
        let target = temp.path().join("lock-target");
        fs::write(&target, b"target").expect("target created");
        symlink(target, lock_path(&endpoint)).expect("lock symlink created");

        assert!(matches!(
            BoundListener::bind(&endpoint),
            Err(Error::UnsafeEndpoint(EndpointSafety::LockIsSymlink))
        ));
    }

    #[tokio::test]
    async fn client_rejects_a_socket_with_public_permissions() {
        let temp = TempDir::new().expect("temp dir");
        let endpoint = endpoint_in(&temp);
        let listener = BoundListener::bind(&endpoint).expect("server binds");
        fs::set_permissions(endpoint.path(), fs::Permissions::from_mode(0o666))
            .expect("permissions changed");

        assert!(matches!(
            connect(&endpoint, Duration::from_millis(100)).await,
            Err(Error::UnsafeEndpoint(EndpointSafety::EndpointNotPrivate))
        ));
        drop(listener);
    }
}
