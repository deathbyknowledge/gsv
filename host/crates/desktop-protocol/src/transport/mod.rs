#[cfg(unix)]
pub(crate) mod unix;
#[cfg(windows)]
pub(crate) mod windows;

#[cfg(unix)]
pub(crate) use unix::{connect, BoundListener};
#[cfg(windows)]
pub(crate) use windows::{connect, BoundListener};
