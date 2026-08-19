use clap::Parser;
use gateway_client::client::GatewayAuth;
use host_config::CliConfig;
use std::path::PathBuf;

#[derive(Parser)]
#[command(name = "gsvd", version, about = "GSV machine driver daemon")]
struct Args {
    /// Gateway URL (overrides local GSV configuration)
    #[arg(long, env = "GSV_URL")]
    url: Option<String>,

    /// Gateway username (overrides local GSV configuration)
    #[arg(short = 'u', long, env = "GSV_USER")]
    user: Option<String>,

    /// Non-interactive driver credential
    #[arg(short = 't', long, env = "GSV_TOKEN", hide_env_values = true)]
    token: Option<String>,

    /// Device ID (defaults to the configured ID or local hostname)
    #[arg(long)]
    id: Option<String>,

    /// Workspace directory exposed by filesystem and shell syscalls
    #[arg(long)]
    workspace: Option<PathBuf>,

    /// Run attached to the invoking process. gsvd always remains in the foreground;
    /// service managers provide detachment and restart policy.
    #[arg(long)]
    foreground: bool,
}

pub(crate) async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse();
    let cfg = CliConfig::load();
    let url = args.url.unwrap_or_else(|| cfg.gateway_url());
    let device_id = args
        .id
        .or_else(|| cfg.default_device_id())
        .unwrap_or_else(default_device_id);
    let workspace = args
        .workspace
        .or_else(|| cfg.default_device_workspace())
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    let workspace = workspace.canonicalize().unwrap_or(workspace);
    let auth = GatewayAuth {
        username: args.user.or_else(|| cfg.gateway_username()),
        password: None,
        token: args.token.or_else(|| cfg.default_device_token()),
    };
    auth.validate()?;
    if auth.username.is_some() && auth.token.is_none() {
        return Err(
            "Missing non-interactive device credential. Run `gsv auth setup` or set `device.token` in local configuration."
                .into(),
        );
    }

    let _ = args.foreground;
    machine::device::run(&url, auth, device_id, workspace).await
}

fn default_device_id() -> String {
    let hostname = hostname::get()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|_| "unknown".to_string());
    format!("device-{hostname}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_id_is_namespaced_as_a_device() {
        assert!(default_device_id().starts_with("device-"));
    }
}
