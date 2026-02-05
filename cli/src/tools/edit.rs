use crate::protocol::ToolDefinition;
use crate::tools::Tool;
use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;

pub struct EditTool {
    workspace: PathBuf,
}

impl EditTool {
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
#[serde(rename_all = "camelCase")]
struct EditArgs {
    path: String,
    old_string: String,
    new_string: String,
    #[serde(default)]
    replace_all: bool,
}

#[async_trait]
impl Tool for EditTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: "Edit".to_string(),
            description: "Edit a file by replacing text. Paths are relative to the workspace unless absolute.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Path to the file to edit"
                    },
                    "oldString": {
                        "type": "string",
                        "description": "The exact text to find and replace"
                    },
                    "newString": {
                        "type": "string",
                        "description": "The text to replace it with"
                    },
                    "replaceAll": {
                        "type": "boolean",
                        "description": "Replace all occurrences (default: false, replace first only)"
                    }
                },
                "required": ["path", "oldString", "newString"]
            }),
        }
    }

    async fn execute(&self, args: Value) -> Result<Value, String> {
        let args: EditArgs =
            serde_json::from_value(args).map_err(|e| format!("Invalid arguments: {}", e))?;

        let resolved = self.resolve_path(&args.path);

        let content = fs::read_to_string(&resolved)
            .map_err(|e| format!("Failed to read '{}': {}", resolved.display(), e))?;

        // Check if oldString exists
        let count = content.matches(&args.old_string).count();
        if count == 0 {
            return Err(format!("oldString not found in '{}'", resolved.display()));
        }

        // If not replace_all and multiple matches, error
        if !args.replace_all && count > 1 {
            return Err(format!(
                "oldString found {} times in '{}'. Use replaceAll: true or provide more context to make it unique.",
                count, resolved.display()
            ));
        }

        let new_content = if args.replace_all {
            content.replace(&args.old_string, &args.new_string)
        } else {
            content.replacen(&args.old_string, &args.new_string, 1)
        };

        fs::write(&resolved, &new_content)
            .map_err(|e| format!("Failed to write '{}': {}", resolved.display(), e))?;

        Ok(json!({
            "path": resolved.display().to_string(),
            "replacements": if args.replace_all { count } else { 1 }
        }))
    }
}
