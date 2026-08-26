mod app;
mod auth_flow;
mod cli;
mod commands;
mod desktop;
mod device;
mod local_config;
mod version;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Install rustls crypto provider BEFORE tokio runtime starts
    // (required for rustls 0.23+ - must happen before any TLS operations)
    #[cfg(feature = "rustls")]
    {
        if rustls_crate::crypto::ring::default_provider()
            .install_default()
            .is_err()
        {
            return Err("Failed to install rustls crypto provider".into());
        }
    }

    // Now start tokio runtime and run async main
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(app::run())
}
