mod bash;
mod edit;
mod glob;
mod grep;
mod read;
mod write;

pub use bash::{subscribe_exec_events, BashTool, ProcessTool};
pub use edit::EditTool;
pub use glob::GlobTool;
pub use grep::GrepTool;
pub use read::ReadTool;
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
    vec![
        Box::new(BashTool::new(workspace.clone())),
        Box::new(ProcessTool::new()),
        Box::new(ReadTool::new(workspace.clone())),
        Box::new(WriteTool::new(workspace.clone())),
        Box::new(EditTool::new(workspace.clone())),
        Box::new(GlobTool::new(workspace.clone())),
        Box::new(GrepTool::new(workspace)),
    ]
}
