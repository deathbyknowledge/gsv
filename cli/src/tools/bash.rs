use crate::protocol::ToolDefinition;
use crate::tools::Tool;
use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::time::Duration;
use tokio::process::Command;
use tokio::time::timeout;

pub struct BashTool {
    workspace: PathBuf,
}

impl BashTool {
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
struct BashArgs {
    command: String,
    #[serde(default)]
    workdir: Option<String>,
    #[serde(default)]
    timeout: Option<u64>,
}

#[async_trait]
impl Tool for BashTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: "Bash".to_string(),
            description: "Execute a shell command. Working directory defaults to the workspace."
                .to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "command": {
                        "type": "string",
                        "description": "The command to execute"
                    },
                    "workdir": {
                        "type": "string",
                        "description": "Working directory (default: workspace)"
                    },
                    "timeout": {
                        "type": "number",
                        "description": "Timeout in milliseconds (optional)"
                    }
                },
                "required": ["command"]
            }),
        }
    }

    async fn execute(&self, args: Value) -> Result<Value, String> {
        let args: BashArgs =
            serde_json::from_value(args).map_err(|e| format!("Invalid arguments: {}", e))?;

        let mut cmd = Command::new("sh");
        cmd.arg("-c").arg(&args.command);

        // Use provided workdir, or fall back to workspace
        let workdir = args
            .workdir
            .map(|w| self.resolve_path(&w))
            .unwrap_or_else(|| self.workspace.clone());
        cmd.current_dir(&workdir);

        // Default timeout: 5 minutes, can be overridden
        let timeout_ms = args.timeout.unwrap_or(5 * 60 * 1000);
        let timeout_duration = Duration::from_millis(timeout_ms);

        let output = match timeout(timeout_duration, cmd.output()).await {
            Ok(result) => result.map_err(|e| format!("Failed to execute: {}", e))?,
            Err(_) => {
                return Ok(json!({
                    "exitCode": -1,
                    "stdout": "",
                    "stderr": format!("Command timed out after {}ms", timeout_ms),
                    "workdir": workdir.display().to_string()
                }));
            }
        };

        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();

        Ok(json!({
            "exitCode": output.status.code().unwrap_or(-1),
            "stdout": stdout,
            "stderr": stderr,
            "workdir": workdir.display().to_string()
        }))
    }
}
