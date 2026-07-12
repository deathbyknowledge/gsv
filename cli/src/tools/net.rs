use crate::protocol::ToolDefinition;
use crate::tools::{Tool, ToolBody, ToolOutput};
use async_trait::async_trait;
use futures_util::TryStreamExt;
use reqwest::{redirect::Policy, Method, StatusCode};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;
use tokio_util::io::StreamReader;

const DEFAULT_TIMEOUT_MS: u64 = 60_000;
const MAX_TIMEOUT_MS: u64 = 10 * 60_000;
const MAX_REQUEST_BYTES: usize = 32 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 32 * 1024 * 1024;

#[derive(Default)]
pub struct NetFetchTool;

impl NetFetchTool {
    pub fn new() -> Self {
        Self
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
struct NetFetchArgs {
    url: String,
    #[serde(default)]
    method: Option<String>,
    #[serde(default)]
    headers: HashMap<String, String>,
    #[serde(default)]
    redirect: Option<NetFetchRedirect>,
    #[serde(default, rename = "timeoutMs")]
    _timeout_ms: Option<u64>,
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

    async fn execute(&self, args: Value) -> Result<ToolOutput, String> {
        self.execute_request(args, None).await
    }

    fn request_body_limit(&self, args: &Value) -> Result<usize, String> {
        let args: NetFetchArgs = serde_json::from_value(args.clone())
            .map_err(|e| format!("Invalid arguments: {}", e))?;
        let method = parse_method(args.method.as_deref())?;
        if method == Method::GET || method == Method::HEAD {
            return Err(format!("{} requests cannot include a body", method));
        }
        Ok(MAX_REQUEST_BYTES)
    }

    fn timeout(&self, args: &Value) -> Option<Duration> {
        Some(Duration::from_millis(net_fetch_timeout_ms(args)))
    }

    async fn execute_with_body(
        &self,
        args: Value,
        body: Option<Vec<u8>>,
    ) -> Result<ToolOutput, String> {
        self.execute_request(args, body).await
    }
}

impl NetFetchTool {
    async fn execute_request(
        &self,
        args: Value,
        frame_body: Option<Vec<u8>>,
    ) -> Result<ToolOutput, String> {
        let timeout = net_fetch_timeout_ms(&args);
        let NetFetchArgs {
            url,
            method,
            headers,
            redirect,
            _timeout_ms: _,
        } = serde_json::from_value(args).map_err(|e| format!("Invalid arguments: {}", e))?;
        let url = reqwest::Url::parse(url.trim()).map_err(|e| format!("Invalid URL: {}", e))?;
        if url.scheme() != "http" && url.scheme() != "https" {
            return Err("URL must use HTTP or HTTPS".to_string());
        }

        let method = parse_method(method.as_deref())?;
        if frame_body.is_some() && (method == Method::GET || method == Method::HEAD) {
            return Err(format!("{} requests cannot include a body", method));
        }
        let should_read_response_body = method != Method::HEAD;
        let redirect = redirect.unwrap_or(NetFetchRedirect::Follow);
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
            .timeout(Duration::from_millis(timeout))
            .redirect(redirect_policy)
            .build()
            .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

        let mut request = client.request(method, url);
        for (key, value) in headers {
            request = request.header(key, value);
        }

        if let Some(body) = frame_body {
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

        let body = response_body(
            response,
            should_read_response_body && !is_null_body_status(status),
            MAX_RESPONSE_BYTES,
        )?;
        let data = json!({
            "ok": status.is_success(),
            "url": final_url,
            "status": status.as_u16(),
            "statusText": status.canonical_reason().unwrap_or(""),
            "headers": headers,
            "redirected": redirected.load(Ordering::Relaxed),
        });
        Ok(match body {
            Some(body) => ToolOutput::with_body(data, body),
            None => ToolOutput::json(data),
        })
    }
}

fn parse_method(method: Option<&str>) -> Result<Method, String> {
    method
        .unwrap_or("GET")
        .parse::<Method>()
        .map_err(|e| format!("Invalid method: {}", e))
}

fn net_fetch_timeout_ms(args: &Value) -> u64 {
    args.get("timeoutMs")
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_TIMEOUT_MS)
        .clamp(1, MAX_TIMEOUT_MS)
}

fn response_body(
    response: reqwest::Response,
    should_read_body: bool,
    max_bytes: usize,
) -> Result<Option<ToolBody>, String> {
    if !should_read_body {
        return Ok(None);
    }
    let content_length = response.content_length();
    if let Some(content_length) = content_length {
        if content_length > max_bytes as u64 {
            return Err(format_response_size_error(content_length, max_bytes));
        }
    }
    let stream = response
        .bytes_stream()
        .map_err(|error| std::io::Error::other(format!("Failed to read response body: {}", error)));
    Ok(Some(ToolBody::reader(
        StreamReader::new(stream),
        content_length,
        Some(max_bytes as u64),
        "net.fetch response",
    )))
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
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;
    use std::thread;
    use tokio::io::AsyncReadExt;

    const REDIRECT_RESPONSE: &[u8] =
        b"HTTP/1.1 302 Found\r\nLocation: /final\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";

    #[test]
    fn caps_request_timeouts() {
        assert_eq!(
            net_fetch_timeout_ms(&json!({ "timeoutMs": u64::MAX })),
            MAX_TIMEOUT_MS
        );
    }

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

        assert_eq!(result.data.get("status").and_then(Value::as_u64), Some(200));
        assert!(result.body.is_none());
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
    async fn marks_unknown_length_response_with_a_streaming_limit() {
        let (url, server) =
            serve_once(b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\nabcd".to_vec());
        let response = reqwest::Client::new().get(url).send().await.unwrap();

        let mut body = response_body(response, true, 3).unwrap().unwrap();
        server.join().unwrap();

        assert_eq!(body.length, None);
        assert_eq!(body.max_length, Some(3));
        let mut bytes = Vec::new();
        body.reader.read_to_end(&mut bytes).await.unwrap();
        assert_eq!(bytes, b"abcd");
    }

    #[tokio::test]
    async fn returns_redirect_responses_in_manual_mode() {
        let (url, server) = serve_once(REDIRECT_RESPONSE.to_vec());

        let result = NetFetchTool::new()
            .execute(json!({ "url": url, "redirect": "manual" }))
            .await
            .unwrap();
        server.join().unwrap();

        assert_eq!(result.data.get("status").and_then(Value::as_u64), Some(302));
        assert_eq!(
            result.data.get("redirected").and_then(Value::as_bool),
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

        assert_eq!(result.data.get("status").and_then(Value::as_u64), Some(200));
        assert_eq!(
            result.data.get("redirected").and_then(Value::as_bool),
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

    #[tokio::test]
    async fn sends_request_and_returns_response_frame_bodies() {
        let (url, server) = serve_echo();
        let bytes = vec![0, 1, 0xfe, 0xff];

        let result = NetFetchTool::new()
            .execute_with_body(
                json!({
                    "url": url,
                    "method": "POST",
                    "headers": { "content-type": "application/octet-stream" },
                }),
                Some(bytes.clone()),
            )
            .await
            .unwrap();
        server.join().unwrap();

        assert_eq!(result.data["status"], 200);
        let mut body = result.body.unwrap();
        assert_eq!(body.length, Some(bytes.len() as u64));
        let mut actual = Vec::new();
        body.reader.read_to_end(&mut actual).await.unwrap();
        assert_eq!(actual, bytes);
    }

    #[tokio::test]
    async fn returns_an_explicit_body_for_an_empty_get_response() {
        let (url, server) = serve_once(
            b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec(),
        );

        let result = NetFetchTool::new()
            .execute(json!({ "url": url }))
            .await
            .unwrap();
        server.join().unwrap();

        assert_eq!(result.body.unwrap().length, Some(0));
    }

    #[tokio::test]
    async fn omits_bodies_for_null_body_statuses() {
        for (status, reason) in [
            (204, "No Content"),
            (205, "Reset Content"),
            (304, "Not Modified"),
        ] {
            let (url, server) = serve_once(
                format!(
                    "HTTP/1.1 {} {}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                    status, reason
                )
                .into_bytes(),
            );

            let result = NetFetchTool::new()
                .execute(json!({ "url": url }))
                .await
                .unwrap();
            server.join().unwrap();

            assert!(result.body.is_none(), "status {} returned a body", status);
        }
    }

    #[test]
    fn rejects_get_and_head_request_bodies_before_reading_them() {
        for method in ["GET", "HEAD"] {
            let args = json!({ "url": "https://example.test/", "method": method });
            assert_eq!(
                NetFetchTool::new().request_body_limit(&args).unwrap_err(),
                format!("{} requests cannot include a body", method)
            );
        }
    }

    #[tokio::test]
    async fn rejects_inline_request_bodies() {
        for field in ["body", "bodyBase64"] {
            let mut args = json!({ "url": "https://example.test/" });
            args[field] = json!("payload");
            let error = NetFetchTool::new().execute(args).await.unwrap_err();
            assert!(error.contains(field));
        }
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

    fn serve_echo() -> (String, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut content_length = 0;
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" {
                    break;
                }
                if let Some((name, value)) = line.split_once(':') {
                    if name.eq_ignore_ascii_case("content-length") {
                        content_length = value.trim().parse().unwrap();
                    }
                }
            }
            let mut body = vec![0; content_length];
            reader.read_exact(&mut body).unwrap();
            let headers = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            stream.write_all(headers.as_bytes()).unwrap();
            stream.write_all(&body).unwrap();
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
