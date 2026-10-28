#![cfg(target_os = "linux")]
//! The real CLI against a fake Ship: each test answers syscalls with fixed
//! data, then checks what the CLI asked for and what it printed.

use futures_util::{SinkExt, StreamExt};
use host_config::{CliConfig, ConfigFile};
use serde_json::{json, Value};
use std::process::{Output, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::net::TcpListener;
use tokio::process::Command;
use tokio_tungstenite::tungstenite::Message;

type Calls = Arc<Mutex<Vec<(String, Value)>>>;

const MINUTE: i64 = 60_000;
const HOUR: i64 = 60 * MINUTE;

fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn connect_result() -> Value {
    json!({
        "protocol": 4,
        "server": { "connectionId": "conn", "version": env!("CARGO_PKG_VERSION"), "release": "dev" },
        "peer": {
            "id": "gsv-cli-test",
            "sessionId": "session",
            "principal": {
                "kind": "human",
                "account": { "uid": 1000, "gid": 1000, "gids": [], "username": "sam", "home": "/home/sam", "cwd": "/home/sam" }
            },
            "grant": { "calls": [], "signals": [], "implements": [] }
        }
    })
}

/// Serves any number of connections, answering each call with `answer`.
async fn ship(answer: fn(&str, &Value) -> Value) -> (String, Calls) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("fake Ship");
    let url = format!("ws://{}/ws", listener.local_addr().expect("address"));
    let calls: Calls = Arc::default();
    let recorded = calls.clone();
    tokio::spawn(async move {
        while let Ok((socket, _)) = listener.accept().await {
            let recorded = recorded.clone();
            tokio::spawn(async move {
                let Ok(mut socket) = tokio_tungstenite::accept_async(socket).await else {
                    return;
                };
                while let Some(Ok(message)) = socket.next().await {
                    let Ok(text) = message.to_text() else {
                        continue;
                    };
                    let Ok(request) = serde_json::from_str::<Value>(text) else {
                        continue;
                    };
                    if request["type"] != "req" {
                        continue;
                    }
                    let call = request["call"].as_str().unwrap_or_default().to_string();
                    let args = request["args"].clone();
                    let data = if call == "sys.connect" {
                        connect_result()
                    } else {
                        recorded
                            .lock()
                            .expect("calls")
                            .push((call.clone(), args.clone()));
                        answer(&call, &args)
                    };
                    let response =
                        json!({ "type": "res", "id": request["id"], "ok": true, "data": data });
                    if socket
                        .send(Message::Text(response.to_string()))
                        .await
                        .is_err()
                    {
                        return;
                    }
                }
            });
        }
    });
    (url, calls)
}

struct Cli {
    directory: tempfile::TempDir,
}

impl Cli {
    fn signed_in(url: &str) -> Self {
        let directory = tempfile::tempdir().expect("isolated home");
        ConfigFile::<CliConfig>::new(directory.path().join("config/gsv/config.toml"))
            .update(|config| {
                config.gateway.url = Some(url.to_string());
                config.gateway.username = Some("sam".into());
                config.gateway.session_token = Some("fixture-session".into());
                config.gateway.session_expires_at = Some(now() + 6 * HOUR);
                Ok(())
            })
            .expect("fixture login");
        Self { directory }
    }

    async fn run(&self, args: &[&str]) -> Output {
        let child = Command::new(env!("CARGO_BIN_EXE_gsv"))
            .args(args)
            .env("HOME", self.directory.path())
            .env("XDG_CONFIG_HOME", self.directory.path().join("config"))
            .env("NO_COLOR", "1")
            .env("COLUMNS", "100")
            .env_remove("GSV_URL")
            .env_remove("GSV_TOKEN")
            .env_remove("GSV_USER")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .expect("run the CLI");
        tokio::time::timeout(Duration::from_secs(20), child.wait_with_output())
            .await
            .expect("bounded command")
            .expect("CLI result")
    }
}

fn stdout(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).into_owned()
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

fn called(calls: &Calls, name: &str) -> Vec<Value> {
    calls
        .lock()
        .expect("calls")
        .iter()
        .filter(|(call, _)| call == name)
        .map(|(_, args)| args.clone())
        .collect()
}

fn show(title: &str, output: &Output) {
    eprintln!("--- {title}\n{}{}", stdout(output), stderr(output));
}

#[tokio::test]
async fn work_shows_running_work_and_commitments_in_plain_columns() {
    fn answer(call: &str, _: &Value) -> Value {
        let now = now();
        match call {
            "proc.list" => json!({ "processes": [
                { "pid": "proc:5c1d77e2-aaaa", "uid": 1000, "username": "sam", "interactive": true, "personal": true,
                  "parentPid": null, "state": "idle", "activeRunId": null, "queuedCount": 0,
                  "lastActiveAt": now - 3 * MINUTE, "label": null, "createdAt": now - 900 * HOUR, "cwd": "/home/sam" },
                { "pid": "proc:8f3a2c41-bbbb", "uid": 1000, "username": "crew", "interactive": false, "personal": false,
                  "parentPid": "proc:5c1d77e2-aaaa", "state": "running", "activeRunId": "run:1", "queuedCount": 1,
                  "lastActiveAt": now - 2 * MINUTE, "label": "Compare flights to Lisbon", "createdAt": now - HOUR, "cwd": "/home/crew" },
                { "pid": "proc:0b9e4410-cccc", "uid": 1000, "username": "crew", "interactive": false, "personal": false,
                  "parentPid": null, "state": "idle", "activeRunId": null, "queuedCount": 0,
                  "lastActiveAt": now - 30 * HOUR, "label": "Tidy the photo library", "createdAt": now - 40 * HOUR, "cwd": "/home/crew" }
            ]}),
            "r12y.list" => json!({ "count": 1, "revision": 3, "responsibilities": [
                { "id": "r12y:1", "ownerUid": 1000, "title": "Send Ana the signed lease", "state": "waiting",
                  "priority": "high", "blocker": "waiting for the PDF", "dueAtMs": now + 20 * HOUR,
                  "source": { "kind": "system", "component": "test" }, "assignee": { "kind": "ship" },
                  "revision": 1, "createdAtMs": now, "updatedAtMs": now }
            ]}),
            _ => json!({}),
        }
    }
    let (url, _) = ship(answer).await;
    let output = Cli::signed_in(&url).run(&["work"]).await;
    show("gsv work", &output);
    assert!(output.status.success(), "{}", stderr(&output));
    let text = stdout(&output);
    assert!(
        !text.contains('\u{1b}'),
        "NO_COLOR output has no escape codes"
    );
    assert!(text.starts_with("Work  1 running\n"));
    assert!(text.contains("8f3a2c41  working  2 min ago  Compare flights to Lisbon (+1 queued)"));
    assert!(text.contains("5c1d77e2  idle     3 min ago  Ship"));
    assert!(
        !text.contains("Tidy the photo library"),
        "idle work waits for --all"
    );
    assert!(text.contains("1 more idle: gsv work --all"));
    assert!(text.contains("waiting  in 20 h  Send Ana the signed lease — waiting for the PDF"));
    assert!(!text.contains("proc:"), "full pids stay out of the table");
}

#[tokio::test]
async fn mail_pages_with_a_cursor_and_json_returns_the_whole_result() {
    fn answer(call: &str, args: &Value) -> Value {
        let now = now();
        match call {
            "mail.list" | "mail.search" => json!({
                "messages": [
                    { "messageId": "mail:7d41c0aa99", "receivedAt": now - 2 * HOUR, "sentAt": null,
                      "from": "\"Lena Park\" <lena@example.com>", "subject": "Invoice 2214", "summary": null,
                      "category": "transactional", "requiresAttention": true, "attachmentCount": 1 },
                    { "messageId": "mail:2e9f00bb11", "receivedAt": now - 26 * HOUR, "sentAt": null,
                      "from": "news@example.org", "subject": "This week", "summary": null,
                      "category": "newsletter", "requiresAttention": false, "attachmentCount": 0 }
                ],
                "next": "c2e9f00bb11",
                "echo": args,
            }),
            _ => json!({}),
        }
    }
    let (url, calls) = ship(answer).await;
    let cli = Cli::signed_in(&url);
    let output = cli.run(&["mail"]).await;
    show("gsv mail", &output);
    assert!(output.status.success(), "{}", stderr(&output));
    let text = stdout(&output);
    assert!(text.contains("7d41c0aa  Lena Park         Invoice 2214 [1]  2 h ago"));
    assert!(text.contains("2e9f00bb  news@example.org  This week         yesterday"));
    assert!(text.contains("Older: gsv mail --before c2e9f00bb11"));

    let output = cli.run(&["mail", "search", "invoice", "--json"]).await;
    assert!(output.status.success(), "{}", stderr(&output));
    let printed: Value = serde_json::from_slice(&output.stdout).expect("JSON output");
    assert_eq!(printed["next"], "c2e9f00bb11");
    assert_eq!(called(&calls, "mail.search")[0]["query"], "invoice");

    let output = cli
        .run(&["mail", "--before", "c2e9f00bb11", "-n", "5"])
        .await;
    assert!(output.status.success(), "{}", stderr(&output));
    let listed = called(&calls, "mail.list");
    assert_eq!(listed[1]["before"], "c2e9f00bb11");
    assert_eq!(listed[1]["limit"], 5);
}

#[tokio::test]
async fn run_names_a_place_by_label_and_passes_the_exit_status_through() {
    fn answer(call: &str, _: &Value) -> Value {
        match call {
            "sys.target.list" => json!({ "targets": [
                { "targetId": "device-studio", "ownerUid": 1000, "ownerUsername": "sam", "label": "Laptop",
                  "description": "", "implements": ["shell.exec"], "platform": "linux", "version": "0.7.5",
                  "online": true, "lastSeenAt": 0 }
            ]}),
            "shell.exec" => {
                json!({ "status": "completed", "output": "", "stdout": "Filesystem  Size\n/dev/sda1   1.8T\n", "stderr": "", "exitCode": 3 })
            }
            _ => json!({}),
        }
    }
    let (url, calls) = ship(answer).await;
    let output = Cli::signed_in(&url)
        .run(&["run", "--on", "laptop", "df", "-h"])
        .await;
    assert_eq!(output.status.code(), Some(3), "{}", stderr(&output));
    assert_eq!(stdout(&output), "Filesystem  Size\n/dev/sda1   1.8T\n");
    let exec = &called(&calls, "shell.exec")[0];
    assert_eq!(exec["target"], "device-studio");
    assert_eq!(exec["input"], "df -h");
}

#[tokio::test]
async fn approvals_are_listed_and_answered_by_short_id() {
    fn answer(call: &str, _: &Value) -> Value {
        match call {
            "proc.list" => json!({ "processes": [
                { "pid": "proc:5c1d77e2", "uid": 1000, "username": "sam", "interactive": true, "personal": true,
                  "parentPid": null, "state": "waiting_hil", "activeRunId": "run:9", "queuedCount": 0,
                  "lastActiveAt": 0, "label": null, "createdAt": 0, "cwd": "/home/sam" },
                { "pid": "proc:idle", "uid": 1000, "username": "crew", "interactive": false, "personal": false,
                  "parentPid": null, "state": "idle", "activeRunId": null, "queuedCount": 0,
                  "lastActiveAt": 0, "label": "Idle", "createdAt": 0, "cwd": "/home/crew" }
            ]}),
            "proc.history" => json!({
                "format": 2, "pid": "proc:5c1d77e2", "records": [], "messageCount": 0, "historyRevision": 1,
                "historyGeneration": 1, "historyResetRevision": 0, "reset": false, "hasMore": false,
                "pendingHil": { "pid": "proc:5c1d77e2", "requestId": "3f2a91c0-dddd", "runId": "run:9", "callId": "c",
                    "toolName": "Shell", "syscall": "shell.exec", "target": "device-studio",
                    "args": { "input": "brew upgrade" }, "purpose": "Update the tools you asked about.", "createdAt": now() - 4 * MINUTE }
            }),
            "proc.hil" => {
                json!({ "ok": true, "pid": "proc:5c1d77e2", "requestId": "3f2a91c0-dddd" })
            }
            "sys.target.list" => json!({ "targets": [
                { "targetId": "device-studio", "label": "Studio Mac", "online": true }
            ]}),
            _ => json!({}),
        }
    }
    let (url, calls) = ship(answer).await;
    let cli = Cli::signed_in(&url);
    let output = cli.run(&["approvals"]).await;
    show("gsv approvals", &output);
    assert!(output.status.success(), "{}", stderr(&output));
    assert!(stdout(&output)
        .contains("3f2a91c0  4 min ago  Ship  Run a command on Studio Mac: brew upgrade"));
    assert_eq!(
        called(&calls, "proc.history").len(),
        1,
        "only running processes are read"
    );

    let output = cli.run(&["approvals", "allow", "3f2a", "--always"]).await;
    assert!(output.status.success(), "{}", stderr(&output));
    assert!(stdout(&output).contains("allowed from now on"));
    let answer = &called(&calls, "proc.hil")[0];
    assert_eq!(answer["requestId"], "3f2a91c0-dddd");
    assert_eq!(answer["decision"], "approve");
    assert_eq!(answer["remember"], true);
}

#[tokio::test]
async fn routines_made_here_match_the_web_app() {
    fn answer(call: &str, args: &Value) -> Value {
        match call {
            "sys.config.get" => {
                json!({ "entries": [{ "key": "users/1000/locale/timezone", "value": "Europe/Madrid" }] })
            }
            "sched.add" => json!({ "schedule": {
                "id": "sched:4410", "name": args["name"], "enabled": true, "expression": args["expression"],
                "target": args["target"], "state": { "nextRunAtMs": now() + 9 * HOUR }
            }}),
            _ => json!({}),
        }
    }
    let (url, calls) = ship(answer).await;
    let output = Cli::signed_in(&url)
        .run(&[
            "routines",
            "add",
            "Morning briefing",
            "Plan my day",
            "--daily",
            "08:00",
        ])
        .await;
    assert!(output.status.success(), "{}", stderr(&output));
    assert_eq!(
        stdout(&output),
        "Added Morning briefing. Daily at 08:00.\nFirst run in 9 h.\n"
    );
    let added = &called(&calls, "sched.add")[0];
    assert_eq!(
        added["expression"],
        json!({ "kind": "cron", "expr": "0 8 * * *", "timezone": "Europe/Madrid" })
    );
    assert_eq!(
        added["target"],
        json!({ "kind": "responsibility", "message": "Plan my day" })
    );
}

#[tokio::test]
async fn empty_lists_say_what_to_do_next() {
    fn answer(call: &str, _: &Value) -> Value {
        match call {
            "contact.list" => json!({ "contacts": [] }),
            "sched.list" => json!({ "schedules": [], "count": 0 }),
            _ => json!({}),
        }
    }
    let (url, _) = ship(answer).await;
    let cli = Cli::signed_in(&url);
    let output = cli.run(&["contacts"]).await;
    assert_eq!(
        stdout(&output),
        "No contacts yet.\nInvite someone: gsv contacts invite\n"
    );
    let output = cli.run(&["routines"]).await;
    assert!(stdout(&output).starts_with("No routines yet.\nAdd one: gsv routines add"));
}

#[tokio::test]
async fn removed_commands_point_to_their_replacement_and_plain_gsv_explains_itself() {
    let cli = Cli::signed_in("ws://127.0.0.1:9/ws");
    let output = cli.run(&["shell"]).await;
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(
        stderr(&output),
        "Error: `gsv shell` is now `gsv run`, for example: gsv run ls ~\n"
    );
    let output = cli.run(&["auth", "login"]).await;
    assert!(stderr(&output).contains("`gsv auth login` is now `gsv login`"));
    let output = cli.run(&[]).await;
    assert!(output.status.success());
    assert!(stdout(&output).starts_with("Ship from your terminal.\n"));
}

#[tokio::test]
async fn status_reports_sign_in_pairing_and_versions_without_prompting() {
    let (url, _) = ship(|_, _| json!({})).await;
    let output = Cli::signed_in(&url).run(&["status"]).await;
    show("gsv status", &output);
    assert!(output.status.success(), "{}", stderr(&output));
    let text = stdout(&output);
    assert!(
        text.contains("Signed in      yes, as sam · session ends in 6 h"),
        "{text}"
    );
    assert!(text.contains("This computer  not paired"));
    assert!(text.contains(
        "Connect this computer: open Work in the web app, click connect, then run gsv pair CODE"
    ));
}

#[tokio::test]
async fn a_messenger_link_code_is_still_redeemed() {
    fn answer(call: &str, _: &Value) -> Value {
        match call {
            "sys.link.consume" => json!({ "linked": true, "link": { "adapter": "telegram" } }),
            _ => json!({}),
        }
    }
    let (url, calls) = ship(answer).await;
    let output = Cli::signed_in(&url)
        .run(&["auth", "link", "fixture-link"])
        .await;
    assert!(output.status.success(), "{}", stderr(&output));
    assert_eq!(
        stdout(&output),
        "Linked. Your telegram messages now reach your Ship.\n"
    );
    assert_eq!(
        called(&calls, "sys.link.consume")[0]["code"],
        "fixture-link"
    );
}
