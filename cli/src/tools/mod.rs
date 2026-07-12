mod copy;
mod delete;
mod edit;
mod net;
mod read;
mod search;
mod shell;
mod write;

pub use copy::CopyTool;
pub use delete::DeleteTool;
pub use edit::EditTool;
pub use net::NetFetchTool;
pub use read::ReadTool;
pub use search::SearchTool;
pub use shell::{subscribe_exec_events, ShellTool};
pub use write::WriteTool;

use crate::protocol::ToolDefinition;
use async_trait::async_trait;
use serde_json::Value;
use std::fmt;
use std::io::Cursor;
use std::path::PathBuf;
use std::time::Duration;
use tokio::io::AsyncRead;

pub struct ToolBody {
    pub length: Option<u64>,
    pub max_length: Option<u64>,
    pub deadline: Option<tokio::time::Instant>,
    pub reader: Box<dyn AsyncRead + Send + Unpin>,
    pub source: String,
}

impl ToolBody {
    pub fn bytes(bytes: Vec<u8>, source: impl Into<String>) -> Self {
        Self {
            length: Some(bytes.len() as u64),
            max_length: None,
            deadline: None,
            reader: Box::new(Cursor::new(bytes)),
            source: source.into(),
        }
    }

    pub fn reader(
        reader: impl AsyncRead + Send + Unpin + 'static,
        length: Option<u64>,
        max_length: Option<u64>,
        source: impl Into<String>,
    ) -> Self {
        Self {
            length,
            max_length,
            deadline: None,
            reader: Box::new(reader),
            source: source.into(),
        }
    }
}

impl fmt::Debug for ToolBody {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ToolBody")
            .field("length", &self.length)
            .field("max_length", &self.max_length)
            .field("deadline", &self.deadline)
            .field("source", &self.source)
            .finish_non_exhaustive()
    }
}

#[derive(Debug)]
pub struct ToolOutput {
    pub data: Value,
    pub body: Option<ToolBody>,
}

impl ToolOutput {
    pub fn json(data: Value) -> Self {
        Self { data, body: None }
    }

    pub fn with_body(data: Value, body: ToolBody) -> Self {
        Self {
            data,
            body: Some(body),
        }
    }
}

#[async_trait]
pub trait Tool: Send + Sync {
    fn definition(&self) -> ToolDefinition;
    async fn execute(&self, args: Value) -> Result<ToolOutput, String>;

    fn request_body_limit(&self, _args: &Value) -> Result<usize, String> {
        Err(format!(
            "{} does not accept a request body",
            self.definition().name
        ))
    }

    fn timeout(&self, _args: &Value) -> Option<Duration> {
        None
    }

    async fn execute_with_body(
        &self,
        args: Value,
        body: Option<Vec<u8>>,
    ) -> Result<ToolOutput, String> {
        if body.is_some() {
            return Err(format!(
                "{} does not accept a request body",
                self.definition().name
            ));
        }
        self.execute(args).await
    }
}

/// Create all tools with the given workspace
pub fn all_tools_with_workspace(workspace: PathBuf) -> Vec<Box<dyn Tool>> {
    all_tools_with_workspace_for_device(workspace, "local".to_string())
}

/// Create all tools for a connected device driver.
pub fn all_tools_with_workspace_for_device(
    workspace: PathBuf,
    device_id: String,
) -> Vec<Box<dyn Tool>> {
    vec![
        Box::new(ShellTool::new(workspace.clone())),
        Box::new(ReadTool::new(workspace.clone())),
        Box::new(WriteTool::new(workspace.clone())),
        Box::new(DeleteTool::new(workspace.clone())),
        Box::new(EditTool::new(workspace.clone())),
        Box::new(CopyTool::new(workspace.clone(), device_id)),
        Box::new(NetFetchTool::new()),
        Box::new(SearchTool::new(workspace)),
    ]
}
