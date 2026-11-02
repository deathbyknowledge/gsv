//! What every remote command shares: one connection, syscall results read as
//! JSON, place names, `PLACE:PATH` arguments and the few prompts commands ask.

use std::io::{self, IsTerminal, Read, Write};
use std::time::Duration;

use gsv::kernel_client::{cli_peer_identity, BinaryBodyLimits, GatewayAuth, KernelClient};
use gsv::protocol::ProcessIdentity;
use serde_json::{json, Value};

use crate::render::Style;

pub(crate) type DynError = Box<dyn std::error::Error>;

const FILE_TIMEOUT: Duration = Duration::from_secs(300);
/// Text a command prints whole; larger files are for `gsv files get`.
pub(crate) const MAX_PRINTED_FILE_BYTES: usize = 16 * 1024 * 1024;

/// How a command prints: the full JSON result, or a rendering for people.
#[derive(Clone, Copy)]
pub(crate) struct Output {
    pub(crate) json: bool,
    pub(crate) style: Style,
}

impl Output {
    pub(crate) fn new(json: bool) -> Self {
        Self {
            json,
            style: Style::stdout(),
        }
    }
}

/// An error that ends the command with this exit status and no message,
/// as `gsv run` does with the remote command's own status.
#[derive(Debug)]
pub(crate) struct Exit(pub(crate) u8);

impl std::fmt::Display for Exit {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "exit status {}", self.0)
    }
}

impl std::error::Error for Exit {}

pub(crate) async fn connect(url: &str, auth: GatewayAuth) -> Result<KernelClient, DynError> {
    KernelClient::connect_with_peer(
        url,
        cli_peer_identity(),
        Vec::new(),
        auth,
        BinaryBodyLimits::default(),
        |_| {},
    )
    .await
}

/// Calls one syscall. A result of `{ ok: false, error }` becomes an error, so
/// callers only see successful payloads.
pub(crate) async fn call(
    client: &KernelClient,
    name: &str,
    args: Value,
) -> Result<Value, DynError> {
    let payload = client.request_ok(name, Some(args)).await?;
    if payload.get("ok").and_then(Value::as_bool) == Some(false) {
        let error = text(&payload, "error");
        return Err(if error.is_empty() {
            format!("{name} was refused").into()
        } else {
            error.into()
        });
    }
    Ok(payload)
}

pub(crate) fn me(client: &KernelClient) -> Result<&ProcessIdentity, DynError> {
    client
        .connection()
        .connect_result
        .as_ref()
        .map(|result| &result.peer.principal.account)
        .ok_or_else(|| "Your Ship did not say who you are signed in as".into())
}

pub(crate) fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or_default()
}

pub(crate) fn opt_text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
}

pub(crate) fn number(value: &Value, key: &str) -> Option<i64> {
    let field = value.get(key)?;
    field
        .as_i64()
        .or_else(|| field.as_f64().map(|float| float as i64))
}

/// A count or size, which is never negative.
pub(crate) fn amount(value: &Value, key: &str) -> u64 {
    number(value, key)
        .and_then(|number| u64::try_from(number).ok())
        .unwrap_or(0)
}

pub(crate) fn flag(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

pub(crate) fn items<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
}

/// Joins words given without quotes into one message.
pub(crate) fn words(parts: &[String]) -> Option<String> {
    let joined = parts.join(" ");
    let trimmed = joined.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

/// Reads all of stdin when it is piped. A terminal is never read.
pub(crate) fn piped_stdin() -> Result<Option<String>, DynError> {
    if io::stdin().is_terminal() {
        return Ok(None);
    }
    let mut input = String::new();
    io::stdin().read_to_string(&mut input)?;
    let trimmed = input.trim();
    Ok((!trimmed.is_empty()).then(|| trimmed.to_string()))
}

/// Asks a yes or no question on a terminal. Without one, the answer must be
/// given up front with `--yes`.
pub(crate) fn confirm(question: &str) -> Result<bool, DynError> {
    if !io::stdin().is_terminal() {
        return Err("Add --yes to confirm when not running in a terminal.".into());
    }
    let style = Style::stderr();
    eprint!("{question} {} ", style.dim("[y/N]"));
    io::stderr().flush()?;
    let mut answer = String::new();
    io::stdin().read_line(&mut answer)?;
    Ok(matches!(
        answer.trim().to_ascii_lowercase().as_str(),
        "y" | "yes"
    ))
}

/// The id a place is addressed by, given a target id or label in any case.
/// `gsv` and `ship` name the Ship itself.
pub(crate) fn resolve_place(targets: &[Value], name: &str) -> Result<String, DynError> {
    let wanted = name.trim();
    if wanted.eq_ignore_ascii_case("gsv") || wanted.eq_ignore_ascii_case("ship") {
        return Ok("gsv".to_string());
    }
    let matches: Vec<&Value> = targets
        .iter()
        .filter(|target| {
            text(target, "targetId").eq_ignore_ascii_case(wanted)
                || text(target, "label").eq_ignore_ascii_case(wanted)
        })
        .collect();
    match matches.as_slice() {
        [one] => Ok(text(one, "targetId").to_string()),
        [] => {
            Err(format!("No place is called `{wanted}`. See your places with: gsv places").into())
        }
        several => Err(format!(
            "`{wanted}` names {} places: {}. Use the id instead.",
            several.len(),
            several
                .iter()
                .map(|target| format!("{} ({})", text(target, "label"), text(target, "targetId")))
                .collect::<Vec<_>>()
                .join(", ")
        )
        .into()),
    }
}

pub(crate) async fn list_places(
    client: &KernelClient,
    include_offline: bool,
) -> Result<Value, DynError> {
    call(
        client,
        "sys.target.list",
        json!({ "includeOffline": include_offline }),
    )
    .await
}

/// The target for a place name, or `None` for the Ship itself.
pub(crate) async fn target_for(
    client: &KernelClient,
    place: Option<&str>,
) -> Result<Option<String>, DynError> {
    let Some(place) = place.map(str::trim).filter(|place| !place.is_empty()) else {
        return Ok(None);
    };
    if place.eq_ignore_ascii_case("gsv") || place.eq_ignore_ascii_case("ship") {
        return Ok(None);
    }
    let listing = list_places(client, true).await?;
    let id = resolve_place(items(&listing, "targets"), place)?;
    Ok((id != "gsv").then_some(id))
}

/// A path on the Ship or a place, written `PLACE:PATH` or just `PATH`.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct PlacePath {
    pub(crate) place: Option<String>,
    pub(crate) path: String,
}

pub(crate) fn split_place_path(input: &str) -> PlacePath {
    if let Some((place, path)) = input.split_once(':') {
        let looks_like_place =
            place.len() > 1 && !place.starts_with('.') && !place.contains(['/', '\\', '~']);
        if looks_like_place {
            return PlacePath {
                place: Some(place.to_string()),
                path: path.to_string(),
            };
        }
    }
    PlacePath {
        place: None,
        path: input.to_string(),
    }
}

/// `fs` arguments for a resolved place path.
pub(crate) fn fs_args(target: &Option<String>, path: &str) -> Value {
    let mut args = json!({ "path": path });
    if let Some(target) = target {
        args["target"] = json!(target);
    }
    args
}

pub(crate) async fn resolve_place_path(
    client: &KernelClient,
    input: &str,
) -> Result<(Option<String>, String), DynError> {
    let mut split = split_place_path(input);
    // A dotted name may be a place (`laptop.local`) or a file on the Ship (`report.v2:final`).
    if let Some(place) = split.place.as_deref().filter(|place| place.contains('.')) {
        let listing = list_places(client, true).await?;
        if resolve_place(items(&listing, "targets"), place).is_err() {
            split = PlacePath {
                place: None,
                path: input.to_string(),
            };
        }
    }
    let target = target_for(client, split.place.as_deref()).await?;
    let path = if split.path.is_empty() {
        ".".to_string()
    } else {
        split.path
    };
    Ok((target, path))
}

/// Reads one file or folder with `fs.read`. Text and images arrive in the
/// response body; a folder listing arrives in the payload.
pub(crate) async fn read_path(
    client: &KernelClient,
    args: Value,
) -> Result<(Value, Option<Vec<u8>>), DynError> {
    let response = client
        .connection()
        .request_response("fs.read", Some(args), FILE_TIMEOUT)
        .await?;
    if response.data.get("ok").and_then(Value::as_bool) == Some(false) {
        return Err(text(&response.data, "error").to_string().into());
    }
    let body = match response.body {
        Some(body) => Some(body.read_all(MAX_PRINTED_FILE_BYTES).await?),
        None => None,
    };
    Ok((response.data, body))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn place_paths_split_on_a_place_name_only() {
        assert_eq!(
            split_place_path("laptop:~/notes.txt"),
            PlacePath {
                place: Some("laptop".into()),
                path: "~/notes.txt".into()
            }
        );
        assert_eq!(split_place_path("notes/todo.md").place, None);
        assert_eq!(split_place_path("C:\\Users\\me").place, None);
        assert_eq!(split_place_path("~/a:b").place, None);
        assert_eq!(split_place_path("./x:y").place, None);
        assert_eq!(
            split_place_path("laptop.local:~/notes.txt"),
            PlacePath {
                place: Some("laptop.local".into()),
                path: "~/notes.txt".into()
            }
        );
        assert_eq!(split_place_path(".hidden:x").place, None);
    }

    #[test]
    fn places_match_id_or_label_in_any_case_and_refuse_ambiguity() {
        let targets = vec![
            json!({ "targetId": "device-studio", "label": "Studio Mac" }),
            json!({ "targetId": "device-laptop", "label": "Laptop" }),
            json!({ "targetId": "device-old", "label": "laptop" }),
        ];
        assert_eq!(
            resolve_place(&targets, "studio mac").expect("label"),
            "device-studio"
        );
        assert_eq!(
            resolve_place(&targets, "DEVICE-STUDIO").expect("id"),
            "device-studio"
        );
        assert_eq!(resolve_place(&targets, "gsv").expect("ship"), "gsv");
        let error = resolve_place(&targets, "laptop")
            .expect_err("two places share the label")
            .to_string();
        assert!(error.contains("device-laptop") && error.contains("device-old"));
        resolve_place(&targets, "phone").expect_err("rejected");
    }
}
