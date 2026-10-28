//! How an action waiting for approval reads, shown when one arrives during
//! `gsv ship` or `gsv work open` and in `gsv work show`. Approvals are
//! answered there, in the web app or on a messenger.

use serde_json::Value;

use crate::remote::{opt_text, text};
use crate::render::{self, Style, Tone};
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

/// The model's one-sentence purpose for the person, on one line, or `None`
/// when it wrote none.
pub(crate) fn purpose(request: &Value) -> Option<String> {
    opt_text(request, "purpose")
        .map(render::one_line)
        .filter(|purpose| !purpose.is_empty())
}

/// The block shown when a request arrives during `gsv ship` and in
/// `gsv work show`: what, why, and the argument that matters, in full.
pub(crate) fn render_request(style: &Style, request: &Value) -> String {
    let (title, subject) = describe_request(request);
    let mut out = format!(
        "{} {}\n",
        style.paint(Tone::Warn, "Waiting for you:"),
        style.strong(&title)
    );
    // Never cut: this is what the person approves, so all of it shows, wrapping as it must.
    if let Some(purpose) = purpose(request) {
        out.push_str(&format!("  {purpose}\n"));
    }
    if let Some(subject) = subject {
        out.push_str(&format!("  {}\n", style.dim(&subject)));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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
