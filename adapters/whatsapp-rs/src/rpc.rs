use serde_json::{json, Map, Value};
use wasm_bindgen::prelude::*;
use worker::{Env, Headers, Method, Request, RequestInit};

type AdapterRpcResult = std::result::Result<JsValue, JsValue>;

fn to_js_value(value: Value) -> AdapterRpcResult {
    serde_wasm_bindgen::to_value(&value)
        .map_err(|error| JsValue::from_str(&format!("invalid adapter rpc response: {error}")))
}

fn js_error(message: impl Into<String>) -> JsValue {
    JsValue::from_str(&message.into())
}

fn worker_error(error: worker::Error) -> JsValue {
    js_error(error.to_string())
}

fn js_to_json(value: JsValue) -> std::result::Result<Value, JsValue> {
    if value.is_null() || value.is_undefined() {
        return Ok(Value::Null);
    }
    serde_wasm_bindgen::from_value(value).map_err(|error| js_error(error.to_string()))
}

async fn account_json(
    env: &Env,
    account_id: &str,
    method: Method,
    path: &str,
    body: Option<Value>,
) -> std::result::Result<Value, JsValue> {
    let namespace = env
        .durable_object("WHATSAPP_ACCOUNT")
        .map_err(worker_error)?;
    let id = namespace.id_from_name(account_id).map_err(worker_error)?;
    let stub = id.get_stub().map_err(worker_error)?;

    let headers = Headers::new();
    headers
        .set("X-Account-Id", account_id)
        .map_err(worker_error)?;
    if body.is_some() {
        headers
            .set("Content-Type", "application/json")
            .map_err(worker_error)?;
    }

    let mut init = RequestInit::new();
    init.with_method(method);
    init.with_headers(headers);
    if let Some(body) = body {
        let bytes = serde_json::to_vec(&body).map_err(|error| js_error(error.to_string()))?;
        init.with_body(Some(js_sys::Uint8Array::from(bytes.as_slice()).into()));
    }

    let url = format!("https://whatsapp-account.internal{path}");
    let request = Request::new_with_init(&url, &init).map_err(worker_error)?;
    let mut response = stub
        .fetch_with_request(request)
        .await
        .map_err(worker_error)?;
    let status = response.status_code();
    let text = response.text().await.map_err(worker_error)?;

    if status >= 400 {
        return Err(js_error(if text.trim().is_empty() {
            format!("WhatsApp account request failed with status {status}")
        } else {
            text
        }));
    }

    if text.trim().is_empty() {
        return Ok(json!({}));
    }

    serde_json::from_str(&text).map_err(|error| js_error(error.to_string()))
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Bool(value)) => *value,
        Some(Value::String(value)) => matches!(value.as_str(), "true" | "1" | "yes"),
        Some(Value::Number(value)) => value.as_i64().is_some_and(|value| value != 0),
        _ => false,
    }
}

fn string_field(value: &Value, field: &str) -> Option<String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn surface_id(surface: &Value) -> Option<String> {
    string_field(surface, "id")
}

fn whatsapp_surface(id: &str) -> Value {
    let trimmed = id.trim();
    json!({
        "kind": if trimmed.ends_with("@g.us") { "group" } else { "dm" },
        "id": trimmed
    })
}

fn outbound_message_from_adapter(value: Value) -> std::result::Result<Value, JsValue> {
    let surface = value
        .get("surface")
        .cloned()
        .ok_or_else(|| js_error("missing message.surface"))?;
    let surface_id = surface_id(&surface).ok_or_else(|| js_error("missing message.surface.id"))?;
    let text = string_field(&value, "text").unwrap_or_default();

    let mut outbound = Map::new();
    outbound.insert(
        "peer".to_string(),
        if surface.is_object() {
            surface
        } else {
            whatsapp_surface(&surface_id)
        },
    );
    outbound.insert("text".to_string(), Value::String(text));
    if let Some(media) = value.get("media").cloned() {
        outbound.insert("media".to_string(), media);
    }
    if let Some(reply_to_id) = string_field(&value, "replyToId") {
        outbound.insert("replyToId".to_string(), Value::String(reply_to_id));
    }

    Ok(Value::Object(outbound))
}

fn success_result(value: Value, fallback_error: &str) -> Value {
    if truthy(value.get("success")) {
        json!({
            "ok": true,
            "messageId": string_field(&value, "messageId")
        })
    } else {
        json!({
            "ok": false,
            "error": string_field(&value, "error")
                .or_else(|| string_field(&value, "message"))
                .unwrap_or_else(|| fallback_error.to_string())
        })
    }
}

fn shell_ok(output: impl Into<String>) -> AdapterRpcResult {
    let output = output.into();
    to_js_value(json!({
        "status": "completed",
        "output": output,
        "exitCode": 0,
        "ok": true,
        "pid": 0,
        "stdout": output,
        "stderr": ""
    }))
}

fn shell_fail(error: impl Into<String>) -> AdapterRpcResult {
    let error = error.into();
    to_js_value(json!({
        "status": "failed",
        "output": error,
        "error": error,
        "exitCode": 1,
        "ok": false,
        "pid": 0,
        "stdout": "",
        "stderr": error
    }))
}

fn parse_shell_words(input: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut escaped = false;

    for ch in input.trim().chars() {
        if escaped {
            current.push(ch);
            escaped = false;
            continue;
        }

        if ch == '\\' {
            escaped = true;
            continue;
        }

        match quote {
            Some(active_quote) if ch == active_quote => {
                quote = None;
            }
            Some(_) => current.push(ch),
            None if ch == '"' || ch == '\'' => {
                quote = Some(ch);
            }
            None if ch.is_whitespace() => {
                if !current.is_empty() {
                    words.push(std::mem::take(&mut current));
                }
            }
            None => current.push(ch),
        }
    }

    if escaped {
        current.push('\\');
    }
    if !current.is_empty() {
        words.push(current);
    }

    words
}

fn is_help_command(command: &str) -> bool {
    matches!(command, "help" | "-h" | "--help")
}

fn media_type_from_filename_or_url(value: &str) -> &'static str {
    let lower = value.to_ascii_lowercase();
    if lower.ends_with(".png")
        || lower.ends_with(".jpg")
        || lower.ends_with(".jpeg")
        || lower.ends_with(".gif")
        || lower.ends_with(".webp")
    {
        "image"
    } else if lower.ends_with(".mp3")
        || lower.ends_with(".wav")
        || lower.ends_with(".ogg")
        || lower.ends_with(".m4a")
    {
        "audio"
    } else if lower.ends_with(".mp4") || lower.ends_with(".mov") || lower.ends_with(".webm") {
        "video"
    } else {
        "document"
    }
}

fn parse_attach_args(
    tokens: &[String],
) -> (Option<String>, Option<String>, Option<String>, String) {
    let surface_id = tokens.first().cloned();
    let url = tokens.get(1).cloned();
    let mut index = 2;
    let mut filename = None;

    if matches!(
        tokens.get(index).map(String::as_str),
        Some("--filename" | "-f")
    ) {
        filename = tokens.get(index + 1).cloned();
        index += 2;
    }

    let caption = tokens[index..].join(" ").trim().to_string();
    (surface_id, url, filename, caption)
}

#[wasm_bindgen(js_name = adapterConnect)]
pub async fn adapter_connect(account_id: String, config: JsValue, env: Env) -> AdapterRpcResult {
    let config = js_to_json(config).unwrap_or(Value::Null);
    let path = if truthy(config.get("force")) {
        "/login?force=true"
    } else {
        "/login"
    };

    match account_json(&env, &account_id, Method::Post, path, None).await {
        Ok(data) => {
            let qr = string_field(&data, "qr");
            let message = string_field(&data, "message").unwrap_or_else(|| "Connected".to_string());

            if let Some(qr) = qr {
                return to_js_value(json!({
                    "ok": true,
                    "connected": true,
                    "authenticated": false,
                    "message": message,
                    "challenge": {
                        "type": "qr",
                        "message": message,
                        "data": qr
                    }
                }));
            }

            if truthy(data.get("connected")) {
                return to_js_value(json!({
                    "ok": true,
                    "connected": true,
                    "authenticated": true,
                    "message": message
                }));
            }

            to_js_value(json!({
                "ok": false,
                "error": string_field(&data, "error").unwrap_or_else(|| "Login failed".to_string())
            }))
        }
        Err(error) => to_js_value(
            json!({ "ok": false, "error": error.as_string().unwrap_or_else(|| "Login failed".to_string()) }),
        ),
    }
}

#[wasm_bindgen(js_name = adapterDisconnect)]
pub async fn adapter_disconnect(account_id: String, env: Env) -> AdapterRpcResult {
    match account_json(&env, &account_id, Method::Post, "/logout", None).await {
        Ok(data) if truthy(data.get("success")) => to_js_value(json!({
            "ok": true,
            "message": string_field(&data, "message").unwrap_or_else(|| "Disconnected".to_string())
        })),
        Ok(data) => to_js_value(json!({
            "ok": false,
            "error": string_field(&data, "error").unwrap_or_else(|| "Failed to disconnect".to_string())
        })),
        Err(error) => to_js_value(json!({
            "ok": false,
            "error": error.as_string().unwrap_or_else(|| "Failed to disconnect".to_string())
        })),
    }
}

#[wasm_bindgen(js_name = adapterStatus)]
pub async fn adapter_status(account_id: Option<String>, env: Env) -> AdapterRpcResult {
    let Some(account_id) = account_id else {
        return to_js_value(json!([]));
    };

    match account_json(&env, &account_id, Method::Get, "/status", None).await {
        Ok(data) => to_js_value(json!([{
            "accountId": account_id,
            "connected": truthy(data.get("connected")),
            "authenticated": truthy(data.get("authenticated")) || string_field(&data, "selfJid").is_some(),
            "mode": string_field(&data, "mode").unwrap_or_else(|| "websocket".to_string()),
            "lastActivity": data.get("lastMessageAt").cloned().unwrap_or(Value::Null),
            "extra": {
                "selfJid": data.get("selfJid").cloned().unwrap_or(Value::Null),
                "selfE164": data.get("selfE164").cloned().unwrap_or(Value::Null),
                "hasClient": data.get("hasClient").cloned().unwrap_or(Value::Null),
                "implementation": data.get("implementation").cloned().unwrap_or(Value::Null)
            }
        }])),
        Err(error) => to_js_value(json!([{
            "accountId": account_id,
            "connected": false,
            "authenticated": false,
            "error": error.as_string().unwrap_or_else(|| "Failed to read account status".to_string())
        }])),
    }
}

#[wasm_bindgen(js_name = adapterSend)]
pub async fn adapter_send(account_id: String, message: JsValue, env: Env) -> AdapterRpcResult {
    let outbound = match js_to_json(message).and_then(outbound_message_from_adapter) {
        Ok(outbound) => outbound,
        Err(error) => {
            return to_js_value(json!({
                "ok": false,
                "error": error.as_string().unwrap_or_else(|| "Invalid outbound message".to_string())
            }));
        }
    };

    match account_json(&env, &account_id, Method::Post, "/send", Some(outbound)).await {
        Ok(data) => to_js_value(success_result(data, "Failed to send")),
        Err(error) => to_js_value(json!({
            "ok": false,
            "error": error.as_string().unwrap_or_else(|| "Failed to send".to_string())
        })),
    }
}

#[wasm_bindgen(js_name = adapterSetActivity)]
pub async fn adapter_set_activity(
    account_id: String,
    surface: JsValue,
    activity: JsValue,
    env: Env,
) -> AdapterRpcResult {
    let activity = js_to_json(activity).unwrap_or(Value::Null);
    if string_field(&activity, "kind").as_deref() != Some("typing") {
        return to_js_value(json!({ "ok": true }));
    }

    let surface = match js_to_json(surface) {
        Ok(surface) if surface_id(&surface).is_some() => surface,
        _ => {
            return to_js_value(json!({
                "ok": false,
                "error": "missing surface.id"
            }));
        }
    };

    let body = json!({
        "peer": surface,
        "typing": truthy(activity.get("active"))
    });

    match account_json(&env, &account_id, Method::Post, "/typing", Some(body)).await {
        Ok(data) if truthy(data.get("success")) => to_js_value(json!({ "ok": true })),
        Ok(data) => to_js_value(json!({
            "ok": false,
            "error": string_field(&data, "error").unwrap_or_else(|| "Failed to set typing".to_string())
        })),
        Err(error) => to_js_value(json!({
            "ok": false,
            "error": error.as_string().unwrap_or_else(|| "Failed to set typing".to_string())
        })),
    }
}

#[wasm_bindgen(js_name = adapterShellExec)]
pub async fn adapter_shell_exec(account_id: String, args: JsValue, env: Env) -> AdapterRpcResult {
    let args = js_to_json(args).unwrap_or(Value::Null);
    let input = string_field(&args, "input").unwrap_or_default();
    let tokens = parse_shell_words(&input);
    let command = tokens.first().map(String::as_str).unwrap_or("help");

    if is_help_command(command) {
        return shell_ok(
            [
                "whatsapp-rs adapter commands:",
                "  help | -h | --help",
                "  send <jid-or-phone> <text>",
                "  react <jid-or-phone> <message-id> <emoji> [participant-jid]",
                "  attach <jid-or-phone> <url> [--filename <name>] [caption]",
                "",
                "Normal back-and-forth replies should use the adapter conversation route.",
            ]
            .join("\n"),
        );
    }

    if command == "send" {
        let Some(surface_id) = tokens.get(1) else {
            return shell_fail("usage: send <jid-or-phone> <text>");
        };
        let text = tokens[2..].join(" ").trim().to_string();
        if text.is_empty() {
            return shell_fail("usage: send <jid-or-phone> <text>");
        }
        let body = json!({
            "peer": whatsapp_surface(surface_id),
            "text": text
        });
        let result = account_json(&env, &account_id, Method::Post, "/send", Some(body)).await;
        return match result {
            Ok(data) if truthy(data.get("success")) => shell_ok(
                format!(
                    "sent {}",
                    string_field(&data, "messageId").unwrap_or_default()
                )
                .trim()
                .to_string(),
            ),
            Ok(data) => shell_fail(
                string_field(&data, "error").unwrap_or_else(|| "Failed to send".to_string()),
            ),
            Err(error) => shell_fail(
                error
                    .as_string()
                    .unwrap_or_else(|| "Failed to send".to_string()),
            ),
        };
    }

    if command == "react" {
        let (Some(surface_id), Some(message_id), Some(emoji)) =
            (tokens.get(1), tokens.get(2), tokens.get(3))
        else {
            return shell_fail(
                "usage: react <jid-or-phone> <message-id> <emoji> [participant-jid]",
            );
        };
        let body = json!({
            "peer": whatsapp_surface(surface_id),
            "messageId": message_id,
            "emoji": emoji,
            "participant": tokens.get(4).cloned().unwrap_or_default()
        });
        let result = account_json(&env, &account_id, Method::Post, "/react", Some(body)).await;
        return match result {
            Ok(data) if truthy(data.get("success")) => shell_ok("reacted"),
            Ok(data) => shell_fail(
                string_field(&data, "error").unwrap_or_else(|| "Failed to react".to_string()),
            ),
            Err(error) => shell_fail(
                error
                    .as_string()
                    .unwrap_or_else(|| "Failed to react".to_string()),
            ),
        };
    }

    if command == "attach" {
        let (surface_id, url, filename, caption) = parse_attach_args(&tokens[1..]);
        let (Some(surface_id), Some(url)) = (surface_id, url) else {
            return shell_fail("usage: attach <jid-or-phone> <url> [--filename <name>] [caption]");
        };
        let filename_or_url = filename.as_deref().unwrap_or(&url);
        let body = json!({
            "peer": whatsapp_surface(&surface_id),
            "text": caption,
            "media": [{
                "type": media_type_from_filename_or_url(filename_or_url),
                "mimeType": "application/octet-stream",
                "url": url,
                "filename": filename
            }]
        });
        let result = account_json(&env, &account_id, Method::Post, "/send", Some(body)).await;
        return match result {
            Ok(data) if truthy(data.get("success")) => shell_ok(
                format!(
                    "sent {}",
                    string_field(&data, "messageId").unwrap_or_default()
                )
                .trim()
                .to_string(),
            ),
            Ok(data) => shell_fail(
                string_field(&data, "error").unwrap_or_else(|| "Failed to attach".to_string()),
            ),
            Err(error) => shell_fail(
                error
                    .as_string()
                    .unwrap_or_else(|| "Failed to attach".to_string()),
            ),
        };
    }

    shell_fail(format!("unknown command: {command}"))
}
