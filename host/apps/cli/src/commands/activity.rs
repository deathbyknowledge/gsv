//! `gsv activity`: what ran, where and how it went, newest first. This is
//! the syscall ledger the web app shows; arguments stay out of the table.

use gsv::kernel_client::GatewayAuth;
use serde_json::{json, Value};

use crate::remote::{self, call, items, number, opt_text, text, DynError, Output};
use crate::render::{self, Cell, Table, Tone};

fn outcome(line: &Value) -> Cell {
    match opt_text(line, "outcome") {
        Some("ok") => Cell::new("✓", Tone::Good),
        Some("failed") => Cell::new("failed", Tone::Bad),
        Some("denied") => Cell::new("blocked", Tone::Warn),
        Some("cancelled") => Cell::new("stopped", Tone::Dim),
        _ => Cell::new("running", Tone::Accent),
    }
}

fn duration(line: &Value) -> String {
    match number(line, "durationMs") {
        Some(ms) if ms < 1000 => format!("{ms} ms"),
        Some(ms) if ms < 60_000 => format!("{:.1} s", ms as f64 / 1000.0),
        Some(ms) => format!("{} min", ms / 60_000),
        None => String::new(),
    }
}

pub(crate) async fn run(
    url: &str,
    auth: GatewayAuth,
    on: Option<String>,
    limit: u32,
    out: Output,
) -> Result<(), DynError> {
    let client = remote::connect(url, auth).await?;
    let mut args = json!({ "limit": limit.clamp(1, 200) });
    if let Some(place) = on.as_deref() {
        let target = remote::target_for(&client, Some(place)).await?;
        args["target"] = json!(target.unwrap_or_else(|| "gsv".to_string()));
    }
    let result = call(&client, "sys.ledger.list", args).await?;
    if out.json {
        return render::print_json(&result);
    }
    let style = out.style;
    let lines = items(&result, "lines");
    if lines.is_empty() {
        print!("{}", render::empty(&style, "Nothing has run yet.", None));
        return Ok(());
    }
    let now = render::now_ms();
    let mut table = Table::new(&["When", "Who", "Where", "What", "", "Took"])
        .flex(3)
        .limit(1, 14)
        .limit(2, 18);
    for line in lines {
        let who = match (text(line, "principalKind"), opt_text(line, "pid")) {
            (_, Some(pid)) => format!("work {}", render::short_id(pid)),
            ("human", None) => "you".to_string(),
            (kind, None) => kind.to_string(),
        };
        let call_name = text(line, "call");
        let did = super::activity_labels::label(call_name).unwrap_or(call_name);
        let what = match opt_text(line, "purpose") {
            Some(purpose) => format!("{did} — {}", render::one_line(purpose)),
            None => did.to_string(),
        };
        table.row(vec![
            Cell::new(
                number(line, "timestamp")
                    .map(|at| render::relative_time(at, now))
                    .unwrap_or_default(),
                Tone::Dim,
            ),
            who.into(),
            text(line, "target").into(),
            what.into(),
            outcome(line),
            Cell::new(duration(line), Tone::Dim),
        ]);
    }
    print!(
        "{}",
        render::heading(&style, "Activity", Some("newest first"))
    );
    print!("{}", table.render(&style));
    if opt_text(&result, "nextCursor").is_some() {
        print!(
            "{}",
            render::hint(
                &style,
                &format!("More: gsv activity -n {}", (limit * 2).min(200))
            )
        );
    }
    Ok(())
}
