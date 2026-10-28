#![cfg(target_os = "linux")]
//! The real CLI against a fake Ship: each test answers syscalls with fixed
//! data, then checks what the CLI asked for and what it printed.

use futures_util::{SinkExt, StreamExt};
use host_config::{CliConfig, ConfigFile};
use serde_json::{json, Value};
use std::process::{Output, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::AsyncWriteExt;
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
                    let mut data = if call == "sys.connect" {
                        connect_result()
                    } else {
                        recorded
                            .lock()
                            .expect("calls")
                            .push((call.clone(), args.clone()));
                        answer(&call, &args)
                    };
                    // An answer may carry signals to push after its response.
                    let signals = data
                        .as_object_mut()
                        .and_then(|object| object.remove("__signals"))
                        .unwrap_or_default();
                    let response =
                        json!({ "type": "res", "id": request["id"], "ok": true, "data": data });
                    let frames = std::iter::once(response).chain(
                        signals
                            .as_array()
                            .into_iter()
                            .flatten()
                            .enumerate()
                            .map(|(seq, signal)| {
                                json!({ "type": "sig", "signal": signal["signal"], "payload": signal["payload"], "seq": seq + 1 })
                            }),
                    );
                    for frame in frames {
                        if socket.send(Message::Text(frame.to_string())).await.is_err() {
                            return;
                        }
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
        self.run_with_columns(args, 100).await
    }

    async fn run_with_columns(&self, args: &[&str], columns: usize) -> Output {
        let child = Command::new(env!("CARGO_BIN_EXE_gsv"))
            .args(args)
            .env("HOME", self.directory.path())
            .env("XDG_CONFIG_HOME", self.directory.path().join("config"))
            .env("NO_COLOR", "1")
            .env("COLUMNS", columns.to_string())
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

    /// Runs the CLI with a terminal for stdout and stderr, through util-linux
    /// `script`, and returns what the terminal showed. `None` when `script`
    /// isn't installed.
    async fn run_in_terminal(&self, args: &[&str]) -> Option<String> {
        self.type_in_terminal(args, "").await
    }

    /// Like `run_in_terminal`, typing `input` into the terminal as it starts.
    async fn type_in_terminal(&self, args: &[&str], input: &str) -> Option<String> {
        let quoted: Vec<String> = std::iter::once(env!("CARGO_BIN_EXE_gsv"))
            .chain(args.iter().copied())
            .map(|arg| format!("'{}'", arg.replace('\'', r"'\''")))
            .collect();
        let child = Command::new("script")
            .args(["-qfec", &quoted.join(" "), "/dev/null"])
            .env("HOME", self.directory.path())
            .env("XDG_CONFIG_HOME", self.directory.path().join("config"))
            .env("NO_COLOR", "1")
            .env("COLUMNS", "100")
            .env("TERM", "xterm-256color")
            .env_remove("GSV_URL")
            .env_remove("GSV_TOKEN")
            .env_remove("GSV_USER")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .ok()?;
        let mut child = child;
        if let Some(mut stdin) = child.stdin.take() {
            // One line at a time, as a person types, so each reaches the prompt it answers.
            for line in input.split_inclusive('\n') {
                tokio::time::sleep(Duration::from_millis(300)).await;
                stdin
                    .write_all(line.as_bytes())
                    .await
                    .expect("type into the terminal");
            }
        }
        let output = tokio::time::timeout(Duration::from_secs(20), child.wait_with_output())
            .await
            .expect("bounded command")
            .expect("terminal result");
        Some(String::from_utf8_lossy(&output.stdout).replace("\r\n", "\n"))
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

fn show_text(title: &str, text: &str) {
    eprintln!("--- {title}\n{text}");
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
    assert!(text.contains("Older: gsv mail --page 2"));

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
    let output = cli.run(&["auth", "link", "ABC123"]).await;
    assert_eq!(output.status.code(), Some(1));
    assert!(stderr(&output).contains("Settings → Messengers"));
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

fn two_pieces_of_work() -> Value {
    json!({ "processes": [
        { "pid": "proc:5c1d77e2-aaaa", "uid": 1000, "username": "sam", "interactive": true, "personal": true,
          "parentPid": null, "state": "idle", "activeRunId": null, "queuedCount": 0,
          "lastActiveAt": 0, "label": null, "createdAt": 0, "cwd": "/home/sam" },
        { "pid": "proc:8f3a2c41-bbbb", "uid": 1000, "username": "crew", "interactive": false, "personal": false,
          "parentPid": null, "state": "idle", "activeRunId": null, "queuedCount": 0,
          "lastActiveAt": 0, "label": "Compare flights to Lisbon", "createdAt": 0, "cwd": "/home/crew" }
    ]})
}

#[tokio::test]
async fn work_reset_and_end_name_the_work_and_report_what_was_archived() {
    fn answer(call: &str, args: &Value) -> Value {
        match call {
            "proc.list" => two_pieces_of_work(),
            "proc.reset" | "proc.kill" => json!({
                "ok": true, "pid": args["pid"], "archivedMessages": 42, "archives": []
            }),
            _ => json!({}),
        }
    }
    let (url, calls) = ship(answer).await;
    let cli = Cli::signed_in(&url);
    let output = cli.run(&["work", "reset", "8f3a", "--yes"]).await;
    show("gsv work reset 8f3a --yes", &output);
    assert!(output.status.success(), "{}", stderr(&output));
    assert_eq!(
        stdout(&output),
        "Reset \"Compare flights to Lisbon\".\nArchived 42 messages.\n"
    );
    assert_eq!(called(&calls, "proc.reset")[0]["pid"], "proc:8f3a2c41-bbbb");

    let output = cli.run(&["work", "end", "8f3a", "-y"]).await;
    assert!(output.status.success(), "{}", stderr(&output));
    assert!(stdout(&output).starts_with("Ended \"Compare flights to Lisbon\".\n"));
    assert_eq!(called(&calls, "proc.kill")[0]["pid"], "proc:8f3a2c41-bbbb");

    let output = cli.run(&["work", "reset", "5c1d", "--yes", "--json"]).await;
    let printed: Value = serde_json::from_slice(&output.stdout).expect("JSON output");
    assert_eq!(printed["archivedMessages"], 42);
}

#[tokio::test]
async fn work_reset_and_end_refuse_without_a_terminal_or_on_the_ship() {
    fn answer(call: &str, _: &Value) -> Value {
        match call {
            "proc.list" => two_pieces_of_work(),
            _ => json!({ "ok": true }),
        }
    }
    let (url, calls) = ship(answer).await;
    let cli = Cli::signed_in(&url);
    for action in ["reset", "end"] {
        let output = cli.run(&["work", action, "8f3a"]).await;
        assert_eq!(output.status.code(), Some(1));
        assert_eq!(
            stderr(&output),
            "Error: Add --yes to confirm when not running in a terminal.\n"
        );
    }
    let output = cli.run(&["work", "end", "5c1d", "--yes"]).await;
    assert_eq!(output.status.code(), Some(1));
    assert!(stderr(&output).contains("Your Ship can't be ended"));
    assert!(called(&calls, "proc.reset").is_empty());
    assert!(called(&calls, "proc.kill").is_empty());
}

#[tokio::test]
async fn auth_token_still_creates_lists_and_revokes_tokens_for_ci() {
    fn answer(call: &str, args: &Value) -> Value {
        match call {
            "sys.token.create" => json!({ "token": {
                "tokenId": "tok-1", "token": "fixture-secret", "tokenPrefix": "gsv_fix", "uid": 1000,
                "kind": args["kind"], "label": args["label"], "peerId": null, "createdAt": 0, "expiresAt": null
            }}),
            "sys.token.list" => json!({ "tokens": [
                { "tokenId": "tok-1", "uid": 1000, "kind": "service", "label": "CI", "tokenPrefix": "gsv_fix",
                  "peerId": null, "createdAt": 0, "lastUsedAt": null, "expiresAt": null, "revokedAt": null }
            ]}),
            "sys.token.revoke" => json!({ "revoked": true }),
            _ => json!({}),
        }
    }
    let (url, calls) = ship(answer).await;
    let cli = Cli::signed_in(&url);
    let output = cli
        .run(&[
            "auth", "token", "create", "--kind", "service", "--label", "CI", "--json",
        ])
        .await;
    assert!(output.status.success(), "{}", stderr(&output));
    let printed: Value = serde_json::from_slice(&output.stdout).expect("JSON output");
    assert_eq!(printed["token"]["token"], "fixture-secret");
    assert_eq!(called(&calls, "sys.token.create")[0]["kind"], "service");

    let output = cli.run(&["auth", "token", "list"]).await;
    show("gsv auth token list", &output);
    assert!(output.status.success(), "{}", stderr(&output));
    assert!(stdout(&output).contains("tok-1  service  CI     active  never      gsv_fix"));

    let output = cli.run(&["auth", "token", "revoke", "tok-1"]).await;
    assert_eq!(stdout(&output), "Revoked tok-1.\n");
    assert_eq!(called(&calls, "sys.token.revoke")[0]["tokenId"], "tok-1");
}

#[tokio::test]
async fn mail_read_prints_its_own_header_once_then_the_body() {
    fn answer(call: &str, _: &Value) -> Value {
        match call {
            "mail.read" => json!({ "message": {
                "messageId": "mail:7d41c0aa99", "from": "Lena Park <lena@example.com>",
                "to": ["sam@ship.example"], "cc": [], "replyTo": ["billing@example.com"],
                "subject": "Invoice 2214", "receivedAt": 0, "attachments": [],
                "text": "From: Lena Park <lena@example.com>\nTo: sam@ship.example\nReply-To: billing@example.com\nSubject: Invoice 2214\nMessage-ID: <x@example.com>\n\nHi Sam,\n\nThe invoice is attached.\n",
                "truncated": true, "textPath": "/home/sam/mail/7d41/text.txt"
            }}),
            _ => json!({}),
        }
    }
    let (url, _) = ship(answer).await;
    let output = Cli::signed_in(&url)
        .run(&["mail", "read", "mail:7d41c0aa99"])
        .await;
    show("gsv mail read", &output);
    assert!(output.status.success(), "{}", stderr(&output));
    let text = stdout(&output);
    assert_eq!(text.matches("Invoice 2214").count(), 1, "{text}");
    assert!(!text.contains("Message-ID"), "{text}");
    assert!(text.contains("Reply-To  billing@example.com"), "{text}");
    assert!(
        text.contains("\nHi Sam,\n\nThe invoice is attached.\n"),
        "{text}"
    );
    assert!(text.contains("The full text is at /home/sam/mail/7d41/text.txt"));
}

#[tokio::test]
async fn mail_fits_the_width_and_pages_by_number() {
    fn answer(call: &str, args: &Value) -> Value {
        let subject = format!("Your weekly digest: {}", "news ".repeat(40));
        match call {
            "mail.list" => json!({
                "messages": [{ "messageId": "mail:5fde01aa", "receivedAt": now() - HOUR,
                    "from": "\"A newsletter with an unusually long display name\" <news@example.org>",
                    "subject": subject, "attachmentCount": 0 }],
                "next": format!("1792775846198.mail:5fde01aa{}", args["limit"]),
            }),
            _ => json!({}),
        }
    }
    let (url, calls) = ship(answer).await;
    let cli = Cli::signed_in(&url);
    let output = cli.run(&["mail"]).await;
    show("gsv mail (long subject)", &output);
    let text = stdout(&output);
    assert!(
        text.lines().all(|line| line.chars().count() <= 100),
        "{text}"
    );
    assert!(text.contains("A newsletter with an un…  Your weekly digest: news"));
    assert!(text.contains("…  1 h ago"));
    assert!(text.contains("Older: gsv mail --page 2\n"));
    assert!(!text.contains("1792775846198"));

    let output = cli.run(&["mail", "--page", "3", "-n", "5"]).await;
    assert!(output.status.success(), "{}", stderr(&output));
    assert!(stdout(&output).contains("Older: gsv mail --page 4 -n 5"));
    let listed = called(&calls, "mail.list");
    // One call skips the ten newer messages, the next shows the page.
    assert_eq!(listed[1]["limit"], 10);
    assert_eq!(listed[1].get("before"), None);
    assert_eq!(listed[2]["limit"], 5);
    assert_eq!(listed[2]["before"], "1792775846198.mail:5fde01aa10");
}

#[tokio::test]
async fn activity_uses_the_web_apps_words() {
    fn answer(call: &str, _: &Value) -> Value {
        match call {
            "sys.ledger.list" => json!({ "lines": [
                { "timestamp": now() - 5 * MINUTE, "principalKind": "human", "target": "gsv",
                  "call": "shell.exec", "outcome": "ok", "durationMs": 420 },
                { "timestamp": now() - 6 * MINUTE, "principalKind": "human", "target": "gsv",
                  "call": "made.up.call", "outcome": "failed", "durationMs": 1500 }
            ]}),
            _ => json!({}),
        }
    }
    let (url, _) = ship(answer).await;
    let output = Cli::signed_in(&url).run(&["activity"]).await;
    show("gsv activity", &output);
    let text = stdout(&output);
    assert!(
        text.contains("5 min ago  you  gsv    ran a command  ✓"),
        "{text}"
    );
    assert!(text.contains("made.up.call"), "{text}");
}

#[tokio::test]
async fn a_failed_reply_exits_non_zero_with_one_plain_line() {
    fn answer(call: &str, _: &Value) -> Value {
        match call {
            "conversation.ship" => json!({ "conversation": { "id": "conv:ship" } }),
            "conversation.send" => json!({
                "runId": "run:7", "queued": false,
                "__signals": [{ "signal": "proc.run.finished", "payload": {
                    "pid": "proc:5c1d77e2", "runId": "run:7", "status": "error",
                    "error": "Generation failed: Inference reference: 7afee6a6-1b2c-4d5e\nManaged inference is disabled for this installation."
                }}]
            }),
            _ => json!({}),
        }
    }
    let (url, _) = ship(answer).await;
    let output = Cli::signed_in(&url).run(&["ship", "hello"]).await;
    show("gsv ship hello (failed run)", &output);
    assert_eq!(output.status.code(), Some(1));
    assert!(stderr(&output).contains(
        "Your Ship couldn't answer: managed inference is turned off for this Ship. (ref 7afee6a6)\n"
    ));
    assert!(!stderr(&output).contains("Managed inference is disabled"));
}

/// A run that calls two tools, then streams a short Markdown reply.
fn tool_run(call: &str, _: &Value) -> Value {
    let signal = |signal: &str, payload: Value| json!({ "signal": signal, "payload": payload });
    match call {
        "conversation.ship" => json!({ "conversation": { "id": "conv:ship" } }),
        "conversation.send" => json!({
            "runId": "run:8", "queued": false,
            "__signals": [
                signal("proc.run.tool.started", json!({ "runId": "run:8", "callId": "c1",
                    "name": "Shell", "syscall": "shell.exec",
                    "purpose": "Checking your calendar for tomorrow" })),
                signal("proc.run.tool.started", json!({ "runId": "run:8", "callId": "c2",
                    "name": "Read", "syscall": "fs.read" })),
            signal("proc.run.tool.finished", json!({ "runId": "run:8", "callId": "c1", "outcome": "completed" })),
            signal("proc.run.tool.finished", json!({ "runId": "run:8", "callId": "c2", "outcome": "failed" })),
                signal("message.delta", json!({ "runId": "run:8", "delta": "**Two** meet" })),
                signal("message.delta", json!({ "runId": "run:8", "delta": "ings.\n- 9:00 standup" })),
                signal("proc.run.finished", json!({ "runId": "run:8", "status": "ok" })),
            ]
        }),
        _ => json!({}),
    }
}

#[tokio::test]
async fn piped_replies_stay_raw_and_tool_lines_use_the_purpose() {
    let (url, _) = ship(tool_run).await;
    let output = Cli::signed_in(&url)
        .run(&["ship", "what's tomorrow?"])
        .await;
    show("gsv ship (piped)", &output);
    assert!(output.status.success(), "{}", stderr(&output));
    assert_eq!(stdout(&output), "**Two** meetings.\n- 9:00 standup\n");
    let notes = stderr(&output);
    assert!(
        notes.contains("· Checking your calendar for tomorrow\n"),
        "{notes}"
    );
    assert!(notes.contains("· read a file\n"), "{notes}");
    assert!(!notes.contains('\u{1b}'), "no spinner without a terminal");
}

#[tokio::test]
async fn a_terminal_shows_a_spinner_that_never_shares_a_line_with_the_reply() {
    let (url, _) = ship(tool_run).await;
    let Some(screen) = Cli::signed_in(&url)
        .run_in_terminal(&["ship", "what's tomorrow?"])
        .await
    else {
        eprintln!("skipped: util-linux script isn't installed");
        return;
    };
    show_text("gsv ship (terminal)", &screen);
    assert!(screen.contains("Thinking…"), "{screen:?}");
    assert!(
        screen.contains("Checking your calendar for tomorrow…"),
        "{screen:?}"
    );
    assert!(screen.contains("Reading a file…"), "{screen:?}");
    assert!(
        screen.contains("· Checking your calendar for tomorrow\n"),
        "{screen:?}"
    );
    assert!(screen.contains("· read a file (failed)\n"), "{screen:?}");
    // On a terminal the reply is rendered, and the unfinished last line
    // still prints when the run ends.
    assert!(
        screen.contains("Two meetings.\n• 9:00 standup"),
        "{screen:?}"
    );
    assert!(!screen.contains("**"), "{screen:?}");
    // Every spinner frame is erased before anything else is written.
    for after in screen.split('…').skip(1) {
        assert!(after.starts_with("\r\u{1b}[2K"), "{after:?}");
    }
}

#[tokio::test]
async fn files_alone_lists_the_home_folder() {
    fn answer(call: &str, _: &Value) -> Value {
        match call {
            "fs.read" => {
                json!({ "path": "/home/sam", "directories": ["notes"], "files": ["todo.md"] })
            }
            _ => json!({}),
        }
    }
    let (url, calls) = ship(answer).await;
    let output = Cli::signed_in(&url).run(&["files"]).await;
    assert!(output.status.success(), "{}", stderr(&output));
    assert!(stdout(&output).starts_with("/home/sam  1 folder · 1 file\n"));
    assert_eq!(called(&calls, "fs.read")[0]["path"], ".");
}

#[tokio::test]
async fn routines_can_run_once_at_a_time_in_the_ships_zone() {
    fn answer(call: &str, args: &Value) -> Value {
        match call {
            "sys.config.get" => {
                json!({ "entries": [{ "key": "users/1000/locale/timezone", "value": "Europe/Madrid" }] })
            }
            "sched.add" => json!({ "schedule": {
                "id": "sched:9a1b", "name": args["name"], "enabled": true,
                "expression": args["expression"], "target": args["target"]
            }}),
            _ => json!({}),
        }
    }
    let (url, calls) = ship(answer).await;
    let cli = Cli::signed_in(&url);
    let output = cli
        .run(&[
            "routines",
            "add",
            "Pick up the parcel",
            "Remind me",
            "--at",
            "2099-10-29 18:00",
        ])
        .await;
    assert!(output.status.success(), "{}", stderr(&output));
    assert_eq!(
        stdout(&output),
        "Added Pick up the parcel. once · Thu 29 Oct 18:00.\n"
    );
    let added = &called(&calls, "sched.add")[0];
    assert_eq!(added["expression"]["kind"], "at");
    // 18:00 in Madrid on 29 Oct 2099 is 17:00 UTC.
    assert_eq!(added["expression"]["atMs"], 4_096_976_400_000_i64);

    let output = cli
        .run(&[
            "routines",
            "add",
            "Too late",
            "x",
            "--at",
            "2020-01-01 09:00",
        ])
        .await;
    assert_eq!(output.status.code(), Some(1));
    assert!(stderr(&output).contains("has already passed"));
}

#[tokio::test]
async fn mail_read_finds_a_short_id_anywhere_in_the_mailbox() {
    fn answer(call: &str, args: &Value) -> Value {
        match call {
            // The newest pages hold other mail; the Ship resolves the id itself.
            "mail.list" => json!({ "messages": [], "next": null }),
            "mail.read" if args["messageId"] == "mail:7d41c0aa" => json!({ "message": {
                "messageId": "mail:7d41c0aa99", "from": "lena@example.com", "to": ["sam@ship.example"],
                "cc": [], "replyTo": [], "subject": "Old invoice", "receivedAt": 0, "attachments": [],
                "text": "From: lena@example.com\n\nFrom last year.\n"
            }}),
            _ => json!({}),
        }
    }
    let (url, calls) = ship(answer).await;
    let output = Cli::signed_in(&url)
        .run(&["mail", "read", "7d41c0aa"])
        .await;
    show("gsv mail read (old short id)", &output);
    assert!(output.status.success(), "{}", stderr(&output));
    assert!(stdout(&output).contains("From last year."));
    assert!(called(&calls, "mail.list").is_empty());
}

#[tokio::test]
async fn mail_send_json_still_fails_when_the_mail_is_refused() {
    fn answer(call: &str, _: &Value) -> Value {
        match call {
            "mail.send" => {
                json!({ "ok": false, "error": "The address was refused.", "retryable": false })
            }
            _ => json!({}),
        }
    }
    let (url, _) = ship(answer).await;
    let output = Cli::signed_in(&url)
        .run(&["mail", "send", "ana@example.com", "hello", "--json"])
        .await;
    show("gsv mail send --json (refused)", &output);
    assert!(!output.status.success());
    let printed: Value = serde_json::from_slice(&output.stdout).expect("JSON output");
    assert_eq!(printed["ok"], false);
}

#[tokio::test]
async fn a_new_token_prints_whole_on_a_narrow_terminal() {
    fn answer(call: &str, args: &Value) -> Value {
        match call {
            "sys.token.create" => json!({ "token": {
                "tokenId": "tok-1", "token": "gsv_svc_0123456789abcdefghijklmnopqrstuvwxyz0123", "tokenPrefix": "gsv_svc",
                "uid": 1000, "kind": args["kind"], "label": null, "peerId": null, "createdAt": 0, "expiresAt": null
            }}),
            _ => json!({}),
        }
    }
    let (url, _) = ship(answer).await;
    let output = Cli::signed_in(&url)
        .run_with_columns(&["auth", "token", "create", "--kind", "service"], 40)
        .await;
    show("gsv auth token create (40 columns)", &output);
    assert!(output.status.success(), "{}", stderr(&output));
    assert!(stdout(&output).contains("gsv_svc_0123456789abcdefghijklmnopqrstuvwxyz0123"));
}

#[tokio::test]
async fn a_conversation_takes_more_input_and_quit_while_a_reply_runs() {
    fn answer(call: &str, _: &Value) -> Value {
        match call {
            "conversation.ship" => json!({ "conversation": { "id": "conv:ship" } }),
            // The reply never finishes: the run keeps working on a long tool.
            "conversation.send" => json!({ "runId": "run:9", "queued": false }),
            _ => json!({}),
        }
    }
    let (url, calls) = ship(answer).await;
    let Some(screen) = Cli::signed_in(&url)
        .type_in_terminal(
            &["ship"],
            "find my flights\nactually, only Friday's\n/quit\n",
        )
        .await
    else {
        eprintln!("skipped: util-linux script is not installed");
        return;
    };
    show_text("gsv ship (input while a reply runs)", &screen);
    let sent: Vec<Value> = called(&calls, "conversation.send")
        .into_iter()
        .map(|args| args["text"].clone())
        .collect();
    assert_eq!(
        sent,
        vec![json!("find my flights"), json!("actually, only Friday's")]
    );
}

#[tokio::test]
async fn contacts_send_json_still_fails_when_delivery_fails() {
    fn answer(call: &str, _: &Value) -> Value {
        match call {
            "contact.list" => {
                json!({ "contacts": [{ "id": "contact:ana", "remoteName": "Ana", "remoteHandle": "ana", "state": "active" }] })
            }
            "contact.send" => json!({ "state": "failed" }),
            _ => json!({}),
        }
    }
    let (url, _) = ship(answer).await;
    let output = Cli::signed_in(&url)
        .run(&["contacts", "send", "Ana", "hello", "--json"])
        .await;
    show("gsv contacts send --json (failed)", &output);
    assert!(!output.status.success());
    let printed: Value = serde_json::from_slice(&output.stdout).expect("JSON output");
    assert_eq!(printed["state"], "failed");
}

#[tokio::test]
async fn json_output_keeps_the_exit_status_of_a_failed_run_or_revoke() {
    fn answer(call: &str, _: &Value) -> Value {
        match call {
            "sched.list" => {
                json!({ "schedules": [{ "id": "sched:9a1b", "name": "Morning brief", "enabled": true,
                "schedule": { "kind": "every", "everyMs": 86_400_000 }, "createdAtMs": 0 }], "count": 1 })
            }
            "sched.run" => {
                json!({ "results": [{ "status": "error", "error": "The target is offline." }] })
            }
            "sys.token.revoke" => json!({ "revoked": false }),
            _ => json!({}),
        }
    }
    let (url, _) = ship(answer).await;
    let cli = Cli::signed_in(&url);
    let output = cli.run(&["routines", "run", "sched:9a1b", "--json"]).await;
    show("gsv routines run --json (failed)", &output);
    assert!(!output.status.success());
    let printed: Value = serde_json::from_slice(&output.stdout).expect("JSON output");
    assert_eq!(printed["results"][0]["status"], "error");

    let output = cli
        .run(&["auth", "token", "revoke", "tok-gone", "--json"])
        .await;
    show("gsv auth token revoke --json (unknown)", &output);
    assert!(!output.status.success());
    let printed: Value = serde_json::from_slice(&output.stdout).expect("JSON output");
    assert_eq!(printed["revoked"], false);
}

#[tokio::test]
async fn an_approval_shows_the_whole_command_and_every_argument_on_request() {
    fn answer(call: &str, _: &Value) -> Value {
        let command = format!(
            "cd ~/projects && {} && rm -rf ~/projects/old-site",
            "make build ".repeat(12)
        );
        match call {
            "conversation.ship" => json!({ "conversation": { "id": "conv:ship" } }),
            "conversation.send" => json!({
                "runId": "run:10", "queued": false,
                "__signals": [{ "signal": "proc.run.hil.requested", "payload": {
                    "pid": "proc:5c1d77e2", "runId": "run:10", "requestId": "hil:1",
                    "syscall": "shell.exec", "target": "gsv",
                    "args": { "input": command, "cwd": "/home/sam" },
                    "purpose": "Clean up and rebuild the site."
                }}]
            }),
            "proc.hil" => json!({ "ok": true }),
            _ => json!({}),
        }
    }
    let (url, calls) = ship(answer).await;
    let Some(screen) = Cli::signed_in(&url)
        .type_in_terminal(&["ship"], "rebuild the site\nv\nb\n/quit\n")
        .await
    else {
        eprintln!("skipped: util-linux script is not installed");
        return;
    };
    show_text("gsv ship (approval of a long command)", &screen);
    let flat = screen.split_whitespace().collect::<Vec<_>>().join(" ");
    assert!(flat.contains("&& rm -rf ~/projects/old-site"), "{screen}");
    assert!(flat.contains("\"cwd\": \"/home/sam\""), "{screen}");
    assert_eq!(called(&calls, "proc.hil")[0]["decision"], "deny");
}
