#![cfg(target_os = "linux")]

use daemon_protocol::{ClientOptions, DaemonControlClient, DaemonControlEndpoint};
use futures_util::{SinkExt, StreamExt};
use host_config::{CliConfig, ConfigFile};
use serde_json::{json, Value};
use std::{process::Stdio, time::Duration};
use tokio::{net::TcpListener, process::Command};
use tokio_tungstenite::tungstenite::Message;

#[tokio::test]
async fn enrolled_daemon_connects_independently_of_the_cli_login() {
    for unrelated_cli_login in [false, true] {
        let directory = tempfile::tempdir().expect("isolated installation");
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("fixture gateway");
        let mut config = CliConfig::default();
        config.device.id = Some("fixture-laptop".into());
        config.device.gateway_url = Some(format!(
            "ws://{}/ws",
            listener.local_addr().expect("gateway address")
        ));
        config.device.gateway_username = Some("machine-owner".into());
        config.device.token = Some("fixture-machine-credential".into());
        config.device.workspace = Some(directory.path().to_owned());
        config.device.auto_update = Some(false);
        if unrelated_cli_login {
            config.gateway.url = Some("ws://127.0.0.1:1/ws".into());
            config.gateway.username = Some("cli-owner".into());
            config.gateway.session_token = Some("fixture-cli-credential".into());
        }
        ConfigFile::new(directory.path().join("config/gsv/config.toml"))
            .save(&config)
            .expect("saved enrollment");
        let mut daemon = Command::new(env!("CARGO_BIN_EXE_gsvd"))
            .arg("--foreground")
            .env("XDG_CONFIG_HOME", directory.path().join("config"))
            .env("XDG_RUNTIME_DIR", directory.path())
            .env("GSV_DEVICE_LOG", "off")
            .env("GSV_DEVICE_CONSOLE_FORMAT", "quiet")
            .env_remove("GSV_URL")
            .env_remove("GSV_USER")
            .env_remove("GSV_TOKEN")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .expect("start actual daemon");

        let (socket, _) = tokio::time::timeout(Duration::from_secs(5), listener.accept())
            .await
            .expect("daemon reaches its saved gateway")
            .expect("accepted connection");
        let mut socket = tokio_tungstenite::accept_async(socket)
            .await
            .expect("WebSocket");
        let frame = tokio::time::timeout(Duration::from_secs(5), socket.next())
            .await
            .expect("bounded handshake")
            .expect("handshake frame")
            .expect("connect request");
        let request: Value =
            serde_json::from_str(frame.to_text().expect("text frame")).expect("JSON frame");
        assert_eq!(request["call"], "sys.connect");
        assert_eq!(request["args"]["auth"]["username"], "machine-owner");
        assert_eq!(
            request["args"]["auth"]["token"],
            "fixture-machine-credential"
        );
        assert_eq!(request["args"]["peer"]["id"], "fixture-laptop");
        socket.send(Message::Text(json!({
            "type": "res", "id": request["id"], "ok": true,
            "data": {
                "protocol": request["args"]["protocol"],
                "server": { "connectionId": "fixture-connection", "version": env!("CARGO_PKG_VERSION"), "release": "stable" },
                "peer": {
                    "id": "fixture-laptop", "sessionId": "fixture-session",
                    "principal": { "kind": "machine", "account": {
                        "uid": 1, "gid": 1, "gids": [1], "username": "machine-owner", "home": "/home/machine-owner", "cwd": "/home/machine-owner"
                    } },
                    "grant": { "calls": [], "signals": [], "implements": request["args"]["peer"]["implements"] }
                }
            }
        }).to_string())).await.expect("accept machine");

        // SAFETY: geteuid has no preconditions and does not dereference pointers.
        let uid = unsafe { libc::geteuid() };
        let client = DaemonControlClient::new(
            DaemonControlEndpoint::from_path(
                directory
                    .path()
                    .join(format!("gsv-{uid}/daemon-control-v1.sock")),
            ),
            ClientOptions::default(),
        );
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let status = client.status().await.expect("running daemon");
                if status.connected {
                    assert_eq!(status.machine_id, "fixture-laptop");
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("connected status exposed to Desktop");
        client.shutdown().await.expect("clean daemon shutdown");
        assert!(tokio::time::timeout(Duration::from_secs(5), daemon.wait())
            .await
            .expect("bounded shutdown")
            .expect("daemon exit")
            .success());
    }
}
