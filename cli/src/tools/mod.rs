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
use std::path::PathBuf;

#[async_trait]
pub trait Tool: Send + Sync {
    fn definition(&self) -> ToolDefinition;
    async fn execute(&self, args: Value) -> Result<Value, String>;
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
