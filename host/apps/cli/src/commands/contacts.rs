//! `gsv contacts`: the people you talk to on other Ships.

use gsv::kernel_client::{GatewayAuth, KernelClient};
use serde_json::{json, Value};

use crate::cli::ContactsAction;
use crate::remote::{self, call, items, number, opt_text, text, DynError, Output};
use crate::render::{self, Cell, Table, Tone};

fn display_name(contact: &Value) -> &str {
    opt_text(contact, "localAlias").unwrap_or_else(|| text(contact, "remoteName"))
}

/// The one contact a name means: its alias, name or handle in any case.
fn find_contact<'a>(contacts: &'a [Value], name: &str) -> Result<&'a Value, DynError> {
    let wanted = name.trim().trim_start_matches('@').to_lowercase();
    let active: Vec<&Value> = contacts
        .iter()
        .filter(|contact| {
            [
                opt_text(contact, "localAlias"),
                opt_text(contact, "remoteName"),
                opt_text(contact, "remoteHandle"),
            ]
            .into_iter()
            .flatten()
            .any(|candidate| candidate.to_lowercase() == wanted)
        })
        .collect();
    match active.as_slice() {
        [one] => Ok(one),
        [] => Err(
            format!("You have no contact called \"{name}\". See them with: gsv contacts").into(),
        ),
        several => Err(format!(
            "\"{name}\" could be {}. Use their handle instead.",
            several
                .iter()
                .map(|contact| opt_text(contact, "remoteHandle")
                    .unwrap_or(display_name(contact))
                    .to_string())
                .collect::<Vec<_>>()
                .join(" or ")
        )
        .into()),
    }
}

async fn contacts(client: &KernelClient) -> Result<Value, DynError> {
    call(client, "contact.list", json!({})).await
}

pub(crate) async fn run(
    url: &str,
    auth: GatewayAuth,
    action: Option<ContactsAction>,
    out: Output,
) -> Result<(), DynError> {
    let client = remote::connect(url, auth).await?;
    let style = out.style;
    let now = render::now_ms();
    match action {
        None => {
            let result = contacts(&client).await?;
            if out.json {
                return render::print_json(&result);
            }
            let list = items(&result, "contacts");
            if list.is_empty() {
                print!(
                    "{}",
                    render::empty(
                        &style,
                        "No contacts yet.",
                        Some("Invite someone: gsv contacts invite")
                    )
                );
                return Ok(());
            }
            let mut table = Table::new(&["Name", "Handle", "Last message", ""])
                .flex(1)
                .limit(0, 24);
            for contact in list {
                let last = [
                    number(contact, "lastReceivedAtMs"),
                    number(contact, "lastDeliveredAtMs"),
                ]
                .into_iter()
                .flatten()
                .max();
                let flags = if remote::flag(contact, "blocked") {
                    Cell::new("blocked", Tone::Bad)
                } else if text(contact, "state") == "revoked" {
                    Cell::new("disconnected", Tone::Dim)
                } else if contact
                    .get("preferences")
                    .is_some_and(|preferences| remote::flag(preferences, "muted"))
                {
                    Cell::new("muted", Tone::Dim)
                } else {
                    "".into()
                };
                table.row(vec![
                    Cell::new(display_name(contact), Tone::Strong),
                    Cell::new(
                        opt_text(contact, "remoteHandle")
                            .map(|handle| format!("@{handle}"))
                            .unwrap_or_default(),
                        Tone::Dim,
                    ),
                    Cell::new(
                        last.map(|at| render::relative_time(at, now))
                            .unwrap_or_else(|| "never".to_string()),
                        Tone::Dim,
                    ),
                    flags,
                ]);
            }
            print!(
                "{}",
                render::heading(&style, "Contacts", Some(&list.len().to_string()))
            );
            print!("{}", table.render(&style));
            Ok(())
        }
        Some(ContactsAction::Inbox) => {
            let inbox = call(&client, "conversation.inbox", json!({ "limit": 30 })).await?;
            if out.json {
                return render::print_json(&inbox);
            }
            let entries = items(&inbox, "entries");
            if entries.is_empty() {
                print!(
                    "{}",
                    render::empty(
                        &style,
                        "No conversations with contacts yet.",
                        Some("Message someone: gsv contacts send NAME \"hi\"")
                    )
                );
                return Ok(());
            }
            let known = contacts(&client).await?;
            let me = remote::me(&client)?.uid as i64;
            let mut table = Table::bare().flex(3).limit(1, 24);
            let mut unread = 0;
            for entry in entries {
                let contact_id = text(entry, "contactId");
                let name = items(&known, "contacts")
                    .iter()
                    .find(|contact| text(contact, "id") == contact_id)
                    .map(display_name)
                    .unwrap_or("Someone");
                let is_unread = remote::flag(entry, "unread");
                unread += usize::from(is_unread);
                let preview = entry.get("preview").filter(|preview| !preview.is_null());
                let (when, line) = match preview {
                    Some(preview) => {
                        let from_me = preview.get("author").is_some_and(|author| {
                            text(author, "kind") != "contact" && number(author, "uid") == Some(me)
                        });
                        let body = text(preview, "text");
                        let body = if body.is_empty() {
                            render::count(
                                usize::try_from(remote::amount(preview, "attachmentCount"))
                                    .unwrap_or(0),
                                "attachment",
                                "attachments",
                            )
                        } else {
                            body.to_string()
                        };
                        (
                            number(preview, "createdAt")
                                .map(|at| render::relative_time(at, now))
                                .unwrap_or_default(),
                            if from_me {
                                format!("You: {body}")
                            } else {
                                body
                            },
                        )
                    }
                    None => (String::new(), String::new()),
                };
                table.row(vec![
                    Cell::new(if is_unread { "●" } else { " " }, Tone::Accent),
                    Cell::new(
                        name,
                        if is_unread {
                            Tone::Strong
                        } else {
                            Tone::Normal
                        },
                    ),
                    Cell::new(when, Tone::Dim),
                    render::one_line(&line).into(),
                ]);
            }
            let note = if unread > 0 {
                format!("{unread} unread")
            } else {
                "all read".to_string()
            };
            print!("{}", render::heading(&style, "Inbox", Some(&note)));
            print!("{}", table.render(&style));
            Ok(())
        }
        Some(ContactsAction::Invite { days }) => {
            let mut args = json!({});
            if let Some(days) = days {
                args["expiresInSeconds"] = json!(u64::from(days.max(1)) * 86_400);
            }
            let invite = call(&client, "contact.invite.create", args).await?;
            if out.json {
                return render::print_json(&invite);
            }
            let expires = number(&invite, "expiresAtMs")
                .map(|at| {
                    format!(
                        " It works once and expires {}.",
                        render::relative_time(at, now)
                    )
                })
                .unwrap_or_default();
            println!("Share this with one person.{}\n", style.dim(&expires));
            match opt_text(&invite, "url") {
                Some(link) => println!("  {}", style.strong(link)),
                None => println!("  {}", style.strong(text(&invite, "code"))),
            }
            println!();
            print!(
                "{}",
                render::hint(
                    &style,
                    "They can open the link, or run: gsv contacts accept CODE"
                )
            );
            Ok(())
        }
        Some(ContactsAction::Accept { code }) => {
            let accepted = call(
                &client,
                "contact.invite.accept",
                json!({ "code": code.trim() }),
            )
            .await?;
            if out.json {
                return render::print_json(&accepted);
            }
            let contact = accepted.get("contact").cloned().unwrap_or(Value::Null);
            println!(
                "You're connected with {}.",
                style.strong(display_name(&contact))
            );
            print!(
                "{}",
                render::hint(
                    &style,
                    &format!(
                        "Say hello: gsv contacts send \"{}\" \"hi\"",
                        display_name(&contact)
                    )
                )
            );
            Ok(())
        }
        Some(ContactsAction::Send { name, message }) => {
            let message = remote::words(&message).ok_or("Write a message after the name")?;
            let known = contacts(&client).await?;
            let contact = find_contact(items(&known, "contacts"), &name)?;
            let sent = call(
                &client,
                "contact.send",
                json!({
                    "contactId": text(contact, "id"),
                    "text": message,
                    "idempotencyKey": uuid::Uuid::new_v4().to_string(),
                }),
            )
            .await?;
            let name = display_name(contact);
            if out.json {
                render::print_json(&sent)?;
                if text(&sent, "state") == "failed" {
                    return Err(format!("Couldn't deliver to {name}. Try again later.").into());
                }
                return Ok(());
            }
            match text(&sent, "state") {
                "delivered" => println!("Sent to {name}."),
                "failed" => {
                    return Err(format!("Couldn't deliver to {name}. Try again later.").into())
                }
                _ => println!("Sending to {name}; it arrives when their Ship is reachable."),
            }
            Ok(())
        }
        Some(ContactsAction::Block { name }) => block(&client, &name, true, out).await,
        Some(ContactsAction::Unblock { name }) => block(&client, &name, false, out).await,
    }
}

async fn block(
    client: &KernelClient,
    name: &str,
    blocked: bool,
    out: Output,
) -> Result<(), DynError> {
    let known = contacts(client).await?;
    let contact = find_contact(items(&known, "contacts"), name)?;
    let did = opt_text(contact, "remoteDid").ok_or("This contact can't be blocked from here")?;
    let result = call(
        client,
        "contact.block.set",
        json!({ "did": did, "blocked": blocked }),
    )
    .await?;
    if out.json {
        return render::print_json(&result);
    }
    let name = display_name(contact);
    if blocked {
        println!("Blocked {name}.");
    } else {
        println!("Unblocked {name}.");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn contacts_are_found_by_alias_name_or_handle() {
        let contacts = vec![
            json!({ "id": "c1", "remoteName": "Ana Ruiz", "remoteHandle": "ana.ship.space", "localAlias": "Mum" }),
            json!({ "id": "c2", "remoteName": "Sam", "remoteHandle": "sam.ship.space" }),
            json!({ "id": "c3", "remoteName": "Sam", "remoteHandle": "sam2.ship.space" }),
        ];
        assert_eq!(
            text(find_contact(&contacts, "mum").expect("alias"), "id"),
            "c1"
        );
        assert_eq!(
            text(
                find_contact(&contacts, "@ana.ship.space").expect("handle"),
                "id"
            ),
            "c1"
        );
        let error = find_contact(&contacts, "sam")
            .expect_err("two Sams")
            .to_string();
        assert!(error.contains("sam.ship.space or sam2.ship.space"));
        find_contact(&contacts, "nobody").expect_err("rejected");
    }
}
