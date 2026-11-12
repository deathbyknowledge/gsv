//! `gsv mail`: your Ship's mailbox, a page at a time, and sending from its
//! address.

use gsv::kernel_client::{GatewayAuth, KernelClient};
use serde_json::{json, Value};

use crate::cli::{MailAction, MailPage};
use crate::remote::{self, call, items, number, opt_text, text, DynError, Output};
use crate::render::{self, Cell, Style, Table, Tone};

/// Messages fetched per call while skipping to a later page.
const SKIP_BATCH: u64 = 100;

/// Arguments for one page. `mail.list`, `mail.search` and `mail.sent` page
/// with an opaque cursor, so `--page N` stays stateless by walking past the newer messages
/// first; `before` is `None` when there are no messages that old.
async fn page_args(
    client: &KernelClient,
    call_name: &str,
    base: Value,
    page: &MailPage,
) -> Result<Option<Value>, DynError> {
    let limit = page.limit.clamp(1, 100);
    let mut before = page.before.clone();
    let mut skip = u64::from(page.page.saturating_sub(1)) * u64::from(limit);
    while skip > 0 {
        let batch = skip.min(SKIP_BATCH);
        let mut args = base.clone();
        args["limit"] = json!(batch);
        if let Some(before) = &before {
            args["before"] = json!(before);
        }
        let result = call(client, call_name, args).await?;
        match opt_text(&result, "next") {
            Some(next) => before = Some(next.to_string()),
            None => return Ok(None),
        }
        skip -= batch;
    }
    let mut args = base;
    args["limit"] = json!(limit);
    if let Some(before) = before {
        args["before"] = json!(before);
    }
    Ok(Some(args))
}

/// The same command for the next page, with the options that shaped this one.
fn next_page(command: &str, page: &MailPage) -> String {
    let mut next = format!("{command} --page {}", page.page + 1);
    if page.limit != 20 {
        next.push_str(&format!(" -n {}", page.limit));
    }
    next
}

fn sender(message: &Value) -> String {
    let from = text(message, "from");
    // "Ana Ruiz <ana@example.com>" reads as "Ana Ruiz".
    match from.split_once('<') {
        Some((name, _)) if !name.trim().is_empty() => name.trim().trim_matches('"').to_string(),
        _ => from.trim_matches(['<', '>']).to_string(),
    }
}

/// The body of `mail.read`'s text, which starts with its own header block;
/// the CLI prints a header of its own.
fn body(text: &str) -> &str {
    text.split_once("\n\n").map_or(text, |(_, body)| body)
}

fn page_table(style: &Style, messages: &[Value], now: i64) -> String {
    let mut table = Table::new(&["Id", "From", "Subject", "When"])
        .flex(2)
        .limit(1, 24);
    for message in messages {
        let attention = message.get("requiresAttention").and_then(Value::as_bool) == Some(true);
        let mut subject = render::one_line(opt_text(message, "subject").unwrap_or("(no subject)"));
        let attachments = number(message, "attachmentCount").unwrap_or(0);
        if attachments > 0 {
            subject.push_str(&format!(" [{attachments}]"));
        }
        let category = text(message, "category");
        let subject_tone = match category {
            "spam" | "suspicious" => Tone::Dim,
            _ if attention => Tone::Strong,
            _ => Tone::Normal,
        };
        table.row(vec![
            Cell::new(render::short_id(text(message, "messageId")), Tone::Accent),
            Cell::new(
                sender(message),
                if attention {
                    Tone::Strong
                } else {
                    Tone::Normal
                },
            ),
            Cell::new(
                if category == "suspicious" {
                    format!("{subject} (suspicious)")
                } else {
                    subject
                },
                subject_tone,
            ),
            Cell::new(
                number(message, "receivedAt")
                    .map(|at| render::relative_time(at, now))
                    .unwrap_or_default(),
                Tone::Dim,
            ),
        ]);
    }
    table.render(style)
}

fn sent_table(style: &Style, sent: &[Value], now: i64) -> String {
    let mut table = Table::new(&["To", "Subject", "State", "When"])
        .flex(1)
        .limit(0, 40);
    for outbound in sent {
        let (state, tone) = match text(outbound, "state") {
            "accepted" => ("sent".to_string(), Tone::Good),
            "failed" => (
                opt_text(outbound, "errorCode")
                    .map_or_else(|| "failed".to_string(), |code| format!("failed: {code}")),
                Tone::Bad,
            ),
            "unknown" => ("unconfirmed".to_string(), Tone::Warn),
            _ => ("sending".to_string(), Tone::Normal),
        };
        let mut to = text(outbound, "to").to_string();
        if let Some(cc) = opt_text(outbound, "cc") {
            to.push_str(&format!(", cc {cc}"));
        }
        table.row(vec![
            to.into(),
            render::one_line(text(outbound, "subject")).into(),
            Cell::new(state, tone),
            Cell::new(
                number(outbound, "createdAt")
                    .map(|at| render::relative_time(at, now))
                    .unwrap_or_default(),
                Tone::Dim,
            ),
        ]);
    }
    table.render(style)
}

fn print_page(
    out: Output,
    result: &Value,
    title: &str,
    empty: &str,
    more: impl Fn() -> String,
) -> Result<(), DynError> {
    if out.json {
        return render::print_json(result);
    }
    let style = out.style;
    let messages = items(result, "messages");
    if messages.is_empty() {
        print!("{}", render::empty(&style, empty, None));
        return Ok(());
    }
    print!(
        "{}",
        render::heading(
            &style,
            title,
            Some(&render::count(messages.len(), "message", "messages"))
        )
    );
    print!("{}", page_table(&style, messages, render::now_ms()));
    if opt_text(result, "next").is_some() {
        print!("{}", render::hint(&style, &more()));
    }
    print!("{}", render::hint(&style, "Read one: gsv mail read ID"));
    Ok(())
}

/// The message id for what someone typed: the whole id, or the short id a
/// page shows, which the Ship resolves against the whole mailbox.
fn message_id(input: &str) -> String {
    let input = input.trim();
    if input.contains(':') {
        input.to_string()
    } else {
        format!("mail:{input}")
    }
}

pub(crate) async fn run(
    url: &str,
    auth: GatewayAuth,
    page: MailPage,
    action: Option<MailAction>,
    out: Output,
) -> Result<(), DynError> {
    let client = remote::connect(url, auth).await?;
    let style = out.style;
    match action {
        None => {
            let result = match page_args(&client, "mail.list", json!({}), &page).await? {
                Some(args) => call(&client, "mail.list", args).await?,
                None => json!({ "messages": [] }),
            };
            let empty = if page.page > 1 {
                "No mail that old."
            } else {
                "No mail yet."
            };
            print_page(out, &result, "Mail", empty, || {
                format!("Older: {}", next_page("gsv mail", &page))
            })
        }
        Some(MailAction::Search { query, page }) => {
            let query = remote::words(&query).ok_or("Give some words to find")?;
            let base = json!({ "query": query });
            let result = match page_args(&client, "mail.search", base, &page).await? {
                Some(args) => call(&client, "mail.search", args).await?,
                None => json!({ "messages": [] }),
            };
            let quoted = format!("\"{query}\"");
            let command = if query.contains(char::is_whitespace) {
                format!("gsv mail search {quoted}")
            } else {
                format!("gsv mail search {query}")
            };
            print_page(
                out,
                &result,
                &quoted,
                &format!("No mail matches {quoted}."),
                || format!("Older matches: {}", next_page(&command, &page)),
            )
        }
        Some(MailAction::Sent { page }) => {
            let result = match page_args(&client, "mail.sent", json!({}), &page).await? {
                Some(args) => call(&client, "mail.sent", args).await?,
                None => json!({ "outbound": [] }),
            };
            if out.json {
                return render::print_json(&result);
            }
            let sent = items(&result, "outbound");
            if sent.is_empty() {
                let empty = if page.page > 1 {
                    "No sent mail that old."
                } else {
                    "Nothing sent yet."
                };
                print!("{}", render::empty(&style, empty, None));
                return Ok(());
            }
            print!(
                "{}",
                render::heading(
                    &style,
                    "Sent",
                    Some(&render::count(sent.len(), "message", "messages"))
                )
            );
            print!("{}", sent_table(&style, sent, render::now_ms()));
            if opt_text(&result, "next").is_some() {
                let older = format!("Older: {}", next_page("gsv mail sent", &page));
                print!("{}", render::hint(&style, &older));
            }
            Ok(())
        }
        Some(MailAction::Read { id }) => {
            let message_id = message_id(&id);
            let result = call(&client, "mail.read", json!({ "messageId": message_id })).await?;
            if out.json {
                return render::print_json(&result);
            }
            let message = result.get("message").cloned().unwrap_or(Value::Null);
            let list = |key: &str| {
                items(&message, key)
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(", ")
            };
            let mut rows: Vec<(&str, Cell)> = vec![
                ("From", Cell::new(text(&message, "from"), Tone::Strong)),
                ("To", list("to").into()),
            ];
            let cc = list("cc");
            if !cc.is_empty() {
                rows.push(("Cc", cc.into()));
            }
            let reply_to = list("replyTo");
            if !reply_to.is_empty() {
                rows.push(("Reply-To", reply_to.into()));
            }
            rows.push((
                "Date",
                number(&message, "receivedAt")
                    .map(render::local_timestamp)
                    .unwrap_or_default()
                    .into(),
            ));
            rows.push((
                "Subject",
                Cell::new(
                    opt_text(&message, "subject").unwrap_or("(no subject)"),
                    Tone::Strong,
                ),
            ));
            let attachments: Vec<String> = items(&message, "attachments")
                .iter()
                .map(|attachment| {
                    format!(
                        "{} ({})",
                        opt_text(attachment, "filename").unwrap_or("unnamed"),
                        render::human_size(remote::amount(attachment, "size"))
                    )
                })
                .collect();
            if !attachments.is_empty() {
                rows.push(("Attached", attachments.join(", ").into()));
            }
            print!("{}", render::detail(&style, &rows));
            println!();
            println!("{}", body(text(&message, "text")).trim_end());
            if remote::flag(&message, "truncated") {
                println!();
                print!(
                    "{}",
                    render::hint(
                        &style,
                        &format!(
                            "The message is longer. The full text is at {}",
                            text(&message, "textPath")
                        )
                    )
                );
            }
            Ok(())
        }
        Some(MailAction::Send {
            to,
            cc,
            subject,
            message,
        }) => {
            let body = match remote::words(&message) {
                Some(body) => body,
                None => remote::piped_stdin()?.ok_or(
                    "Write the message after the address, or pipe it in: gsv mail send ana@example.com < note.txt",
                )?,
            };
            let recipients = |list: &str| -> Vec<String> {
                list.split(',')
                    .map(str::trim)
                    .filter(|address| !address.is_empty())
                    .map(str::to_owned)
                    .collect()
            };
            let mut args = json!({
                "to": recipients(&to),
                "text": body,
                "deliveryId": uuid::Uuid::new_v4().to_string(),
            });
            let copies: Vec<String> = cc.iter().flat_map(|entry| recipients(entry)).collect();
            if !copies.is_empty() {
                args["cc"] = json!(copies);
            }
            if let Some(subject) = subject {
                args["subject"] = json!(subject);
            }
            let result = client.request_ok("mail.send", Some(args)).await?;
            if out.json {
                render::print_json(&result)?;
            }
            if result.get("ok").and_then(Value::as_bool) == Some(false) {
                let retry = if remote::flag(&result, "retryable") {
                    " Try again in a moment."
                } else {
                    ""
                };
                return Err(format!("{}{retry}", text(&result, "error")).into());
            }
            let from = text(&result, "from");
            let to = match opt_text(&result, "cc") {
                Some(cc) => format!("{}, copying {cc}", text(&result, "to")),
                None => text(&result, "to").to_owned(),
            };
            if out.json {
                if text(&result, "state") == "failed" {
                    return Err(format!("The mail to {to} could not be sent.").into());
                }
                return Ok(());
            }
            match text(&result, "state") {
                "accepted" => println!("Sent from {from} to {to}."),
                "failed" => return Err(format!("The mail to {to} could not be sent.").into()),
                _ => println!("Sending from {from} to {to}."),
            }
            print!(
                "{}",
                render::hint(
                    &style,
                    &format!(
                        "Check delivery: gsv mail status {}",
                        text(&result, "deliveryId")
                    )
                )
            );
            Ok(())
        }
        Some(MailAction::Status { id }) => {
            let result = call(&client, "mail.status", json!({ "deliveryId": id })).await?;
            if out.json {
                return render::print_json(&result);
            }
            let Some(outbound) = result
                .get("outbound")
                .filter(|outbound| outbound.is_object())
            else {
                println!("No sent mail has that delivery id.");
                return Ok(());
            };
            let (state, tone) = match text(outbound, "state") {
                "accepted" => ("delivered to the mail service", Tone::Good),
                "failed" => ("failed", Tone::Bad),
                "unknown" => ("unknown; the mail service didn't confirm", Tone::Warn),
                _ => ("on its way", Tone::Normal),
            };
            let mut rows: Vec<(&str, Cell)> = vec![("To", text(outbound, "to").into())];
            if let Some(cc) = opt_text(outbound, "cc") {
                rows.push(("Cc", cc.into()));
            }
            rows.push(("Subject", text(outbound, "subject").into()));
            rows.push(("State", Cell::new(state, tone)));
            if let Some(code) = opt_text(outbound, "errorCode") {
                rows.push(("Reason", Cell::new(code, Tone::Bad)));
            }
            let when = number(outbound, "completedAt").or_else(|| number(outbound, "createdAt"));
            if let Some(when) = when {
                rows.push(("When", render::relative_time(when, render::now_ms()).into()));
            }
            print!("{}", render::detail(&style, &rows));
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_prints_the_body_without_the_header_block() {
        let text = "From: Ana <a@x>\nTo: me@x\nSubject: Hi\n\nFirst line.\n\nSecond paragraph.\n";
        assert_eq!(body(text), "First line.\n\nSecond paragraph.\n");
        assert_eq!(body("no header"), "no header");
    }

    #[test]
    fn senders_show_the_name_people_recognise() {
        assert_eq!(
            sender(&json!({ "from": "\"Ana Ruiz\" <ana@example.com>" })),
            "Ana Ruiz"
        );
        assert_eq!(
            sender(&json!({ "from": "<billing@example.com>" })),
            "billing@example.com"
        );
        assert_eq!(
            sender(&json!({ "from": "noreply@example.com" })),
            "noreply@example.com"
        );
    }

    #[test]
    fn sent_pages_show_who_got_it_and_why_it_failed() {
        let sent = vec![
            json!({ "to": "mike@example.com", "cc": "bob@example.com", "subject": "Friday",
                    "state": "failed", "errorCode": "recipient_suppressed", "createdAt": 0 }),
            json!({ "to": "mike@example.com", "subject": "Contract", "state": "accepted", "createdAt": 0 }),
        ];
        let rendered = sent_table(&Style::plain(120), &sent, 0);
        let lines: Vec<&str> = rendered.lines().collect();
        assert!(lines[1].contains("cc bob@example.com"));
        assert!(lines[1].contains("failed: recipient_suppressed"));
        assert!(lines[2].contains("Contract"));
        assert!(lines[2].contains("sent"));
    }

    #[test]
    fn mail_pages_mark_attachments_and_attention() {
        let messages = vec![
            json!({ "messageId": "mail:aaaa1111bbbb", "from": "Ana <a@x>", "subject": "Lunch?", "receivedAt": 0,
                    "attachmentCount": 2, "requiresAttention": true, "category": "personal" }),
            json!({ "messageId": "mail:cccc2222dddd", "from": "x@y", "subject": null, "receivedAt": 0,
                    "attachmentCount": 0, "category": "suspicious" }),
        ];
        let rendered = page_table(&Style::plain(80), &messages, 0);
        let lines: Vec<&str> = rendered.lines().collect();
        assert!(lines[1].starts_with("aaaa1111  Ana   Lunch? [2]"));
        assert!(lines[2].contains("(no subject) (suspicious)"));
    }
}
