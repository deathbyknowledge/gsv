//! `gsv requests`: message requests from people who aren't contacts yet,
//! and the ones you sent.

use gsv::kernel_client::{GatewayAuth, KernelClient};
use serde_json::{json, Value};

use crate::cli::RequestsAction;
use crate::remote::{self, call, items, number, opt_text, text, DynError, Output};
use crate::render::{self, Cell, Style, Table, Tone};

async fn active(client: &KernelClient, direction: &str) -> Result<Vec<Value>, DynError> {
    let result = call(
        client,
        "approach.list",
        json!({ "direction": direction, "status": "active", "limit": 50 }),
    )
    .await?;
    Ok(items(&result, "approaches").to_vec())
}

fn who(approach: &Value) -> String {
    match opt_text(approach, "peerHandle") {
        Some(handle) => format!("{} @{handle}", text(approach, "displayName")),
        None => text(approach, "displayName").to_string(),
    }
}

fn state_cell(approach: &Value) -> Cell {
    match text(approach, "state") {
        "pending" => Cell::new("waiting", Tone::Warn),
        "accepting" => Cell::new("connecting", Tone::Normal),
        "accepted" => Cell::new("accepted", Tone::Good),
        "declined" => Cell::new("declined", Tone::Dim),
        "withdrawn" => Cell::new("withdrawn", Tone::Dim),
        "expired" => Cell::new("expired", Tone::Dim),
        "blocked" => Cell::new("blocked", Tone::Bad),
        _ => Cell::new("sending", Tone::Dim),
    }
}

fn table(style: &Style, approaches: &[Value], now: i64, with_id: bool) -> String {
    let mut table = if with_id {
        Table::new(&["Id", "Who", "When", "State"]).flex(1)
    } else {
        Table::new(&["Who", "When", "State"]).flex(0)
    };
    for approach in approaches {
        let mut row = Vec::new();
        if with_id {
            row.push(Cell::new(
                render::short_id(text(approach, "id")),
                Tone::Accent,
            ));
        }
        row.push(Cell::new(who(approach), Tone::Strong));
        row.push(Cell::new(
            number(approach, "createdAtMs")
                .map(|at| render::relative_time(at, now))
                .unwrap_or_default(),
            Tone::Dim,
        ));
        row.push(state_cell(approach));
        table.row(row);
    }
    table.render(style)
}

pub(crate) async fn run(
    url: &str,
    auth: GatewayAuth,
    action: Option<RequestsAction>,
    out: Output,
) -> Result<(), DynError> {
    let client = remote::connect(url, auth).await?;
    let incoming = active(&client, "incoming").await?;
    let outgoing = active(&client, "outgoing").await?;
    let style = out.style;
    let Some(action) = action else {
        if out.json {
            return render::print_json(&json!({ "incoming": incoming, "outgoing": outgoing }));
        }
        let now = render::now_ms();
        if incoming.is_empty() && outgoing.is_empty() {
            print!(
                "{}",
                render::empty(
                    &style,
                    "No message requests.",
                    Some("People who aren't your contacts yet can ask to talk; their requests show here.")
                )
            );
            return Ok(());
        }
        if !incoming.is_empty() {
            print!(
                "{}",
                render::heading(
                    &style,
                    "Asking to talk to you",
                    Some(&incoming.len().to_string())
                )
            );
            print!("{}", table(&style, &incoming, now, true));
            print!(
                "{}",
                render::hint(
                    &style,
                    "Answer with: gsv requests accept ID, or gsv requests decline ID"
                )
            );
        }
        if !outgoing.is_empty() {
            if !incoming.is_empty() {
                println!();
            }
            print!(
                "{}",
                render::heading(&style, "You asked", Some(&outgoing.len().to_string()))
            );
            print!("{}", table(&style, &outgoing, now, false));
        }
        return Ok(());
    };

    let (id, accept) = match &action {
        RequestsAction::Accept { id } => (id, true),
        RequestsAction::Decline { id } => (id, false),
    };
    let mut candidates = incoming.clone();
    if !accept {
        candidates.extend(outgoing.iter().cloned());
    }
    let approach = render::match_id(
        &candidates,
        id,
        |approach| text(approach, "id"),
        "message request",
    )?;
    let incoming_request = text(approach, "direction") == "incoming";
    let decision = match (accept, incoming_request) {
        (true, _) => "accept",
        (false, true) => "decline",
        (false, false) => "withdraw",
    };
    let result = call(
        &client,
        "approach.decide",
        json!({
            "approachId": text(approach, "id"),
            "expectedRevision": number(approach, "revision").unwrap_or_default(),
            "decision": decision,
        }),
    )
    .await?;
    if out.json {
        return render::print_json(&result);
    }
    let name = text(approach, "displayName");
    match decision {
        // Acceptance completes once the other Ship answers; until then there is no contact to write to.
        "accept"
            if result
                .get("approach")
                .map(|approach| text(approach, "state"))
                != Some("accepted") =>
        {
            println!("Accepted. Connecting to {name}'s Ship; they appear in gsv contacts once it answers.");
        }
        "accept" => {
            println!("Accepted. {name} is now a contact.");
            print!(
                "{}",
                render::hint(
                    &style,
                    &format!("Reply: gsv contacts send \"{name}\" \"hi\"")
                )
            );
        }
        "decline" => println!("Declined {name}'s request."),
        _ => println!("Withdrew your request to {name}."),
    }
    Ok(())
}
