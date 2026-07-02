use crate::protocol::ToolDefinition;
use crate::tools::Tool;
use async_trait::async_trait;
use base64::Engine;
use reqwest::Method;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::time::Duration;

const DEFAULT_TIMEOUT_MS: u64 = 60_000;
const MAX_RESPONSE_BYTES: usize = 32 * 1024 * 1024;

pub struct NetFetchTool;

impl NetFetchTool {
    pub fn new() -> Self {
        Self
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NetFetchArgs {
    url: String,
    #[serde(default)]
    method: Option<String>,
    #[serde(default)]
    headers: HashMap<String, String>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    body_base64: Option<String>,
    #[serde(default)]
    timeout_ms: Option<u64>,
}

#[async_trait]
impl Tool for NetFetchTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: "Fetch".to_string(),
            description: "Fetch an HTTP(S) URL from this device's network.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "url": { "type": "string" },
                    "method": { "type": "string" },
                    "headers": {
                        "type": "object",
                        "additionalProperties": { "type": "string" }
                    },
                    "body": { "type": "string" },
                    "bodyBase64": { "type": "string" },
                    "timeoutMs": { "type": "number" }
                },
                "required": ["url"]
            }),
        }
    }

    async fn execute(&self, args: Value) -> Result<Value, String> {
        let args: NetFetchArgs =
            serde_json::from_value(args).map_err(|e| format!("Invalid arguments: {}", e))?;
        let url =
            reqwest::Url::parse(args.url.trim()).map_err(|e| format!("Invalid URL: {}", e))?;
        if url.scheme() != "http" && url.scheme() != "https" {
            return Err("URL must use HTTP or HTTPS".to_string());
        }

        let method = args
            .method
            .as_deref()
            .unwrap_or("GET")
            .parse::<Method>()
            .map_err(|e| format!("Invalid method: {}", e))?;
        let timeout_ms = args.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS).max(1);
        let client = reqwest::Client::builder()
            .timeout(Duration::from_millis(timeout_ms))
            .build()
            .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

        let mut request = client.request(method, url);
        for (key, value) in args.headers {
            request = request.header(key, value);
        }

        if let Some(body_base64) = args.body_base64 {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(body_base64.as_bytes())
                .map_err(|e| format!("Invalid bodyBase64: {}", e))?;
            request = request.body(bytes);
        } else if let Some(body) = args.body {
            request = request.body(body);
        }

        let response = request
            .send()
            .await
            .map_err(|e| format!("HTTP request failed: {}", e))?;
        let status = response.status();
        let final_url = response.url().to_string();
        let mut headers = serde_json::Map::new();
        for (key, value) in response.headers().iter() {
            if let Ok(value) = value.to_str() {
                headers.insert(key.as_str().to_string(), json!(value));
            }
        }

        let body = response
            .bytes()
            .await
            .map_err(|e| format!("Failed to read response body: {}", e))?;
        if body.len() > MAX_RESPONSE_BYTES {
            return Err(format!(
                "Response body exceeds limit ({} bytes, max {})",
                body.len(),
                MAX_RESPONSE_BYTES
            ));
        }
        let body_base64 = base64::engine::general_purpose::STANDARD.encode(&body);
        let body_text = std::str::from_utf8(&body).ok().map(str::to_string);

        Ok(json!({
            "ok": status.is_success(),
            "url": final_url,
            "status": status.as_u16(),
            "statusText": status.canonical_reason().unwrap_or(""),
            "headers": headers,
            "bodyBase64": body_base64,
            "bodyText": body_text,
            "bodyBytes": body.len(),
        }))
    }
}
