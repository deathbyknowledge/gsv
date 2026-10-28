mod app;
mod auth_flow;
mod cli;
mod commands;
mod desktop;
mod device;
mod local_config;
mod markdown;
mod pairing;
mod remote;
mod render;
mod version;

use std::process::ExitCode;

use gsv::connection::GatewayRpcError;

use crate::render::{Style, Tone};

fn main() -> ExitCode {
    // Install rustls crypto provider BEFORE tokio runtime starts
    // (required for rustls 0.23+ - must happen before any TLS operations)
    #[cfg(feature = "rustls")]
    {
        if rustls_crate::crypto::ring::default_provider()
            .install_default()
            .is_err()
        {
            eprintln!("Error: failed to install the rustls crypto provider");
            return ExitCode::FAILURE;
        }
    }

    // Now start tokio runtime and run async main
    let result = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(Box::<dyn std::error::Error>::from)
        .and_then(|runtime| runtime.block_on(app::run()));
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => report(error.as_ref()),
    }
}

/// Prints a failure as one plain sentence. Syscall failures keep the call
/// and code in a dim suffix so they stay diagnosable.
fn report(error: &(dyn std::error::Error + 'static)) -> ExitCode {
    if let Some(exit) = error.downcast_ref::<remote::Exit>() {
        return ExitCode::from(exit.0);
    }
    let style = Style::stderr();
    let label = style.paint(Tone::Bad, "Error:");
    match error.downcast_ref::<GatewayRpcError>() {
        Some(rpc) if rpc.code == 401 => {
            eprintln!("{label} You're signed out of your Ship. Sign in with: gsv login")
        }
        Some(rpc) => eprintln!(
            "{label} {} {}",
            rpc.message,
            style.dim(&format!("({}, code {})", rpc.call, rpc.code))
        ),
        None => eprintln!("{label} {error}"),
    }
    ExitCode::FAILURE
}
