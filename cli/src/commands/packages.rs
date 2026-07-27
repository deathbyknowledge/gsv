use gsv::kernel_client::{GatewayAuth, KernelClient};
use serde_json::json;

use crate::cli::PackagesAction;

pub(crate) async fn run_packages(
    url: &str,
    auth: GatewayAuth,
    action: PackagesAction,
) -> Result<(), Box<dyn std::error::Error>> {
    let client = KernelClient::connect_user(url, auth, |_| {}).await?;

    match action {
        PackagesAction::Sync { package, r#ref } => {
            let mut args = json!({ "packageId": package });
            if let Some(source_ref) = r#ref {
                args["ref"] = json!(source_ref);
            }
            let payload = client.request_ok("pkg.sync", Some(args)).await?;
            let packages = payload
                .get("packages")
                .and_then(|value| value.as_array())
                .cloned()
                .unwrap_or_default();

            println!("Synced {} package(s).", packages.len());
            for package in packages {
                if let Some(name) = package.get("name").and_then(|value| value.as_str()) {
                    let version = package
                        .get("version")
                        .and_then(|value| value.as_str())
                        .unwrap_or("0.0.0");
                    let resolved_commit = package
                        .get("source")
                        .and_then(|value| value.get("resolvedCommit"))
                        .and_then(|value| value.as_str())
                        .unwrap_or("<unknown>");
                    println!("- {}@{} ({})", name, version, resolved_commit);
                }
            }
        }
    }

    Ok(())
}
