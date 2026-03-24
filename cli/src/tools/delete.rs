use crate::protocol::ToolDefinition;
use crate::tools::Tool;
use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;

pub struct DeleteTool {
    workspace: PathBuf,
}

impl DeleteTool {
    pub fn new(workspace: PathBuf) -> Self {
        Self { workspace }
    }

    fn resolve_path(&self, path: &str) -> PathBuf {
        let path = PathBuf::from(path);
        if path.is_absolute() {
            path
        } else {
            self.workspace.join(path)
        }
    }
}

#[derive(Deserialize)]
struct DeleteArgs {
    path: String,
}

#[async_trait]
impl Tool for DeleteTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: "Delete".to_string(),
            description:
                "Delete a file or directory. Paths are relative to the workspace unless absolute."
                    .to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Path to the file or directory to delete"
                    }
                },
                "required": ["path"]
            }),
        }
    }

    async fn execute(&self, args: Value) -> Result<Value, String> {
        let args: DeleteArgs =
            serde_json::from_value(args).map_err(|e| format!("Invalid arguments: {}", e))?;

        let resolved = self.resolve_path(&args.path);
        let metadata = fs::metadata(&resolved)
            .map_err(|e| format!("Failed to delete '{}': {}", resolved.display(), e))?;

        if metadata.is_dir() {
            fs::remove_dir_all(&resolved)
                .map_err(|e| format!("Failed to delete '{}': {}", resolved.display(), e))?;
        } else {
            fs::remove_file(&resolved)
                .map_err(|e| format!("Failed to delete '{}': {}", resolved.display(), e))?;
        }

        Ok(json!({
            "ok": true,
            "path": resolved.display().to_string()
        }))
    }
}
