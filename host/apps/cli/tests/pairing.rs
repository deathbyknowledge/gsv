#![cfg(target_os = "linux")]

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use futures_util::{SinkExt, StreamExt};
use host_config::{CliConfig, ConfigFile};
use serde_json::{json, Value};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Output, Stdio};
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpListener;
use tokio::process::Command;
use tokio_tungstenite::tungstenite::Message;

struct Fixture {
    directory: tempfile::TempDir,
    config: PathBuf,
    bin: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().expect("temporary installation");
        let bin = directory.path().join("bin");
        std::fs::create_dir(&bin).expect("fixture binaries");
        script(
            &bin.join("gsvd"),
            &format!("printf 'gsvd {}\\n'", env!("CARGO_PKG_VERSION")),
        );
        script(
            &bin.join("systemctl"),
            "printf '%s\\n' \"$*\" >> \"$GSV_TEST_COMMAND_LOG\"",
        );
        script(
            &bin.join("sudo"),
            "printf 'sudo %s\\n' \"$*\" >> \"$GSV_TEST_COMMAND_LOG\"\nexit 1",
        );
        let config = directory.path().join("config/gsv/config.toml");
        ConfigFile::<CliConfig>::new(config.clone())
            .update(|config| {
                config.gateway.url = Some("wss://cli.example/ws".into());
                config.gateway.username = Some("cli-user".into());
                config.gateway.session_token = Some("private-cli-login".into());
                Ok(())
            })
            .expect("independent CLI login");
        Self {
            directory,
            config,
            bin,
        }
    }

    fn command(&self) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_gsv"));
        command
            .env("XDG_CONFIG_HOME", self.directory.path().join("config"))
            .env_remove("GSV_URL")
            .env_remove("GSV_USER")
            .env_remove("GSV_TOKEN")
            .env_remove("GSV_PASSWORD")
            .env("GSV_GSVD_PATH", self.bin.join("gsvd"))
            .env(
                "GSV_TEST_COMMAND_LOG",
                self.directory.path().join("service.log"),
            )
            .env(
                "PATH",
                std::env::join_paths(std::iter::once(self.bin.clone()).chain(
                    std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()),
                ))
                .expect("fixture command path"),
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        command
    }

    async fn pair(&self, code: Option<&str>) -> Output {
        let mut command = self.command();
        command.arg("pair");
        if code.is_some() {
            command.arg("-");
        }
        command
            .args(["--preserve-cli-login", "--no-replace", "--workspace"])
            .arg(self.directory.path());
        let mut child = command.spawn().expect("run actual CLI");
        if let Some(code) = code {
            child
                .stdin
                .take()
                .expect("private stdin")
                .write_all(code.as_bytes())
                .await
                .expect("send invitation");
        } else {
            drop(child.stdin.take());
        }
        tokio::time::timeout(Duration::from_secs(10), child.wait_with_output())
            .await
            .expect("bounded pairing")
            .expect("CLI result")
    }

    fn load(&self) -> CliConfig {
        ConfigFile::new(self.config.clone())
            .load()
            .expect("load resulting config")
    }
}

#[tokio::test]
async fn service_overrides_change_the_machine_identity_without_changing_the_cli_login() {
    let fixture = Fixture::new();
    let output = fixture
        .command()
        .args([
            "--url",
            "wss://machine.example/ws",
            "--user",
            "machine-owner",
            "--token",
            "machine-credential",
            "daemon",
            "install",
        ])
        .output()
        .await
        .expect("install service");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let config = fixture.load();
    assert_eq!(config.device_gateway_url(), "wss://machine.example/ws");
    assert_eq!(
        config.device_gateway_username().as_deref(),
        Some("machine-owner")
    );
    assert_eq!(config.device.token.as_deref(), Some("machine-credential"));
    assert_eq!(config.gateway.url.as_deref(), Some("wss://cli.example/ws"));
    assert_eq!(config.gateway.username.as_deref(), Some("cli-user"));
    assert_eq!(
        config.gateway.session_token.as_deref(),
        Some("private-cli-login")
    );
}

fn script(path: &Path, body: &str) {
    std::fs::write(path, format!("#!/bin/sh\nset -eu\n{body}\n")).expect("fixture script");
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
        .expect("fixture executable");
}

async fn gateway(
    config: PathBuf,
    uncertain_first: bool,
    race: bool,
) -> (String, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("local pairing gateway");
    let invitation = json!({ "version": 1, "gatewayUrl": format!("http://{}", listener.local_addr().expect("local address")),
        "username": "human", "id": uuid::Uuid::new_v4().to_string(), "secret": "a".repeat(64),
        "targetId": "test-laptop", "label": "Test laptop", "expiresAt": 1_900_000_000_000_i64 });
    let code = format!(
        "gsv-pair1_{}",
        URL_SAFE_NO_PAD.encode(invitation.to_string())
    );
    let server = tokio::spawn(async move {
        let mut credential = None;
        for attempt in 0..if uncertain_first { 2 } else { 1 } {
            let (socket, _) = listener.accept().await.expect("pairing connection");
            let mut socket = tokio_tungstenite::accept_async(socket)
                .await
                .expect("WebSocket");
            let frame = socket
                .next()
                .await
                .expect("pairing frame")
                .expect("request");
            let request: Value = serde_json::from_str(frame.to_text().expect("JSON request"))
                .expect("request shape");
            assert_eq!(request["call"], "sys.pair.redeem");
            assert_eq!(request["args"]["id"], invitation["id"]);
            let saved = ConfigFile::<CliConfig>::new(config.clone())
                .load()
                .expect("durable pending credential");
            let pending = saved
                .device
                .extra
                .get("pairing_pending")
                .expect("persisted before redemption");
            assert_eq!(
                pending.get("credential").and_then(|value| value.as_str()),
                request["args"]["credential"].as_str()
            );
            if let Some(previous) = credential {
                assert_eq!(request["args"]["credential"], previous);
            }
            credential = Some(request["args"]["credential"].clone());
            if race {
                ConfigFile::<CliConfig>::new(config.clone())
                    .update(|local| {
                        local.device.id = Some("other-machine".into());
                        local.device.token = Some("other-machine-credential".into());
                        Ok(())
                    })
                    .expect("concurrent local enrollment");
            }
            let response = if uncertain_first && attempt == 0 {
                json!({ "type":"res", "id":request["id"], "ok":false, "error":{"code":503, "message":"Temporary fixture failure"} })
            } else {
                json!({ "type":"res", "id":request["id"], "ok":true, "data":{
                    "pairing":{"id":invitation["id"], "username":"human", "targetId":"test-laptop", "state":"paired"}, "tokenId":"fixture-driver-token" } })
            };
            socket
                .send(Message::Text(response.to_string()))
                .await
                .expect("pairing receipt");
        }
    });
    (code, server)
}

#[tokio::test]
async fn fresh_desktop_pairing_installs_a_user_service_and_preserves_the_cli_login() {
    let fixture = Fixture::new();
    let (code, server) = gateway(fixture.config.clone(), false, false).await;
    let output = fixture.pair(Some(&code)).await;
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    server.await.expect("gateway completes");
    let config = fixture.load();
    assert_eq!(config.gateway.url.as_deref(), Some("wss://cli.example/ws"));
    assert_eq!(config.gateway.username.as_deref(), Some("cli-user"));
    assert_eq!(
        config.gateway.session_token.as_deref(),
        Some("private-cli-login")
    );
    assert_eq!(config.device.id.as_deref(), Some("test-laptop"));
    assert!(!config.device.extra.contains_key("pairing_pending"));
    let unit = std::fs::read_to_string(
        fixture
            .directory
            .path()
            .join("config/systemd/user/gsvd.service"),
    )
    .expect("service definition");
    assert!(unit.contains("--foreground"));
    assert!(unit.contains(fixture.bin.join("gsvd").to_str().expect("daemon path")));
    let service_log = std::fs::read_to_string(fixture.directory.path().join("service.log"))
        .expect("service calls");
    assert!(service_log.contains("--user enable --now gsvd.service"));
    for line in service_log.lines().filter(|line| line.starts_with("sudo ")) {
        assert!(line.starts_with("sudo -n loginctl enable-linger "));
    }
    let retry = fixture.pair(Some(&code)).await;
    assert!(
        retry.status.success(),
        "idempotent retry needs no gateway connection"
    );
    assert_eq!(fixture.load().device.token, config.device.token);
}

#[tokio::test]
async fn interrupted_pairing_resumes_the_durable_credential() {
    let fixture = Fixture::new();
    let (code, server) = gateway(fixture.config.clone(), true, false).await;
    assert!(!fixture.pair(Some(&code)).await.status.success());
    assert!(fixture.load().device.extra.contains_key("pairing_pending"));
    assert!(fixture.pair(None).await.status.success());
    server.await.expect("both attempts complete");
    assert_eq!(fixture.load().device.id.as_deref(), Some("test-laptop"));
}

#[tokio::test]
async fn enrollment_cannot_overwrite_a_credential_installed_while_redemption_was_pending() {
    let fixture = Fixture::new();
    let (code, server) = gateway(fixture.config.clone(), false, true).await;
    assert!(!fixture.pair(Some(&code)).await.status.success());
    server
        .await
        .expect("receipt delivered after concurrent change");
    let config = fixture.load();
    assert_eq!(
        config.device.token.as_deref(),
        Some("other-machine-credential")
    );
    assert_eq!(config.device.id.as_deref(), Some("other-machine"));
    assert!(config.device.extra.contains_key("pairing_pending"));
    assert!(!fixture.directory.path().join("service.log").exists());
}
