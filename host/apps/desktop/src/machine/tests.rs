use super::*;
use serde_json::json;

fn identity() -> Identity {
    Identity {
        origin: "https://space.example".into(),
        username: "human".into(),
        target_id: "laptop".into(),
        label: "Laptop".into(),
    }
}

fn scope() -> Scope {
    Scope {
        origin: identity().origin,
        username: identity().username,
    }
}

fn snapshot() -> Snapshot {
    Snapshot {
        suggested_name: "Laptop".into(),
        configured: None,
        pending: None,
        running: false,
        connected: false,
    }
}

fn invitation(origin: &str, username: &str) -> String {
    format!(
        "gsv-pair1_{}",
        URL_SAFE_NO_PAD.encode(
            json!({ "version": 1, "gatewayUrl": origin,
        "username": username, "targetId": "laptop", "label": "Laptop", "secret": "fixture-secret" })
            .to_string()
        )
    )
}

#[test]
fn machine_actions_require_the_current_signed_in_session() {
    let mut session = Session {
        generation: "generation".into(),
        origin: Some(scope().origin),
        values: std::collections::BTreeMap::from([(
            "gsv.ui.session.token.v1".into(),
            json!({"username":"human", "token":"private-session"}).to_string(),
        )]),
    };
    super::scope(&session, "generation", "human").expect("current signed-in account");
    assert!(super::scope(&session, "old-generation", "human").is_err());
    assert!(super::scope(&session, "generation", "other").is_err());
    session.values.clear();
    assert!(super::scope(&session, "generation", "human").is_err());
}

#[test]
fn pairing_must_belong_to_the_selected_space_and_account() {
    for (origin, username) in [
        ("https://other.example", "human"),
        ("https://space.example", "other"),
        ("https://user:private@space.example", "human"),
    ] {
        assert!(command_arguments(
            &scope(),
            &snapshot(),
            MachineCommand::Pair {
                code: invitation(origin, username)
            }
        )
        .is_err());
    }
    let code = invitation("wss://space.example/ws", "human");
    let (args, input, expected) = command_arguments(
        &scope(),
        &snapshot(),
        MachineCommand::Pair { code: code.clone() },
    )
    .unwrap();
    assert_eq!(args, ["pair", "-", "--preserve-cli-login", "--no-replace"]);
    assert_eq!(input, Some(code.clone()));
    assert_eq!(expected, identity());
    assert!(args.iter().all(|arg| !arg.contains(&code)));
}

#[test]
fn existing_and_pending_connections_cannot_be_replaced() {
    let mut saved = snapshot();
    saved.configured = Some(identity());
    assert!(command_arguments(
        &scope(),
        &saved,
        MachineCommand::Pair {
            code: invitation("https://space.example", "human")
        }
    )
    .is_err());
    command_arguments(&scope(), &saved, MachineCommand::Start).expect("matching enrollment");
    saved.configured.as_mut().unwrap().username = "other".into();
    assert!(command_arguments(&scope(), &saved, MachineCommand::Start).is_err());
    saved.pending = saved.configured.take();
    assert!(command_arguments(&scope(), &saved, MachineCommand::Resume).is_err());
    saved.pending = Some(identity());
    command_arguments(&scope(), &saved, MachineCommand::Resume)
        .expect("matching pending enrollment");
    assert!(command_arguments(&scope(), &saved, MachineCommand::Start).is_err());
}

#[test]
fn private_config_is_projected_without_credentials() {
    let mut config = CliConfig::default();
    config.device.token = Some("private-driver-token".into());
    config.device.id = Some("laptop".into());
    config.device.gateway_url = Some("wss://space.example/ws".into());
    config.device.gateway_username = Some("human".into());
    let value = serde_json::to_string(&configured_identity(&config).unwrap()).unwrap();
    assert!(!value.contains("private-driver-token"));
    assert!(!value.contains("token"));
    assert!(value.contains("https://space.example"));
    config.device.id = None;
    assert!(configured_identity(&config).is_err());
}

#[tokio::test]
async fn cancellation_is_generation_fenced_and_does_not_block_the_next_operation() {
    let runtime = MachineRuntime::default();
    let operation = runtime.prepare().unwrap();
    assert!(runtime.prepare().is_err());
    runtime.cancel();
    assert!(operation.cancelled.has_changed().unwrap());
    drop(operation);
    let next = runtime.prepare().unwrap();
    assert!(!next.cancelled.has_changed().unwrap());
}

#[tokio::test]
async fn installation_waits_for_the_daemon_to_connect_before_reporting_success() {
    let (_cancel, mut cancelled) = watch::channel(0);
    let mut checks = 0;
    let result = wait_for_connection(&identity(), &mut cancelled, Duration::from_secs(2), || {
        checks += 1;
        std::future::ready(Ok(Snapshot {
            configured: Some(identity()),
            running: checks >= 2,
            connected: checks >= 3,
            ..snapshot()
        }))
    })
    .await
    .unwrap();
    assert!(result.connected);
    assert_eq!(checks, 3);
}

#[tokio::test]
async fn a_service_that_never_connects_is_a_retryable_failure() {
    let (_cancel, mut cancelled) = watch::channel(0);
    for running in [false, true] {
        let error = wait_for_connection(
            &identity(),
            &mut cancelled,
            Duration::from_millis(20),
            || async {
                Ok(Snapshot {
                    configured: Some(identity()),
                    running,
                    ..snapshot()
                })
            },
        )
        .await
        .err()
        .unwrap();
        assert_eq!(error, "This computer did not connect. Retry.");
    }
}

#[tokio::test]
async fn connection_wait_rejects_a_replaced_binding_and_cancels_promptly() {
    let (cancel, mut cancelled) = watch::channel(0);
    let error = wait_for_connection(
        &identity(),
        &mut cancelled,
        Duration::from_secs(2),
        || async {
            Ok(Snapshot {
                configured: Some(Identity {
                    target_id: "other-target".into(),
                    ..identity()
                }),
                running: true,
                connected: true,
                ..snapshot()
            })
        },
    )
    .await
    .err()
    .unwrap();
    assert!(error.contains("changed"));

    let task = tokio::spawn(async move {
        wait_for_connection(
            &identity(),
            &mut cancelled,
            Duration::from_secs(20),
            || async { std::future::pending().await },
        )
        .await
        .err()
        .unwrap()
    });
    tokio::task::yield_now().await;
    cancel.send(1).unwrap();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .unwrap()
            .unwrap(),
        "Machine setup was cancelled."
    );
}

#[cfg(unix)]
fn executable(directory: &Path, body: &str) -> std::path::PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let path = directory.join("gsv");
    std::fs::write(&path, format!("#!/bin/sh\nset -eu\n{body}\n")).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
    path
}

#[cfg(unix)]
#[tokio::test]
async fn invitation_uses_private_stdin_and_the_child_exits_before_completion() {
    let directory = tempfile::tempdir().unwrap();
    let executable = executable(directory.path(), "IFS= read -r invitation || true\n[ \"$invitation\" = fixture-private-invitation ]\n[ \"$*\" = 'pair - --preserve-cli-login --no-replace' ]");
    let (_cancel, mut cancelled) = watch::channel(0);
    run_cli(
        &executable,
        &["pair", "-", "--preserve-cli-login", "--no-replace"],
        Some("fixture-private-invitation"),
        &mut cancelled,
        Duration::from_secs(2),
    )
    .await
    .unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn cancelled_or_timed_out_setup_cannot_keep_running() {
    let directory = tempfile::tempdir().unwrap();
    let executable = executable(directory.path(), "sleep 30");
    let (cancel, mut cancelled) = watch::channel(0);
    cancel.send(1).unwrap();
    assert!(run_cli(
        &executable,
        &[],
        None,
        &mut cancelled,
        Duration::from_secs(2)
    )
    .await
    .unwrap_err()
    .contains("cancelled"));
    let mut cancelled = cancel.subscribe();
    assert!(run_cli(
        &executable,
        &[],
        None,
        &mut cancelled,
        Duration::from_millis(20)
    )
    .await
    .unwrap_err()
    .contains("timed out"));
    let mut cancelled = cancel.subscribe();
    let task = tokio::spawn(async move {
        run_cli(
            &executable,
            &[],
            None,
            &mut cancelled,
            Duration::from_secs(10),
        )
        .await
    });
    tokio::time::sleep(Duration::from_millis(20)).await;
    cancel.send(2).unwrap();
    assert!(tokio::time::timeout(Duration::from_secs(1), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err()
        .contains("cancelled"));
}
