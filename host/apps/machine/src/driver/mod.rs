//! Machine syscall execution shared by gateway and private instance transports.

use std::path::Path;

use gateway_client::protocol::{ErrorShape, Frame, RequestFrame, ResponseFrame};
use gateway_client::{BinaryBody, BinaryBodyChannel, BinaryBodyLimits, IncomingBody, OutgoingBody};
use serde_json::json;
use tokio_util::sync::CancellationToken;

use crate::tools::{Tool, ToolOutput};

pub(crate) mod events;
pub(crate) mod requests;
mod transfer;

pub(crate) const DRIVER_IMPLEMENTS: &[&str] = &["fs.*", "shell.exec", "shell.cancel", "net.fetch"];

pub(crate) struct PreparedResponseBody {
    pub(crate) outgoing: OutgoingBody,
    deadline: Option<tokio::time::Instant>,
    source: String,
}

impl PreparedResponseBody {
    pub(crate) async fn send(self) -> Result<(), String> {
        let source = self.source;
        match self.deadline {
            Some(deadline) => tokio::time::timeout_at(deadline, self.outgoing.send())
                .await
                .map_err(|_| format!("Timed out sending '{source}'"))?
                .map_err(|error| error.to_string()),
            None => self
                .outgoing
                .send()
                .await
                .map_err(|error| error.to_string()),
        }
    }
}

pub(crate) fn prepare_response_body(
    channel: &BinaryBodyChannel,
    body: crate::tools::ToolBody,
) -> Result<PreparedResponseBody, String> {
    let mut binary = BinaryBody::from_reader(body.reader, body.length);
    if let Some(max_length) = body.max_length {
        binary = binary.with_max_bytes(max_length);
    }
    let outgoing = channel
        .prepare(binary)
        .map_err(|error| format!("Could not prepare '{}': {error}", body.source))?;
    Ok(PreparedResponseBody {
        outgoing,
        deadline: body.deadline,
        source: body.source,
    })
}

pub(crate) fn driver_error_frame(request: &RequestFrame, message: String) -> Frame {
    if request.call.starts_with("fs.") {
        Frame::Res(ResponseFrame {
            id: request.id.clone(),
            ok: true,
            data: Some(json!({
                "ok": false,
                "error": message,
            })),
            error: None,
            body: None,
        })
    } else {
        Frame::Res(ResponseFrame {
            id: request.id.clone(),
            ok: false,
            data: None,
            error: Some(ErrorShape {
                code: -1,
                message,
                details: None,
                retryable: None,
            }),
            body: None,
        })
    }
}

pub(crate) fn daemon_body_limits() -> BinaryBodyLimits {
    BinaryBodyLimits {
        // Filesystem transfers are streams and historically had no whole-file
        // cap. Individual tools still enforce their own request/response limits.
        max_body_bytes: u64::MAX,
        ..BinaryBodyLimits::default()
    }
}

pub(crate) async fn execute_request(
    tools: &[Box<dyn Tool>],
    workspace: &Path,
    request: &RequestFrame,
    request_body: Result<Option<IncomingBody>, String>,
    cancellation: &CancellationToken,
) -> Result<ToolOutput, String> {
    let call = request.call.as_str();
    let args = request.args.clone().unwrap_or(serde_json::Value::Null);
    match transfer::handle_transfer_syscall(call, args.clone(), request_body?, workspace).await {
        transfer::TransferDispatch::Handled(result) => result,
        transfer::TransferDispatch::NotHandled(body) => match syscall_to_tool_name(call) {
            Some(name) => execute_tool_by_name(tools, call, name, args, body, cancellation).await,
            None => {
                drop(body);
                Err(format!("unknown syscall: {call}"))
            }
        },
    }
}

pub(crate) fn syscall_to_tool_name(call: &str) -> Option<&'static str> {
    match call {
        "fs.read" => Some("Read"),
        "fs.write" => Some("Write"),
        "fs.edit" => Some("Edit"),
        "fs.copy" => Some("Copy"),
        "fs.search" => Some("Search"),
        "fs.delete" => Some("Delete"),
        "shell.exec" => Some("Shell"),
        "shell.cancel" => Some("CancelShell"),
        "net.fetch" => Some("Fetch"),
        _ => None,
    }
}

pub(crate) async fn execute_tool_by_name(
    tools: &[Box<dyn Tool>],
    call: &str,
    name: &str,
    args: serde_json::Value,
    body: Option<IncomingBody>,
    cancellation: &CancellationToken,
) -> Result<ToolOutput, String> {
    let Some(tool) = tools.iter().find(|tool| tool.definition().name == name) else {
        drop(body);
        return Err(format!("tool not found: {}", name));
    };

    let timeout = tool.timeout(&args);
    let deadline = timeout.map(|duration| tokio::time::Instant::now() + duration);
    let execution = async {
        let body = match body {
            Some(mut body) => {
                let limit = match tool.request_body_limit(&args) {
                    Ok(limit) => limit,
                    Err(error) => {
                        body.cancel(&error);
                        return Err(error);
                    }
                };
                Some(
                    body.read_all(limit)
                        .await
                        .map_err(|error| error.to_string())?,
                )
            }
            None => None,
        };
        tool.execute_with_body_cancellable(args, body, cancellation)
            .await
    };
    let mut output = match (timeout, deadline) {
        (Some(timeout), Some(deadline)) => tokio::time::timeout_at(deadline, execution)
            .await
            .map_err(|_elapsed| format!("{} timed out after {}ms", call, timeout.as_millis()))?,
        _ => execution.await,
    }?;
    if let Some(body) = output.body.as_mut() {
        body.deadline = deadline;
    }
    Ok(output)
}
