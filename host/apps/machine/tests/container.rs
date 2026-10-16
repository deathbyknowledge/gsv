#![allow(clippy::unwrap_used, clippy::panic)]

use std::net::SocketAddr;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use gateway_client::protocol::{
    build_binary_frame, Frame, FrameBodyDescriptor, RequestFrame, ResponseFrame, SignalFrame,
    BINARY_FRAME_DATA, REQUEST_CANCEL_SIGNAL,
};
use gateway_client::{BinaryBody, BinaryBodyChannel, BinaryBodyLimits, BodyError, IncomingBody};
use http_body_util::{BodyExt, Full};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use machine::container::{ContainerOptions, ContainerServer};
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;
use tokio_util::sync::CancellationToken;

const SECRET: &str = "private-instance-test-credential-0123456789";

struct Server {
    address: SocketAddr,
    workspace: tempfile::TempDir,
    shutdown: CancellationToken,
    task: tokio::task::JoinHandle<std::io::Result<()>>,
}

impl Server {
    async fn start() -> Self {
        let workspace = tempfile::tempdir().unwrap();
        let server = ContainerServer::bind(
            ([127, 0, 0, 1], 0).into(),
            ContainerOptions {
                target_id: "cloud-test".to_string(),
                workspace: workspace.path().to_path_buf(),
                secret: SECRET.to_string(),
            },
        )
        .await
        .unwrap();
        let address = server.local_addr().unwrap();
        let shutdown = CancellationToken::new();
        let task = tokio::spawn(server.run(shutdown.clone()));
        Self {
            address,
            workspace,
            shutdown,
            task,
        }
    }

    async fn health(&self) -> Value {
        let response = reqwest::Client::new()
            .get(format!("http://{}/health", self.address))
            .bearer_auth(SECRET)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        serde_json::from_slice(&response.bytes().await.unwrap()).unwrap()
    }

    async fn stop(self) {
        self.shutdown.cancel();
        tokio::time::timeout(Duration::from_secs(5), self.task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
    }
}

struct Outbound {
    message: Message,
    sent: oneshot::Sender<()>,
}

struct Peer {
    sender: mpsc::Sender<Outbound>,
    frames: mpsc::UnboundedReceiver<(Frame, Option<IncomingBody>)>,
    channel: BinaryBodyChannel,
    shutdown: CancellationToken,
    tasks: Vec<tokio::task::JoinHandle<()>>,
    signals: Vec<SignalFrame>,
}

impl Peer {
    async fn connect(address: SocketAddr) -> Self {
        let health = reqwest::Client::new()
            .get(format!("http://{address}/health"))
            .bearer_auth(SECRET)
            .send()
            .await
            .unwrap()
            .bytes()
            .await
            .unwrap();
        let health: Value = serde_json::from_slice(&health).unwrap();
        let boot_id = health["bootId"].as_str().unwrap();
        let mut request = format!("ws://{address}/gsv").into_client_request().unwrap();
        request
            .headers_mut()
            .insert("Authorization", format!("Bearer {SECRET}").parse().unwrap());
        request
            .headers_mut()
            .insert("x-gsv-boot-id", boot_id.parse().unwrap());
        let (socket, response) =
            tokio_tungstenite::client_async(request, TcpStream::connect(address).await.unwrap())
                .await
                .unwrap();
        assert_eq!(response.headers()["x-gsv-boot-id"], boot_id);
        let (mut sink, mut source) = socket.split();
        let (sender, mut outbound) = mpsc::channel::<Outbound>(16);
        let channel = BinaryBodyChannel::new(BinaryBodyLimits::default(), {
            let sender = sender.clone();
            move |bytes| {
                let sender = sender.clone();
                async move {
                    let (sent, received) = oneshot::channel();
                    sender
                        .send(Outbound {
                            message: Message::Binary(bytes),
                            sent,
                        })
                        .await
                        .map_err(|_| BodyError::Transport("Test socket closed".to_string()))?;
                    received
                        .await
                        .map_err(|_| BodyError::Transport("Test socket closed".to_string()))
                }
            }
        })
        .unwrap();
        let shutdown = CancellationToken::new();
        let writer = tokio::spawn({
            let shutdown = shutdown.clone();
            async move {
                loop {
                    tokio::select! {
                        biased;
                        _ = shutdown.cancelled() => break,
                        message = outbound.recv() => {
                            let Some(message) = message else { break };
                            if sink.send(message.message).await.is_err() { break; }
                            let _ = message.sent.send(());
                        }
                    }
                }
            }
        });
        let (frames, received) = mpsc::unbounded_channel();
        let reader = tokio::spawn({
            let shutdown = shutdown.clone();
            let channel = channel.clone();
            async move {
                loop {
                    let message = tokio::select! {
                        biased;
                        _ = shutdown.cancelled() => break,
                        message = source.next() => message,
                    };
                    match message {
                        Some(Ok(Message::Text(text))) => {
                            let frame: Frame = serde_json::from_str(&text).unwrap();
                            let descriptor = match &frame {
                                Frame::Res(response) => response.body,
                                _ => None,
                            };
                            let body =
                                descriptor.map(|descriptor| channel.receive(descriptor).unwrap());
                            if frames.send((frame, body)).is_err() {
                                break;
                            }
                        }
                        Some(Ok(Message::Binary(bytes))) => {
                            assert!(channel.handle_frame(&bytes).await);
                        }
                        Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                        _ => {}
                    }
                }
                channel.close("Test connection closed");
            }
        });
        Self {
            sender,
            frames: received,
            channel,
            shutdown,
            tasks: vec![writer, reader],
            signals: Vec::new(),
        }
    }

    async fn send(&self, message: Message) {
        let (sent, received) = oneshot::channel();
        self.sender.send(Outbound { message, sent }).await.unwrap();
        received.await.unwrap();
    }

    async fn frame(&self, frame: Frame) {
        self.send(Message::Text(serde_json::to_string(&frame).unwrap()))
            .await;
    }

    async fn cancel(&self, id: &str) {
        self.frame(Frame::Sig(SignalFrame {
            signal: REQUEST_CANCEL_SIGNAL.to_string(),
            payload: Some(json!({ "id": id })),
            seq: None,
        }))
        .await;
    }

    async fn response(&mut self, id: &str) -> (ResponseFrame, Option<Vec<u8>>) {
        tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                let (frame, body) = self
                    .frames
                    .recv()
                    .await
                    .expect("Connection closed before response");
                match frame {
                    Frame::Res(response) => {
                        assert_eq!(response.id, id);
                        let body = match body {
                            Some(body) => Some(body.read_all(16 * 1024 * 1024).await.unwrap()),
                            None => None,
                        };
                        return (response, body);
                    }
                    Frame::Sig(signal) => self.signals.push(signal),
                    Frame::Req(_) => panic!("Unexpected server request"),
                }
            }
        })
        .await
        .expect("Request timed out")
    }

    async fn call(
        &mut self,
        call: &str,
        args: Value,
        body: Option<Vec<u8>>,
    ) -> (ResponseFrame, Option<Vec<u8>>) {
        let outgoing = body.map(|body| self.channel.prepare(BinaryBody::from_bytes(body)).unwrap());
        let mut request = RequestFrame::new(call, Some(args));
        request.body = outgoing.as_ref().map(|body| body.descriptor());
        let id = request.id.clone();
        self.frame(Frame::Req(request)).await;
        let sending = tokio::spawn(async move {
            if let Some(body) = outgoing {
                body.send().await.unwrap();
            }
        });
        let response = self.response(&id).await;
        sending.await.unwrap();
        response
    }

    async fn disconnect(self) {
        self.shutdown.cancel();
        for task in self.tasks {
            task.await.unwrap();
        }
        self.channel.close("Test disconnected");
    }

    #[cfg(unix)]
    async fn exec_status(&mut self, session_id: &str, event: &str) -> Value {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Some(index) = self.signals.iter().position(|signal| {
                    signal.signal == "exec.status"
                        && signal.payload.as_ref().is_some_and(|payload| {
                            payload["sessionId"] == session_id && payload["event"] == event
                        })
                }) {
                    return self.signals.remove(index).payload.unwrap();
                }
                let (frame, body) = self.frames.recv().await.unwrap();
                assert!(body.is_none());
                match frame {
                    Frame::Sig(signal) => self.signals.push(signal),
                    _ => panic!("Unexpected response while waiting for exec.status"),
                }
            }
        })
        .await
        .expect("Missing exec.status signal")
    }
}

#[tokio::test]
async fn private_health_and_websocket_require_instance_authority() {
    let server = Server::start().await;
    for path in ["health", "gsv"] {
        let response = reqwest::Client::new()
            .get(format!("http://{}/{path}", server.address))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 401);
        let response = reqwest::Client::new()
            .get(format!("http://{}/{path}", server.address))
            .bearer_auth("wrong")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 401);
    }
    let health = server.health().await;
    assert_eq!(health["protocol"], 4);
    assert_eq!(health["targetId"], "cloud-test");
    assert_eq!(
        health["implements"],
        json!(["fs.*", "shell.exec", "shell.cancel", "net.fetch"])
    );
    assert!(uuid::Uuid::parse_str(health["bootId"].as_str().unwrap()).is_ok());
    assert_eq!(health, server.health().await);
    for expected_boot in [None, Some("stale-boot")] {
        let mut request = reqwest::Client::new()
            .get(format!("http://{}/gsv", server.address))
            .bearer_auth(SECRET);
        if let Some(expected_boot) = expected_boot {
            request = request.header("x-gsv-boot-id", expected_boot);
        }
        assert_eq!(request.send().await.unwrap().status(), 409);
    }
    server.stop().await;
    let fresh = Server::start().await;
    assert_ne!(fresh.health().await["bootId"], health["bootId"]);
    fresh.stop().await;
}

#[tokio::test]
async fn binary_file_transfers_cross_multiple_credit_windows() {
    let server = Server::start().await;
    let mut peer = Peer::connect(server.address).await;
    let bytes: Vec<u8> = (0..6 * 1024 * 1024 + 17)
        .map(|index| (index % 251) as u8)
        .collect();
    let (uploaded, _) = peer
        .call(
            "fs.transfer.receive",
            json!({ "path": "nested/binary.dat" }),
            Some(bytes.clone()),
        )
        .await;
    assert!(uploaded.ok);
    assert_eq!(uploaded.data.unwrap()["bytesWritten"], bytes.len());
    let (downloaded, body) = peer
        .call(
            "fs.transfer.send",
            json!({ "path": "nested/binary.dat" }),
            None,
        )
        .await;
    assert!(downloaded.ok);
    assert_eq!(body.unwrap(), bytes);
    let (missing, _) = peer
        .call("fs.read", json!({ "path": "missing" }), None)
        .await;
    assert!(missing.ok, "filesystem failure remains an ordinary result");
    assert_eq!(missing.data.unwrap()["ok"], false);
    peer.disconnect().await;
    server.stop().await;
}

#[tokio::test]
async fn network_fetch_uses_the_same_binary_request_and_response_bodies() {
    let origin = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let address = origin.local_addr().unwrap();
    let origin = tokio::spawn(async move {
        let (socket, _) = origin.accept().await.unwrap();
        http1::Builder::new()
            .serve_connection(
                TokioIo::new(socket),
                service_fn(|request: hyper::Request<hyper::body::Incoming>| async {
                    assert_eq!(request.method(), "POST");
                    assert_eq!(
                        request.headers()["content-type"],
                        "application/octet-stream"
                    );
                    let body = request.into_body().collect().await.unwrap().to_bytes();
                    Ok::<_, std::convert::Infallible>(hyper::Response::new(Full::new(body)))
                }),
            )
            .await
            .unwrap();
    });
    let server = Server::start().await;
    let mut peer = Peer::connect(server.address).await;
    let bytes = vec![0, 255, 137, 128, 42, 0, 192];
    let (response, body) = peer
        .call(
            "net.fetch",
            json!({
                "url": format!("http://{address}/echo"),
                "method": "POST",
                "headers": { "Content-Type": "application/octet-stream" },
            }),
            Some(bytes.clone()),
        )
        .await;
    assert!(response.ok);
    assert_eq!(response.data.unwrap()["status"], 200);
    assert_eq!(body.unwrap(), bytes);
    peer.disconnect().await;
    server.stop().await;
    tokio::time::timeout(Duration::from_secs(5), origin)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn cancelled_or_disconnected_uploads_preserve_the_destination_and_remove_partial_files() {
    let server = Server::start().await;
    let path = server.workspace.path().join("kept.dat");
    tokio::fs::write(&path, b"original").await.unwrap();
    for disconnect in [false, true] {
        let peer = Peer::connect(server.address).await;
        let mut request =
            RequestFrame::new("fs.transfer.receive", Some(json!({ "path": "kept.dat" })));
        request.body = Some(FrameBodyDescriptor {
            stream_id: 1,
            length: Some(1024),
            delivery: None,
        });
        let id = request.id.clone();
        peer.frame(Frame::Req(request)).await;
        peer.send(Message::Binary(build_binary_frame(
            1,
            BINARY_FRAME_DATA,
            b"partial",
        )))
        .await;
        tokio::time::timeout(Duration::from_secs(5), async {
            while std::fs::read_dir(server.workspace.path()).unwrap().count() < 2 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let peer = if disconnect {
            peer.disconnect().await;
            None
        } else {
            peer.cancel(&id).await;
            Some(peer)
        };
        tokio::time::timeout(Duration::from_secs(5), async {
            while std::fs::read_dir(server.workspace.path()).unwrap().count() != 1 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("Incomplete upload was not cleaned up");
        assert_eq!(tokio::fs::read(&path).await.unwrap(), b"original");
        if let Some(peer) = peer {
            peer.disconnect().await;
        }
    }
    server.stop().await;
}

#[cfg(unix)]
#[tokio::test]
async fn named_shell_survives_reconnect_and_explicit_cancel_stops_its_process_tree() {
    let server = Server::start().await;
    let mut peer = Peer::connect(server.address).await;
    let session_id = uuid::Uuid::new_v4().to_string();
    let command = "sh -c 'trap \"\" TERM; echo $$ > child.pid; exec sleep 60' & wait";
    let (started, _) = peer
        .call(
            "shell.exec",
            json!({ "sessionId": session_id, "start": true, "input": command }),
            None,
        )
        .await;
    assert!(started.ok);
    assert_eq!(started.data.unwrap()["sessionId"], session_id);
    peer.exec_status(&session_id, "started").await;
    let pid_file = server.workspace.path().join("child.pid");
    tokio::time::timeout(Duration::from_secs(10), async {
        while !pid_file.exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let pid: i32 = tokio::fs::read_to_string(pid_file)
        .await
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    peer.disconnect().await;
    let mut peer = Peer::connect(server.address).await;
    let (polled, _) = peer
        .call(
            "shell.exec",
            json!({ "sessionId": session_id, "input": "", "yieldMs": 10 }),
            None,
        )
        .await;
    assert_eq!(polled.data.unwrap()["status"], "running");
    let poll = RequestFrame::new(
        "shell.exec",
        Some(json!({ "sessionId": session_id, "input": "", "yieldMs": 30_000 })),
    );
    let poll_id = poll.id.clone();
    peer.frame(Frame::Req(poll)).await;
    peer.cancel(&poll_id).await;
    let (duplicate, _) = peer
        .call(
            "shell.exec",
            json!({ "sessionId": session_id, "start": true, "input": "echo forbidden" }),
            None,
        )
        .await;
    assert!(!duplicate.ok);
    let (cancelled, _) = peer
        .call("shell.cancel", json!({ "sessionId": session_id }), None)
        .await;
    assert!(cancelled.ok);
    assert_eq!(cancelled.data.unwrap()["cancelled"], true);
    peer.exec_status(&session_id, "failed").await;
    peer.disconnect().await;
    let mut peer = Peer::connect(server.address).await;
    let (terminal, _) = peer
        .call(
            "shell.exec",
            json!({ "sessionId": session_id, "input": "" }),
            None,
        )
        .await;
    assert_eq!(terminal.data.unwrap()["status"], "failed");
    tokio::time::timeout(Duration::from_secs(3), async {
        // SAFETY: signal zero only checks whether this test's child still exists.
        while unsafe { libc::kill(pid, 0) } == 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("The detached session's child survived cancellation");
    peer.disconnect().await;
    server.stop().await;
}

#[cfg(unix)]
#[tokio::test]
async fn request_cancel_stops_foreground_work_and_keeps_the_connection_usable() {
    let server = Server::start().await;
    let mut peer = Peer::connect(server.address).await;
    let request = RequestFrame::new(
        "shell.exec",
        Some(json!({
            "input": "sh -c 'trap \"\" TERM; echo $$ > foreground.pid; exec sleep 60' & wait",
            "yieldMs": 30_000,
        })),
    );
    let id = request.id.clone();
    peer.frame(Frame::Req(request)).await;
    let pid_file = server.workspace.path().join("foreground.pid");
    tokio::time::timeout(Duration::from_secs(10), async {
        while !pid_file.exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let pid: i32 = tokio::fs::read_to_string(pid_file)
        .await
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    peer.cancel(&id).await;
    let (next, _) = peer
        .call(
            "shell.exec",
            json!({ "input": "printf still-available", "yieldMs": 1000 }),
            None,
        )
        .await;
    assert_eq!(next.data.unwrap()["output"], "still-available");
    tokio::time::timeout(Duration::from_secs(3), async {
        // SAFETY: signal zero only checks whether this test's child still exists.
        while unsafe { libc::kill(pid, 0) } == 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("The foreground child survived request.cancel");
    peer.disconnect().await;
    server.stop().await;
}

#[cfg(unix)]
#[tokio::test]
async fn shell_completion_while_disconnected_is_sent_on_reconnect() {
    let server = Server::start().await;
    let mut peer = Peer::connect(server.address).await;
    let session_id = uuid::Uuid::new_v4().to_string();
    let (started, _) = peer
        .call(
            "shell.exec",
            json!({
                "sessionId": session_id, "start": true,
                "input": "while [ ! -f finish ]; do sleep 0.01; done; printf completed",
            }),
            None,
        )
        .await;
    assert!(started.ok);
    peer.exec_status(&session_id, "started").await;
    peer.disconnect().await;
    tokio::fs::write(server.workspace.path().join("finish"), b"")
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    let mut peer = Peer::connect(server.address).await;
    let event = peer.exec_status(&session_id, "finished").await;
    assert_eq!(event["exitCode"], 0);
    let (polled, _) = peer
        .call(
            "shell.exec",
            json!({ "sessionId": session_id, "input": "" }),
            None,
        )
        .await;
    assert_eq!(polled.data.as_ref().unwrap()["status"], "completed");
    assert_eq!(polled.data.unwrap()["output"], "completed");
    peer.disconnect().await;
    server.stop().await;
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn container_cli_ignores_enrollment_and_exits_cleanly_on_sigterm() {
    let directory = tempfile::tempdir().unwrap();
    let gateway = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let mut config = host_config::CliConfig::default();
    config.device.id = Some("unrelated-enrolled-machine".to_string());
    config.device.gateway_url = Some(format!("ws://{}/ws", gateway.local_addr().unwrap()));
    config.device.token = Some("unrelated-enrollment-credential".to_string());
    let config_path = directory.path().join("config/gsv/config.toml");
    host_config::ConfigFile::new(config_path.clone())
        .save(&config)
        .unwrap();
    let before = tokio::fs::read(&config_path).await.unwrap();
    let reservation = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let address = reservation.local_addr().unwrap();
    drop(reservation);
    let mut daemon = tokio::process::Command::new(env!("CARGO_BIN_EXE_gsvd"))
        .args([
            "--container",
            "--listen",
            &address.to_string(),
            "--id",
            "cloud-from-cli",
            "--workspace",
        ])
        .arg(directory.path())
        .env("GSV_INSTANCE_SECRET", SECRET)
        .env("XDG_CONFIG_HOME", directory.path().join("config"))
        .env("XDG_RUNTIME_DIR", directory.path())
        .env_remove("GSV_URL")
        .env_remove("GSV_USER")
        .env_remove("GSV_TOKEN")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let client = reqwest::Client::new();
    let health: Value = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            assert!(
                daemon.try_wait().unwrap().is_none(),
                "Container daemon exited during startup"
            );
            if let Ok(response) = client
                .get(format!("http://{address}/health"))
                .bearer_auth(SECRET)
                .send()
                .await
            {
                assert_eq!(response.status(), 200);
                break serde_json::from_slice(&response.bytes().await.unwrap()).unwrap();
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(health["targetId"], "cloud-from-cli");
    let mut peer = Peer::connect(address).await;
    let (response, _) = peer
        .call(
            "shell.exec",
            json!({ "input": "printf private-instance", "yieldMs": 1000 }),
            None,
        )
        .await;
    assert_eq!(response.data.unwrap()["output"], "private-instance");
    peer.disconnect().await;
    assert!(
        tokio::time::timeout(Duration::from_millis(100), gateway.accept())
            .await
            .is_err()
    );
    assert_eq!(tokio::fs::read(&config_path).await.unwrap(), before);
    // SAFETY: geteuid has no preconditions and signal targets our test-owned daemon.
    let uid = unsafe { libc::geteuid() };
    assert!(!directory
        .path()
        .join(format!("gsv-{uid}/daemon-control-v1.sock"))
        .exists());
    // SAFETY: this PID belongs to the child retained above and has not been reaped.
    let signalled = unsafe { libc::kill(daemon.id().unwrap() as i32, libc::SIGTERM) };
    assert_eq!(signalled, 0);
    assert!(tokio::time::timeout(Duration::from_secs(5), daemon.wait())
        .await
        .unwrap()
        .unwrap()
        .success());
    assert!(TcpStream::connect(address).await.is_err());
}
