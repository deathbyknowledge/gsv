#![cfg_attr(test, allow(clippy::unwrap_used))]

mod app;
#[cfg(windows)]
mod windows_service;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(feature = "rustls")]
    {
        if rustls_crate::crypto::ring::default_provider()
            .install_default()
            .is_err()
        {
            return Err("Failed to install rustls crypto provider".into());
        }
    }

    #[cfg(windows)]
    if std::env::args_os().any(|arg| arg == "--windows-service") {
        return windows_service::run();
    }
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(app::run())
}
