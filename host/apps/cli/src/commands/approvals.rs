//! `gsv approvals`: actions your Ship is waiting for you to allow.
//!
//! There is no list call for pending approvals yet, so the list reads each
//! running process's history for its one pending request. Answering uses
//! `proc.hil`; `--always` remembers the decision as a rule.

use gsv::kernel_client::{GatewayAuth, KernelClient};
use serde_json::{json, Value};

use crate::cli::ApprovalsAction;
use crate::remote::{self, call, items, number, opt_text, text, DynError, Output};
use crate::render::{self, Cell, Style, Table, Tone};

/// A plain sentence for what a pending action does, and its most telling
/// argument, such as the command line or the file path.
pub(crate) fn describe_request(request: &Value) -> (String, Option<String>) {
    let syscall = text(request, "syscall");
    let verb = match syscall {
        "shell.exec" => "Run a command",
        "fs.write" => "Write a file",
        "fs.edit" => "Edit a file",
        "fs.delete" => "Delete a file",
        "fs.copy" => "Copy a file",
        "mail.send" => "Send an email",
        "contact.send" => "Message a contact",
        "codemode.exec" => "Run a script",
        call if call.starts_with("net.") => "Use the internet",
        call if call.starts_with("mcp.") => "Use a connected tool",
        call if call.starts_with("sched.") => "Change a routine",
        "" => "Take an action",
        other => other,
    };
    // The Ship is where actions happen unless another place is named.
    let title = match text(request, "target") {
        "" | "gsv" => verb.to_string(),
        target => format!(
            "{verb} on {}",
            opt_text(request, "targetLabel").unwrap_or(target)
        ),
    };
    let args = request.get("args").cloned().unwrap_or(Value::Null);
    let subject = ["input", "command", "path", "url", "to", "query", "name"]
        .iter()
        .find_map(|key| opt_text(&args, key))
        .map(render::one_line);
    (title, subject)
}

/// The block shown when a request arrives during `gsv ship` and in
/// `gsv approvals`: what, why, and the argument that matters.
pub(crate) fn render_request(style: &Style, request: &Value) -> String {
    let (title, subject) = describe_request(request);
    let mut out = format!(
        "{} {}\n",
        style.paint(Tone::Warn, "Waiting for you:"),
        style.strong(&title)
    );
    if let Some(purpose) = opt_text(request, "purpose") {
        out.push_str(&format!(
            "  {}\n",
            render::truncate(&render::one_line(purpose), style.width().saturating_sub(2))
        ));
    }
    if let Some(subject) = subject {
        out.push_str(&format!(
            "  {}\n",
            style.dim(&render::truncate(&subject, style.width().saturating_sub(2)))
        ));
    }
    out
}

async fn pending(client: &KernelClient) -> Result<Vec<Value>, DynError> {
    let me = remote::me(client)?.uid;
    let listing = call(client, "proc.list", json!({ "uid": me })).await?;
    let mut requests = Vec::new();
    for process in items(&listing, "processes") {
        if opt_text(process, "activeRunId").is_none() {
            continue;
        }
        let pid = text(process, "pid");
        let history = call(
            client,
            "proc.history",
            json!({ "pid": pid, "format": 2, "limit": 1, "tail": true }),
        )
        .await?;
        if let Some(request) = history.get("pendingHil").filter(|value| value.is_object()) {
            let mut request = request.clone();
            request["processLabel"] = process.get("label").cloned().unwrap_or(Value::Null);
            request["personal"] = process.get("personal").cloned().unwrap_or(Value::Null);
            requests.push(request);
        }
    }
    requests.sort_by_key(|request| number(request, "createdAt").unwrap_or_default());
    if requests
        .iter()
        .any(|request| !matches!(text(request, "target"), "" | "gsv"))
    {
        let places = remote::list_places(client, true).await?;
        for request in &mut requests {
            let label = items(&places, "targets")
                .iter()
                .find(|place| text(place, "targetId") == text(request, "target"))
                .and_then(|place| opt_text(place, "label"))
                .map(str::to_string);
            if let Some(label) = label {
                request["targetLabel"] = json!(label);
            }
        }
    }
    Ok(requests)
}

pub(crate) async fn run(
    url: &str,
    auth: GatewayAuth,
    action: Option<ApprovalsAction>,
    out: Output,
) -> Result<(), DynError> {
    let client = remote::connect(url, auth).await?;
    let requests = pending(&client).await?;
    let style = out.style;
    let Some(action) = action else {
        if out.json {
            return render::print_json(&json!({ "approvals": requests }));
        }
        if requests.is_empty() {
            print!(
                "{}",
                render::empty(&style, "Nothing is waiting for you.", None)
            );
            return Ok(());
        }
        let now = render::now_ms();
        let mut table = Table::new(&["Id", "Waiting", "For", "Action"]).flex(3);
        for request in &requests {
            let (title, subject) = describe_request(request);
            let who = if remote::flag(request, "personal") {
                "Ship".to_string()
            } else {
                opt_text(request, "processLabel")
                    .unwrap_or("Work")
                    .to_string()
            };
            let action = match subject {
                Some(subject) => format!("{title}: {subject}"),
                None => title,
            };
            table.row(vec![
                Cell::new(render::short_id(text(request, "requestId")), Tone::Accent),
                Cell::new(
                    number(request, "createdAt")
                        .map(|at| render::relative_time(at, now))
                        .unwrap_or_default(),
                    Tone::Dim,
                ),
                who.into(),
                action.into(),
            ]);
        }
        print!(
            "{}",
            render::heading(
                &style,
                "Waiting for you",
                Some(&render::count(requests.len(), "action", "actions"))
            )
        );
        print!("{}", table.render(&style));
        print!(
            "{}",
            render::hint(
                &style,
                "Answer with: gsv approvals allow ID [--always], or gsv approvals block ID"
            )
        );
        return Ok(());
    };

    let (id, decision, remember) = match &action {
        ApprovalsAction::Allow { id, always } => (id, "approve", *always),
        ApprovalsAction::Block { id } => (id, "deny", false),
    };
    let request = render::match_id(
        &requests,
        id,
        |request| text(request, "requestId"),
        "waiting action",
    )?;
    let result = call(
        &client,
        "proc.hil",
        json!({
            "pid": text(request, "pid"),
            "requestId": text(request, "requestId"),
            "decision": decision,
            "remember": remember,
        }),
    )
    .await?;
    if out.json {
        return render::print_json(&result);
    }
    let (title, _) = describe_request(request);
    let said = match (decision, remember) {
        ("approve", true) => {
            format!("Allowed: {title}. Actions like this are allowed from now on.")
        }
        ("approve", false) => format!("Allowed once: {title}."),
        _ => format!("Blocked: {title}."),
    };
    println!("{said}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requests_read_as_plain_actions() {
        let request = json!({
            "syscall": "shell.exec",
            "target": "device-laptop",
            "args": { "input": "rm -rf build\n  && make" },
            "purpose": "Rebuild the project from scratch."
        });
        assert_eq!(
            describe_request(&request),
            (
                "Run a command on device-laptop".to_string(),
                Some("rm -rf build && make".to_string())
            )
        );
        let rendered = render_request(&Style::plain(80), &request);
        assert_eq!(
            rendered,
            "Waiting for you: Run a command on device-laptop\n  Rebuild the project from scratch.\n  rm -rf build && make\n"
        );
        let mail = json!({ "syscall": "mail.send", "target": "gsv", "args": { "to": "ana@example.com", "text": "private" } });
        let (title, subject) = describe_request(&mail);
        assert_eq!(title, "Send an email");
        assert_eq!(subject.as_deref(), Some("ana@example.com"));
    }
}
