#![cfg_attr(test, allow(clippy::unwrap_used))]

mod app;

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

    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(app::run())
}
