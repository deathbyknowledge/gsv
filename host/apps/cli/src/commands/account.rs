//! This computer's relationship with a Ship: signing in and out, the status
//! summary, unpairing and the update check.

use std::time::Duration;

use daemon_protocol::{DaemonPhase, DaemonStatus};
use gsv::config::CliConfig;
use gsv::kernel_client::{GatewayAuth, KernelClient};
use gsv::protocol::ServerInfo;
use serde_json::{json, Value};

use crate::auth_flow::{self, space_name, LoginRequest, SignOut};
use crate::device::{daemon_runtime_status, resolve_device_id};
use crate::remote::{self, call, DynError, Output};
use crate::render::{self, Cell, Tone};

const STATUS_TIMEOUT: Duration = Duration::from_secs(8);

pub(crate) async fn login(
    cfg: &CliConfig,
    request: LoginRequest,
    out: Output,
) -> Result<(), DynError> {
    let (session, url) = auth_flow::sign_in(cfg, request).await?;
    if out.json {
        return render::print_json(&json!({
            "space": space_name(&url),
            "url": url,
            "username": session.username,
            "expiresAt": session.expires_at,
        }));
    }
    let style = out.style;
    let lasts = session
        .expires_at
        .map(|at| (at - render::now_ms() + 1_800_000) / 3_600_000)
        .filter(|hours| *hours > 0)
        .map(|hours| {
            format!(
                " The session lasts {}.",
                render::count(usize::try_from(hours).unwrap_or(0), "hour", "hours")
            )
        })
        .unwrap_or_default();
    println!(
        "Signed in to {} as {}.{}",
        style.strong(&space_name(&url)),
        style.strong(&session.username),
        style.dim(&lasts),
    );
    print!(
        "{}",
        render::hint(&style, "Try: gsv ship \"what's on today?\"")
    );
    Ok(())
}

pub(crate) async fn logout(cfg: &CliConfig, out: Output) -> Result<(), DynError> {
    let outcome = auth_flow::sign_out(cfg).await?;
    let space = space_name(&cfg.gateway_url());
    if out.json {
        let state = match outcome {
            SignOut::NotSignedIn => "notSignedIn",
            SignOut::Ended => "ended",
            SignOut::ClearedLocally => "clearedLocally",
        };
        return render::print_json(&json!({ "space": space, "session": state }));
    }
    match outcome {
        SignOut::NotSignedIn => println!("You weren't signed in."),
        SignOut::Ended => println!("Signed out of {space}."),
        SignOut::ClearedLocally => {
            println!("Signed out on this computer.");
            print!(
                "{}",
                render::hint(
                    &out.style,
                    &format!("{space} couldn't be reached, so its session ends on its own.")
                )
            );
        }
    }
    Ok(())
}

/// What `gsv status` learns from the Ship, when signed in and reachable.
struct RemoteStatus {
    username: String,
    server: ServerInfo,
    machine: Option<Value>,
}

async fn remote_status(
    url: &str,
    auth: GatewayAuth,
    machine_id: Option<&str>,
) -> Option<RemoteStatus> {
    let probe = async {
        let client = remote::connect(url, auth).await?;
        let connect = client
            .connection()
            .connect_result
            .clone()
            .ok_or("no connect result")?;
        let machine = match machine_id {
            Some(id) => call(&client, "sys.target.get", json!({ "targetId": id }))
                .await
                .ok()
                .and_then(|result| result.get("target").cloned())
                .filter(|target| !target.is_null()),
            None => None,
        };
        Ok::<_, DynError>(RemoteStatus {
            username: connect.peer.principal.account.username,
            server: connect.server,
            machine,
        })
    };
    tokio::time::timeout(STATUS_TIMEOUT, probe)
        .await
        .ok()
        .and_then(Result::ok)
}

pub(crate) async fn status(cfg: &CliConfig, url: &str, out: Output) -> Result<(), DynError> {
    let space = cfg.gateway.url.as_ref().map(|_| space_name(url));
    let session = cfg.gateway_session_token();
    let paired = cfg.default_device_token().is_some();
    let machine_id = paired.then(|| resolve_device_id(None, cfg));
    let installed = gsv::device_service::device_service_management_supported()
        .then(gsv::device_service::device_service_is_installed)
        .and_then(Result::ok)
        .unwrap_or(false);
    let daemon = if installed {
        daemon_runtime_status().await
    } else {
        None
    };
    let remote = match &session {
        Some(token) => {
            let auth = GatewayAuth {
                username: cfg.gateway_username(),
                password: None,
                token: Some(token.clone()),
            };
            remote_status(url, auth, machine_id.as_deref()).await
        }
        None => None,
    };

    if out.json {
        return render::print_json(&json!({
            "space": space,
            "url": cfg.gateway.url,
            "signedIn": session.is_some(),
            "reachable": remote.is_some(),
            "username": remote.as_ref().map(|r| r.username.clone()).or_else(|| cfg.gateway_username()),
            "sessionExpiresAt": cfg.gateway.session_expires_at.filter(|_| session.is_some()),
            "paired": paired,
            "machine": {
                "id": machine_id,
                "label": cfg.device.label,
                "target": remote.as_ref().and_then(|r| r.machine.clone()),
            },
            "service": { "installed": installed, "daemon": daemon },
            "versions": {
                "cli": gsv::build_info::PACKAGE_VERSION,
                "ship": remote.as_ref().map(|r| r.server.version.clone()),
            },
        }));
    }

    let now = render::now_ms();
    let mut rows: Vec<(&str, Cell)> = Vec::new();
    let mut next: Vec<&str> = Vec::new();
    rows.push((
        "Ship",
        match &space {
            Some(space) => Cell::new(space.clone(), Tone::Strong),
            None => Cell::new("none chosen", Tone::Dim),
        },
    ));
    rows.push((
        "Signed in",
        signed_in_cell(cfg, session.is_some(), remote.as_ref(), now),
    ));
    if session.is_none() {
        next.push("Sign in: gsv login me.ship.space");
    }
    rows.push((
        "This computer",
        computer_cell(
            cfg,
            paired,
            remote.as_ref().and_then(|r| r.machine.as_ref()),
        ),
    ));
    if !paired {
        next.push("Connect this computer: open Work in the web app, click connect, then run gsv pair CODE");
    }
    if paired || installed {
        rows.push(("Service", service_cell(installed, daemon.as_ref())));
    }
    let mut versions = format!("CLI {}", gsv::build_info::PACKAGE_VERSION);
    if let Some(remote) = &remote {
        versions.push_str(&format!(" · Ship {}", remote.server.version));
    }
    let update = remote
        .as_ref()
        .and_then(|remote| release_hint(gsv::build_info::PACKAGE_VERSION, &remote.server));
    rows.push((
        "Versions",
        Cell::new(
            if update.is_some() {
                format!("{versions} · update available")
            } else {
                versions
            },
            if update.is_some() {
                Tone::Warn
            } else {
                Tone::Normal
            },
        ),
    ));
    if update.is_some() {
        next.push("Update: gsv update");
    }
    print!("{}", render::detail(&out.style, &rows));
    if !next.is_empty() {
        println!();
        for line in next {
            print!("{}", render::hint(&out.style, line));
        }
    }
    Ok(())
}

fn signed_in_cell(
    cfg: &CliConfig,
    has_session: bool,
    remote: Option<&RemoteStatus>,
    now: i64,
) -> Cell {
    if !has_session {
        return Cell::new("no", Tone::Warn);
    }
    let name = remote
        .map(|remote| remote.username.clone())
        .or_else(|| cfg.gateway_username())
        .unwrap_or_else(|| "your account".to_string());
    let ends = cfg
        .gateway
        .session_expires_at
        .map(|at| format!(" · session ends {}", render::relative_time(at, now)))
        .unwrap_or_default();
    match remote {
        Some(_) => Cell::new(format!("yes, as {name}{ends}"), Tone::Good),
        None => Cell::new(
            format!("as {name}, but your Ship can't be reached"),
            Tone::Warn,
        ),
    }
}

fn computer_cell(cfg: &CliConfig, paired: bool, target: Option<&Value>) -> Cell {
    if !paired {
        return Cell::new("not paired", Tone::Dim);
    }
    let name = target
        .and_then(|target| remote::opt_text(target, "label"))
        .map(str::to_string)
        .or_else(|| cfg.device.label.clone())
        .unwrap_or_else(|| resolve_device_id(None, cfg));
    match target.map(|target| remote::flag(target, "online")) {
        Some(true) => Cell::new(format!("paired as \"{name}\" · online"), Tone::Good),
        Some(false) => Cell::new(format!("paired as \"{name}\" · offline"), Tone::Warn),
        None => Cell::new(format!("paired as \"{name}\""), Tone::Normal),
    }
}

fn service_cell(installed: bool, daemon: Option<&DaemonStatus>) -> Cell {
    if !installed {
        return Cell::new("not installed · run gsv pair to finish setup", Tone::Warn);
    }
    let Some(daemon) = daemon else {
        return Cell::new("installed, not running · gsv daemon start", Tone::Warn);
    };
    let uptime = format_uptime(daemon.uptime_seconds);
    match daemon.phase {
        DaemonPhase::Connected => Cell::new(format!("running {uptime} · connected"), Tone::Good),
        DaemonPhase::Unpaired => Cell::new("running · waiting to be paired", Tone::Warn),
        DaemonPhase::Reconnecting => Cell::new(
            format!(
                "running · reconnecting (attempt {})",
                daemon.reconnect_attempt
            ),
            Tone::Warn,
        ),
        DaemonPhase::Starting | DaemonPhase::Connecting | DaemonPhase::Reloading => {
            Cell::new("running · connecting", Tone::Normal)
        }
        DaemonPhase::ShuttingDown => Cell::new("stopping", Tone::Warn),
    }
}

fn format_uptime(seconds: u64) -> String {
    match seconds {
        0..=59 => "for under a minute".to_string(),
        60..=3599 => format!("for {} min", seconds / 60),
        3600..=86_399 => format!("for {} h", seconds / 3600),
        _ => format!("for {} days", seconds / 86_400),
    }
}

/// One line when the Ship runs a newer stable release than this CLI. The
/// CLI is never replaced under a person; the installer does that on request.
pub(crate) fn release_hint(current: &str, server: &ServerInfo) -> Option<String> {
    let update = available_update(current, server)?;
    Some(format!(
        "Ship {} is available; this CLI is {current}. Update with: {}",
        update.tag, update.command
    ))
}

struct Update {
    tag: String,
    command: String,
}

fn available_update(current: &str, server: &ServerInfo) -> Option<Update> {
    use host_config::release::{parse_version, stable_tag, DEV_RELEASE_TAG};
    if server.release == DEV_RELEASE_TAG {
        return None;
    }
    let current = parse_version(current)?;
    let available = parse_version(&server.version)?;
    if available <= current {
        return None;
    }
    let installer_url = server
        .deployment
        .as_ref()
        .and_then(|deployment| deployment.install_url.as_deref())
        .filter(|url| url.starts_with("https://"))
        .unwrap_or(host_config::installer::DEFAULT_INSTALLER_URL);
    let command = host_config::installer::install_command(
        installer_url,
        &stable_tag(available),
        None,
        cfg!(windows),
    )
    .ok()?;
    Some(Update {
        tag: stable_tag(available),
        command,
    })
}

/// Compares this computer's release with the Ship's and prints the
/// installer command when a newer one exists. Installing stays the
/// installer's job.
pub(crate) async fn update(url: &str, auth: GatewayAuth, out: Output) -> Result<(), DynError> {
    let client: KernelClient = remote::connect(url, auth).await?;
    let server = client
        .connection()
        .connect_result
        .as_ref()
        .map(|result| result.server.clone())
        .ok_or("Your Ship did not report its version")?;
    let current = gsv::build_info::PACKAGE_VERSION;
    let update = available_update(current, &server);
    let development = server.release == host_config::release::DEV_RELEASE_TAG;
    if out.json {
        return render::print_json(&json!({
            "cli": current,
            "ship": server.version,
            "release": server.release,
            "available": update.as_ref().map(|update| update.tag.clone()),
            "command": update.as_ref().map(|update| update.command.clone()),
        }));
    }
    let style = out.style;
    match update {
        Some(update) => {
            println!(
                "Ship {} is available; this computer has {current}.",
                style.strong(&update.tag)
            );
            println!("Update the CLI, background service and Desktop with:\n");
            println!("  {}\n", update.command);
        }
        None if development => println!(
            "Your Ship runs a development build ({}), so there is no release to update to.",
            server.version
        ),
        None => println!("This computer is up to date ({current})."),
    }
    Ok(())
}

/// Redeems the code a messenger sends someone it doesn't know yet, which
/// links that messenger identity to this account.
pub(crate) async fn link_messenger(
    url: &str,
    auth: GatewayAuth,
    code: String,
    out: Output,
) -> Result<(), DynError> {
    let client = remote::connect(url, auth).await?;
    let result = call(&client, "sys.link.consume", json!({ "code": code.trim() })).await?;
    if out.json {
        return render::print_json(&result);
    }
    if !remote::flag(&result, "linked") {
        return Err(
            "That code didn't link anything. Message your Ship again for a new one.".into(),
        );
    }
    let adapter = result
        .get("link")
        .and_then(|link| remote::opt_text(link, "adapter"))
        .unwrap_or("messenger");
    println!("Linked. Your {adapter} messages now reach your Ship.");
    Ok(())
}

/// Forgets this computer on the Ship, which revokes its credential, then
/// removes the background service and the saved credential here.
pub(crate) async fn unpair(
    url: &str,
    auth: GatewayAuth,
    yes: bool,
    out: Output,
) -> Result<(), DynError> {
    let cfg = CliConfig::load();
    if cfg.default_device_token().is_none() {
        if out.json {
            return render::print_json(&json!({ "paired": false }));
        }
        println!("This computer isn't paired.");
        return Ok(());
    }
    let machine_id = resolve_device_id(None, &cfg);
    let name = cfg
        .device
        .label
        .clone()
        .unwrap_or_else(|| machine_id.clone());
    if !yes
        && !remote::confirm(&format!(
            "Disconnect \"{name}\" from {}? Your Ship will no longer reach its files.",
            space_name(url)
        ))?
    {
        println!("Nothing changed.");
        return Ok(());
    }
    let client = remote::connect(url, auth).await?;
    let deleted = call(
        &client,
        "sys.target.delete",
        json!({ "targetId": machine_id }),
    )
    .await?;
    let service_removed = if gsv::device_service::device_service_management_supported()
        && gsv::device_service::device_service_is_installed()?
    {
        gsv::device_service::uninstall_device_service()?;
        true
    } else {
        false
    };
    CliConfig::update(|local| {
        local.device.token = None;
        local.device.gateway_url = None;
        local.device.gateway_username = None;
    })?;
    if out.json {
        return render::print_json(&json!({
            "paired": false,
            "target": deleted,
            "serviceRemoved": service_removed,
        }));
    }
    println!("Disconnected \"{name}\" from your Ship.");
    if service_removed {
        print!(
            "{}",
            render::hint(&out.style, "The background service is removed.")
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server(version: &str, release: &str) -> ServerInfo {
        ServerInfo {
            deployment: None,
            version: version.to_string(),
            release: release.to_string(),
            features: Vec::new(),
            connection_id: "conn".to_string(),
        }
    }

    #[test]
    fn hints_only_for_a_newer_stable_gateway() {
        let hint = release_hint("0.4.1", &server("0.4.2", "v0.4.2")).expect("newer hints");
        assert!(hint.starts_with("Ship v0.4.2 is available; this CLI is 0.4.1."));
        assert!(hint.contains("https://install.ship.space"));
        assert_eq!(release_hint("0.4.1", &server("0.4.1", "v0.4.1")), None);
        assert_eq!(release_hint("0.4.1", &server("0.9.0", "dev")), None);
        assert_eq!(release_hint("0.4.1", &server("nope", "")), None);
    }

    #[test]
    fn update_hints_use_the_operator_installer_and_gateway_release() {
        let mut newer = server("0.4.2", "v0.4.2");
        newer.deployment = Some(
            serde_json::from_value(serde_json::json!({
                "installUrl": "https://downloads.example/host/install.sh?channel=stable",
                "legacyDomains": [],
            }))
            .expect("deployment config"),
        );
        let hint = release_hint("0.4.1", &newer).expect("newer hints");
        let script = if cfg!(windows) {
            "install.ps1"
        } else {
            "install.sh"
        };
        assert!(hint.contains(&format!(
            "https://downloads.example/host/{script}?channel=stable"
        )));
        assert!(hint.contains("GSV_VERSION='v0.4.2'"));
        assert!(!hint.contains("install.ship.space"));
    }

    #[test]
    fn service_states_read_as_sentences() {
        let mut daemon = DaemonStatus {
            version: "0.7.5".into(),
            process_id: 1,
            machine_id: "device-x".into(),
            phase: DaemonPhase::Connected,
            connected: true,
            uptime_seconds: 7_300,
            reconnect_attempt: 0,
        };
        assert_eq!(
            service_cell(true, Some(&daemon)).text(),
            "running for 2 h · connected"
        );
        daemon.phase = DaemonPhase::Reconnecting;
        daemon.reconnect_attempt = 3;
        assert_eq!(
            service_cell(true, Some(&daemon)).text(),
            "running · reconnecting (attempt 3)"
        );
        assert!(service_cell(true, None).text().contains("gsv daemon start"));
    }
}
