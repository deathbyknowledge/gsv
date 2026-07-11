use crate::protocol::ToolDefinition;
use crate::tools::Tool;
use async_trait::async_trait;
use base64::Engine;
use futures_util::StreamExt;
use reqwest::{redirect::Policy, Method, StatusCode};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
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
    redirect: Option<NetFetchRedirect>,
    #[serde(default)]
    timeout_ms: Option<u64>,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum NetFetchRedirect {
    Follow,
    Error,
    Manual,
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
                    "redirect": {
                        "type": "string",
                        "enum": ["follow", "error", "manual"]
                    },
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
        let should_read_body = method != Method::HEAD;
        let timeout_ms = args.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS).max(1);
        let redirect = args.redirect.unwrap_or(NetFetchRedirect::Follow);
        let redirected = Arc::new(AtomicBool::new(false));
        let redirect_policy = match redirect {
            NetFetchRedirect::Follow => {
                let redirected = Arc::clone(&redirected);
                Policy::custom(move |attempt| {
                    redirected.store(true, Ordering::Relaxed);
                    if attempt.previous().len() > 20 {
                        attempt.error("too many redirects")
                    } else {
                        attempt.follow()
                    }
                })
            }
            NetFetchRedirect::Error | NetFetchRedirect::Manual => Policy::none(),
        };
        let client = reqwest::Client::builder()
            .timeout(Duration::from_millis(timeout_ms))
            .redirect(redirect_policy)
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
        if matches!(redirect, NetFetchRedirect::Error) && is_redirect_status(status) {
            return Err("net.fetch encountered a redirect with redirect mode error".to_string());
        }
        let final_url = response.url().to_string();
        let mut headers = serde_json::Map::new();
        for (key, value) in response.headers().iter() {
            if let Ok(value) = value.to_str() {
                headers.insert(key.as_str().to_string(), json!(value));
            }
        }

        let body =
            read_limited_response_body(response, should_read_body, MAX_RESPONSE_BYTES).await?;
        let body_base64 = base64::engine::general_purpose::STANDARD.encode(&body);
        let body_text = std::str::from_utf8(&body).ok().map(str::to_string);

        Ok(json!({
            "ok": status.is_success(),
            "url": final_url,
            "status": status.as_u16(),
            "statusText": status.canonical_reason().unwrap_or(""),
            "headers": headers,
            "redirected": redirected.load(Ordering::Relaxed),
            "bodyBase64": body_base64,
            "bodyText": body_text,
            "bodyBytes": body.len(),
        }))
    }
}

async fn read_limited_response_body(
    response: reqwest::Response,
    should_read_body: bool,
    max_bytes: usize,
) -> Result<Vec<u8>, String> {
    if !should_read_body || is_null_body_status(response.status()) {
        return Ok(Vec::new());
    }
    if let Some(content_length) = response.content_length() {
        if content_length > max_bytes as u64 {
            return Err(format_response_size_error(content_length, max_bytes));
        }
    }

    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Failed to read response body: {}", e))?;
        if chunk.is_empty() {
            continue;
        }
        let next_len = body
            .len()
            .checked_add(chunk.len())
            .ok_or_else(|| format_response_size_error(u64::MAX, max_bytes))?;
        if next_len > max_bytes {
            return Err(format_response_size_error(next_len as u64, max_bytes));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn is_null_body_status(status: StatusCode) -> bool {
    status == StatusCode::NO_CONTENT
        || status == StatusCode::RESET_CONTENT
        || status == StatusCode::NOT_MODIFIED
}

fn is_redirect_status(status: StatusCode) -> bool {
    matches!(status.as_u16(), 301 | 302 | 303 | 307 | 308)
}

fn format_response_size_error(actual_bytes: u64, max_bytes: usize) -> String {
    format!(
        "Response body exceeds limit ({} bytes, max {})",
        actual_bytes, max_bytes
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    const REDIRECT_RESPONSE: &[u8] =
        b"HTTP/1.1 302 Found\r\nLocation: /final\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";

    #[tokio::test]
    async fn allows_head_response_with_large_content_length() {
        let (url, server) = serve_once(
            format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                MAX_RESPONSE_BYTES + 1
            )
            .into_bytes(),
        );

        let result = NetFetchTool::new()
            .execute(json!({
                "url": url,
                "method": "HEAD",
            }))
            .await
            .unwrap();
        server.join().unwrap();

        assert_eq!(result.get("status").and_then(Value::as_u64), Some(200));
        assert_eq!(result.get("bodyBytes").and_then(Value::as_u64), Some(0));
        assert_eq!(result.get("bodyBase64").and_then(Value::as_str), Some(""));
    }

    #[tokio::test]
    async fn rejects_declared_oversized_response_before_reading_body() {
        let (url, server) = serve_once(
            format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                MAX_RESPONSE_BYTES + 1
            )
            .into_bytes(),
        );

        let error = NetFetchTool::new()
            .execute(json!({ "url": url }))
            .await
            .unwrap_err();
        server.join().unwrap();

        assert_eq!(
            error,
            format!(
                "Response body exceeds limit ({} bytes, max {})",
                MAX_RESPONSE_BYTES + 1,
                MAX_RESPONSE_BYTES
            )
        );
    }

    #[tokio::test]
    async fn rejects_streamed_response_that_exceeds_limit() {
        let (url, server) =
            serve_once(b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\nabcd".to_vec());
        let response = reqwest::Client::new().get(url).send().await.unwrap();

        let error = read_limited_response_body(response, true, 3)
            .await
            .unwrap_err();
        server.join().unwrap();

        assert_eq!(error, "Response body exceeds limit (4 bytes, max 3)");
    }

    #[tokio::test]
    async fn returns_redirect_responses_in_manual_mode() {
        let (url, server) = serve_once(REDIRECT_RESPONSE.to_vec());

        let result = NetFetchTool::new()
            .execute(json!({ "url": url, "redirect": "manual" }))
            .await
            .unwrap();
        server.join().unwrap();

        assert_eq!(result.get("status").and_then(Value::as_u64), Some(302));
        assert_eq!(
            result.get("redirected").and_then(Value::as_bool),
            Some(false)
        );
    }

    #[tokio::test]
    async fn follows_redirects_and_marks_the_response() {
        let (url, server) = serve_redirect();

        let result = NetFetchTool::new()
            .execute(json!({ "url": url }))
            .await
            .unwrap();
        server.join().unwrap();

        assert_eq!(result.get("status").and_then(Value::as_u64), Some(200));
        assert_eq!(
            result.get("redirected").and_then(Value::as_bool),
            Some(true)
        );
    }

    #[tokio::test]
    async fn rejects_redirect_responses_in_error_mode() {
        let (url, server) = serve_once(REDIRECT_RESPONSE.to_vec());

        let error = NetFetchTool::new()
            .execute(json!({ "url": url, "redirect": "error" }))
            .await
            .unwrap_err();
        server.join().unwrap();

        assert_eq!(
            error,
            "net.fetch encountered a redirect with redirect mode error"
        );
    }

    fn serve_once(response: Vec<u8>) -> (String, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 4096];
            let _ = stream.read(&mut request);
            stream.write_all(&response).unwrap();
        });
        (format!("http://{}", addr), handle)
    }

    fn serve_redirect() -> (String, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = thread::spawn(move || {
            for response in [
                REDIRECT_RESPONSE,
                b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            ] {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = [0_u8; 4096];
                let _ = stream.read(&mut request);
                stream.write_all(response).unwrap();
            }
        });
        (format!("http://{}", addr), handle)
    }
}
