//! `gsv work`: what your Ship and its helpers are doing, and the open
//! commitments that outlast a run.

use std::collections::HashMap;

use gateway_client::history::{HistoryDirection, HistoryOutcome, HistoryRecordData, ProcHistory};
use gsv::kernel_client::{GatewayAuth, KernelClient};
use serde_json::{json, Value};

use crate::cli::WorkAction;
use crate::remote::{self, call, items, number, opt_text, text, DynError, Output};
use crate::render::{self, Cell, Table, Tone};

fn state_label(state: &str) -> (&'static str, Tone) {
    match state {
        "running" => ("working", Tone::Good),
        "waiting_tool" => ("using a tool", Tone::Good),
        "waiting_hil" => ("needs you", Tone::Warn),
        "queued" => ("queued", Tone::Normal),
        "idle" => ("idle", Tone::Dim),
        _ => ("unknown", Tone::Dim),
    }
}

fn process_name(process: &Value) -> String {
    if remote::flag(process, "personal") {
        return "Ship".to_string();
    }
    opt_text(process, "label")
        .map(str::to_string)
        .unwrap_or_else(|| format!("Work as {}", text(process, "username")))
}

/// The full pid for what someone typed: a whole pid or a short id from
/// `gsv work`.
pub(crate) async fn resolve_pid(client: &KernelClient, input: &str) -> Result<String, DynError> {
    if input.starts_with("proc:") {
        return Ok(input.to_string());
    }
    Ok(text(&find_process(client, input).await?, "pid").to_string())
}

async fn find_process(client: &KernelClient, input: &str) -> Result<Value, DynError> {
    let me = remote::me(client)?.uid;
    let listing = call(client, "proc.list", json!({ "uid": me })).await?;
    render::match_id(
        items(&listing, "processes"),
        input,
        |process| text(process, "pid"),
        "piece of work",
    )
    .cloned()
    .map_err(DynError::from)
}

/// What a confirmation or result calls a piece of work.
fn work_name(process: &Value) -> String {
    if remote::flag(process, "personal") {
        return "your Ship".to_string();
    }
    match opt_text(process, "label") {
        Some(label) => format!("\"{}\"", render::one_line(label)),
        None => render::short_id(text(process, "pid")).to_string(),
    }
}

/// `work reset` and `work end`: both archive the history first, and both
/// ask unless `--yes` was given.
async fn reset_or_end(
    client: &KernelClient,
    id: &str,
    end: bool,
    yes: bool,
    out: Output,
) -> Result<(), DynError> {
    let process = find_process(client, id).await?;
    let name = work_name(&process);
    if end && remote::flag(&process, "personal") {
        return Err(
            "Your Ship can't be ended. Start its conversation fresh with: gsv work reset ID".into(),
        );
    }
    let question = if end {
        format!("End {name}? It stops for good; its history is archived.")
    } else {
        format!("Reset {name}? Its history is archived and it starts fresh.")
    };
    if !yes && !remote::confirm(&question)? {
        println!("Nothing changed.");
        return Ok(());
    }
    let pid = text(&process, "pid");
    let (syscall, done) = if end {
        ("proc.kill", "Ended")
    } else {
        ("proc.reset", "Reset")
    };
    let result = call(client, syscall, json!({ "pid": pid })).await?;
    if out.json {
        return render::print_json(&result);
    }
    println!("{done} {name}.");
    let archived = remote::amount(&result, "archivedMessages");
    if archived > 0 {
        print!(
            "{}",
            render::hint(
                &out.style,
                &format!(
                    "Archived {}.",
                    render::count(
                        usize::try_from(archived).unwrap_or(usize::MAX),
                        "message",
                        "messages"
                    )
                )
            )
        );
    }
    Ok(())
}

pub(crate) async fn run(
    url: &str,
    auth: GatewayAuth,
    action: Option<WorkAction>,
    all: bool,
    out: Output,
) -> Result<(), DynError> {
    let client = remote::connect(url, auth).await?;
    match action {
        None => list(&client, all, out).await,
        Some(WorkAction::Show { id, limit }) => show(&client, &id, limit, out).await,
        Some(WorkAction::Stop { id }) => {
            let pid = resolve_pid(&client, &id).await?;
            let result = call(&client, "proc.abort", json!({ "pid": pid })).await?;
            if out.json {
                return render::print_json(&result);
            }
            if remote::flag(&result, "aborted") {
                println!("Stopped what {} was doing.", render::short_id(&pid));
                if opt_text(&result, "continuedQueuedRunId").is_some() {
                    print!(
                        "{}",
                        render::hint(&out.style, "It moved on to the next queued message.")
                    );
                }
            } else {
                println!("{} wasn't doing anything.", render::short_id(&pid));
            }
            Ok(())
        }
        Some(WorkAction::Reset { id, yes }) => reset_or_end(&client, &id, false, yes, out).await,
        Some(WorkAction::End { id, yes }) => reset_or_end(&client, &id, true, yes, out).await,
        Some(WorkAction::Open { .. }) => {
            Err("`work open` runs through the conversation client".into())
        }
    }
}

async fn list(client: &KernelClient, all: bool, out: Output) -> Result<(), DynError> {
    let me = remote::me(client)?.uid;
    let processes = call(client, "proc.list", json!({ "uid": me })).await?;
    let commitments = call(client, "r12y.list", json!({ "limit": 50 })).await?;
    if out.json {
        return render::print_json(&json!({
            "processes": processes.get("processes"),
            "responsibilities": commitments.get("responsibilities"),
        }));
    }
    let style = out.style;
    let now = render::now_ms();
    let mut entries: Vec<&Value> = items(&processes, "processes").iter().collect();
    entries.sort_by_key(|process| {
        std::cmp::Reverse(number(process, "lastActiveAt").or_else(|| number(process, "createdAt")))
    });
    let idle = entries
        .iter()
        .filter(|process| text(process, "state") == "idle" && !remote::flag(process, "personal"))
        .count();
    let shown: Vec<&&Value> = entries
        .iter()
        .filter(|process| {
            all || text(process, "state") != "idle" || remote::flag(process, "personal")
        })
        .collect();

    let mut table = Table::new(&["Id", "State", "Active", "What"]).flex(3);
    for process in &shown {
        let (state, tone) = state_label(text(process, "state"));
        let queued = number(process, "queuedCount").unwrap_or(0);
        let mut name = process_name(process);
        if queued > 0 {
            name.push_str(&format!(" (+{queued} queued)"));
        }
        table.row(vec![
            Cell::new(render::short_id(text(process, "pid")), Tone::Accent),
            Cell::new(state, tone),
            Cell::new(
                number(process, "lastActiveAt")
                    .or_else(|| number(process, "createdAt"))
                    .map(|at| render::relative_time(at, now))
                    .unwrap_or_default(),
                Tone::Dim,
            ),
            name.into(),
        ]);
    }
    let busy = shown
        .iter()
        .filter(|process| text(process, "state") != "idle")
        .count();
    print!(
        "{}",
        render::heading(
            &style,
            "Work",
            Some(&if busy == 0 {
                "nothing running".to_string()
            } else {
                format!("{busy} running")
            })
        )
    );
    print!("{}", table.render(&style));
    if idle > 0 && !all {
        print!(
            "{}",
            render::hint(&style, &format!("{} more idle: gsv work --all", idle))
        );
    }

    let open = items(&commitments, "responsibilities");
    println!();
    if open.is_empty() {
        print!(
            "{}",
            render::empty(
                &style,
                "No open commitments.",
                Some("When your Ship promises to follow up, it shows here.")
            )
        );
    } else {
        let mut table = Table::new(&["State", "Due", "Commitment"]).flex(2);
        for record in open {
            let (state, tone) = match text(record, "state") {
                "active" => ("in progress", Tone::Good),
                "waiting" => ("waiting", Tone::Warn),
                _ => ("open", Tone::Normal),
            };
            let mut title = text(record, "title").to_string();
            if let Some(blocker) = opt_text(record, "blocker") {
                title.push_str(&format!(" — {blocker}"));
            }
            let priority_tone = match text(record, "priority") {
                "high" | "critical" => Tone::Strong,
                _ => Tone::Normal,
            };
            table.row(vec![
                Cell::new(state, tone),
                Cell::new(
                    number(record, "dueAtMs")
                        .map(|at| render::relative_time(at, now))
                        .unwrap_or_else(|| "—".to_string()),
                    Tone::Dim,
                ),
                Cell::new(title, priority_tone),
            ]);
        }
        print!(
            "{}",
            render::heading(&style, "Open commitments", Some(&open.len().to_string()))
        );
        print!("{}", table.render(&style));
    }
    Ok(())
}

async fn show(client: &KernelClient, id: &str, limit: u32, out: Output) -> Result<(), DynError> {
    let pid = resolve_pid(client, id).await?;
    let payload = call(
        client,
        "proc.history",
        json!({ "pid": pid, "format": 2, "tail": true, "limit": limit.clamp(1, 1000) }),
    )
    .await?;
    if out.json {
        return render::print_json(&payload);
    }
    let history = ProcHistory::decode(payload)?;
    let style = out.style;
    let me = remote::me(client)?.uid;
    let listing = call(client, "proc.list", json!({ "uid": me })).await?;
    let process = items(&listing, "processes")
        .iter()
        .find(|process| text(process, "pid") == pid);
    let (title, note) = match process {
        Some(process) => {
            let (state, _) = state_label(text(process, "state"));
            (
                process_name(process),
                format!("{} · {state}", render::short_id(&pid)),
            )
        }
        None => (render::short_id(&pid), String::new()),
    };
    print!("{}", render::heading(&style, &title, Some(&note)));
    let table = timeline(&history, render::now_ms());
    if table.is_empty() {
        print!(
            "{}",
            render::empty(&style, "Nothing has happened here yet.", None)
        );
    } else {
        print!("{}", table.render(&style));
    }
    if history.has_more_before.unwrap_or(false) {
        print!(
            "{}",
            render::hint(
                &style,
                &format!(
                    "Earlier steps: gsv work show {} -n 200",
                    render::short_id(&pid)
                )
            )
        );
    }
    if let Some(request) = history
        .pending_hil
        .as_ref()
        .filter(|value| value.is_object())
    {
        println!();
        print!("{}", super::approvals::render_request(&style, request));
        print!(
            "{}",
            render::hint(&style, "Answer it in the web app or on your messenger.")
        );
    }
    Ok(())
}

/// One row per step: what was asked, what was said, and each tool call with
/// its outcome folded in when the result arrives.
fn timeline(history: &ProcHistory, now: i64) -> Table {
    let mut table = Table::bare().flex(2);
    let mut rows: Vec<Vec<Cell>> = Vec::new();
    let mut calls: HashMap<String, usize> = HashMap::new();
    for record in &history.records {
        let when = Cell::new(
            render::relative_time(record.created_at as i64, now),
            Tone::Dim,
        );
        match &record.data {
            HistoryRecordData::Message(message) => {
                let (step, tone) = match message.direction {
                    HistoryDirection::In => ("Asked", Tone::Accent),
                    HistoryDirection::Out => ("Said", Tone::Strong),
                };
                rows.push(vec![
                    when,
                    Cell::new(step, tone),
                    message.text.as_str().into(),
                ]);
            }
            HistoryRecordData::Note(note) if !note.text.trim().is_empty() => {
                rows.push(vec![
                    when,
                    Cell::new("Noted", Tone::Dim),
                    note.text.as_str().into(),
                ]);
            }
            HistoryRecordData::Note(_) => {}
            HistoryRecordData::Call(call) => {
                let args = Value::Object(call.args.clone());
                let subject = ["input", "command", "path", "query", "url", "text", "to"]
                    .iter()
                    .find_map(|key| opt_text(&args, key))
                    .unwrap_or_default();
                let place = call
                    .target
                    .as_deref()
                    .filter(|target| *target != "gsv")
                    .map(|target| format!(" on {target}"))
                    .unwrap_or_default();
                calls.insert(call.call_id.clone(), rows.len());
                rows.push(vec![
                    when,
                    Cell::new(format!("… {}", call.tool), Tone::Normal),
                    format!("{subject}{place}").into(),
                ]);
            }
            HistoryRecordData::Result(result) => {
                let mark = match result.outcome {
                    HistoryOutcome::Completed => ("✓", Tone::Good),
                    HistoryOutcome::Failed => ("✗", Tone::Bad),
                    HistoryOutcome::Denied => ("blocked", Tone::Warn),
                    HistoryOutcome::Cancelled => ("stopped", Tone::Dim),
                };
                if let Some(row) = calls
                    .get(&result.call_id)
                    .and_then(|index| rows.get_mut(*index))
                {
                    if let Some(step) = row.get_mut(1) {
                        *step = Cell::new(format!("{} {}", mark.0, result.tool), mark.1);
                    }
                    if let (Some(error), Some(detail)) = (&result.error, row.get_mut(2)) {
                        *detail = Cell::new(
                            format!("{} — {}", detail.text(), error.message),
                            Tone::Normal,
                        );
                    }
                }
            }
            HistoryRecordData::Event(event) => {
                rows.push(vec![
                    when,
                    Cell::new("Notice", Tone::Warn),
                    event.kind.as_str().into(),
                ]);
            }
        }
    }
    for row in rows {
        table.row(row);
    }
    table
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timelines_fold_results_into_their_calls() {
        let history = ProcHistory::decode(json!({
            "format": 2, "pid": "proc:1", "messageCount": 2, "historyRevision": 1,
            "historyGeneration": 1, "historyResetRevision": 0, "reset": false, "hasMore": false,
            "records": [
                {"id":1,"messageId":1,"index":0,"generation":1,"runId":"r","createdAt":1000.0,"source":"typed",
                 "kind":"message","payload":{"direction":"in","text":"Check the disk","media":[],"origin":{}}},
                {"id":2,"messageId":2,"index":0,"generation":1,"runId":"r","createdAt":2000.0,"source":"typed",
                 "kind":"call","payload":{"callId":"c1","tool":"Shell","syscall":"shell.exec","target":"device-laptop","args":{"input":"df -h"}}},
                {"id":3,"messageId":2,"index":1,"generation":1,"runId":"r","createdAt":3000.0,"source":"typed",
                 "kind":"result","payload":{"callId":"c1","tool":"Shell","outcome":"failed","output":"","media":[],"resources":[],"error":{"message":"timed out"}}},
                {"id":4,"messageId":2,"index":2,"generation":1,"runId":"r","createdAt":4000.0,"source":"typed",
                 "kind":"message","payload":{"direction":"out","text":"The laptop didn't answer.","media":[],"origin":{}}}
            ]
        }))
        .expect("history");
        let rendered = timeline(&history, 10_000).render(&render::Style::plain(100));
        let lines: Vec<&str> = rendered.lines().collect();
        assert_eq!(lines.len(), 3);
        assert!(lines[0].ends_with("Asked    Check the disk"));
        assert!(lines[1].ends_with("✗ Shell  df -h on device-laptop — timed out"));
        assert!(lines[2].ends_with("Said     The laptop didn't answer."));
    }
}
