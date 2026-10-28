//! `gsv places`: the computers, browsers and services connected to your
//! Ship, which `--on` and `PLACE:PATH` name.

use gsv::kernel_client::GatewayAuth;
use serde_json::{json, Value};

use crate::cli::PlacesAction;
use crate::remote::{self, call, items, number, opt_text, text, DynError, Output};
use crate::render::{self, Cell, Table, Tone};

fn kind(target: &Value) -> &'static str {
    if target
        .get("instance")
        .is_some_and(|instance| !instance.is_null())
    {
        return "cloud";
    }
    match text(target, "platform") {
        "darwin" | "macos" => "Mac",
        "linux" => "Linux",
        "windows" | "win32" => "Windows",
        "browser" | "chrome" | "extension" => "browser",
        _ => "place",
    }
}

pub(crate) async fn run(
    url: &str,
    auth: GatewayAuth,
    action: Option<PlacesAction>,
    out: Output,
) -> Result<(), DynError> {
    let client = remote::connect(url, auth).await?;
    let listing = remote::list_places(&client, true).await?;
    let targets = items(&listing, "targets");
    let style = out.style;
    match action {
        None => {
            if out.json {
                return render::print_json(&listing);
            }
            if targets.is_empty() {
                print!(
                    "{}",
                    render::empty(
                        &style,
                        "Only your Ship so far.",
                        Some("Connect a computer: open Work in the web app, click connect, then run gsv pair CODE on it")
                    )
                );
                return Ok(());
            }
            let now = render::now_ms();
            let mut targets: Vec<&Value> = targets.iter().collect();
            targets.sort_by_key(|target| {
                (
                    !remote::flag(target, "online"),
                    text(target, "label").to_lowercase(),
                )
            });
            let mut table = Table::new(&["Name", "Kind", "Status", "Id"]).flex(0);
            for target in &targets {
                let status = if remote::flag(target, "online") {
                    Cell::new("online", Tone::Good)
                } else {
                    Cell::new(
                        number(target, "lastSeenAt")
                            .map(|at| format!("seen {}", render::relative_time(at, now)))
                            .unwrap_or_else(|| "offline".to_string()),
                        Tone::Dim,
                    )
                };
                table.row(vec![
                    Cell::new(
                        opt_text(target, "label").unwrap_or(text(target, "targetId")),
                        Tone::Strong,
                    ),
                    kind(target).into(),
                    status,
                    Cell::new(text(target, "targetId"), Tone::Dim),
                ]);
            }
            let online = targets
                .iter()
                .filter(|target| remote::flag(target, "online"))
                .count();
            print!(
                "{}",
                render::heading(
                    &style,
                    "Places",
                    Some(&format!("{online} of {} online", targets.len()))
                )
            );
            print!("{}", table.render(&style));
            print!(
                "{}",
                render::hint(
                    &style,
                    "Use one: gsv run --on NAME COMMAND · gsv files ls NAME:~"
                )
            );
            Ok(())
        }
        Some(PlacesAction::Rename { place, name }) => {
            let id = remote::resolve_place(targets, &place)?;
            if id == "gsv" {
                return Err("Your Ship's own name is its address; it can't be renamed here".into());
            }
            let result = call(
                &client,
                "sys.target.update",
                json!({ "targetId": id, "label": name.trim() }),
            )
            .await?;
            if out.json {
                return render::print_json(&result);
            }
            println!("Renamed {place} to {}.", style.strong(name.trim()));
            Ok(())
        }
        Some(PlacesAction::Forget { place, yes }) => {
            let id = remote::resolve_place(targets, &place)?;
            if id == "gsv" {
                return Err("Your Ship can't forget itself".into());
            }
            // Forgetting a cloud browser or computer stops it instead.
            let cloud = targets
                .iter()
                .find(|target| text(target, "targetId") == id)
                .is_some_and(|target| kind(target) == "cloud");
            let question = if cloud {
                format!("Stop {place}?")
            } else {
                format!("Forget {place}? It loses access until it is paired again.")
            };
            if !yes && !remote::confirm(&question)? {
                println!("Nothing changed.");
                return Ok(());
            }
            let result = call(&client, "sys.target.delete", json!({ "targetId": id })).await?;
            if out.json {
                return render::print_json(&result);
            }
            if cloud {
                println!("Stopping {place}.");
            } else {
                println!("Forgot {place}. Its access is revoked.");
            }
            Ok(())
        }
    }
}
