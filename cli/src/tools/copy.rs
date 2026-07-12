use crate::protocol::ToolDefinition;
use crate::tools::{Tool, ToolOutput};
use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub struct CopyTool {
    workspace: PathBuf,
    device_id: String,
}

impl CopyTool {
    pub fn new(workspace: PathBuf, device_id: String) -> Self {
        Self {
            workspace,
            device_id,
        }
    }

    fn resolve_path(&self, path: &str) -> PathBuf {
        let path = PathBuf::from(path);
        if path.is_absolute() {
            path
        } else {
            self.workspace.join(path)
        }
    }

    fn validate_endpoint(&self, endpoint: &CopyEndpoint) -> Result<(), String> {
        if let Some(target) = endpoint.target.as_deref() {
            if !target.is_empty() && target != self.device_id && target != "local" {
                return Err(format!(
                    "fs.copy on device '{}' only accepts local endpoints, got target '{}'",
                    self.device_id, target
                ));
            }
        }
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CopyArgs {
    source: CopyEndpoint,
    destination: CopyEndpoint,
}

#[derive(Deserialize)]
struct CopyEndpoint {
    #[serde(default)]
    target: Option<String>,
    path: String,
}

#[async_trait]
impl Tool for CopyTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: "Copy".to_string(),
            description:
                "Copy a file on this target. Paths are relative to the workspace unless absolute."
                    .to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "source": {
                        "type": "object",
                        "properties": {
                            "target": { "type": "string" },
                            "path": { "type": "string" }
                        },
                        "required": ["path"]
                    },
                    "destination": {
                        "type": "object",
                        "properties": {
                            "target": { "type": "string" },
                            "path": { "type": "string" }
                        },
                        "required": ["path"]
                    }
                },
                "required": ["source", "destination"]
            }),
        }
    }

    async fn execute(&self, args: Value) -> Result<ToolOutput, String> {
        let args: CopyArgs =
            serde_json::from_value(args).map_err(|e| format!("Invalid arguments: {}", e))?;

        self.validate_endpoint(&args.source)?;
        self.validate_endpoint(&args.destination)?;

        let source = self.resolve_path(&args.source.path);
        let mut destination = self.resolve_path(&args.destination.path);

        let source_metadata = tokio::fs::metadata(&source)
            .await
            .map_err(|e| format!("Failed to stat source '{}': {}", source.display(), e))?;
        if source_metadata.is_dir() {
            return Err(format!(
                "Failed to copy '{}': directories are not supported yet",
                source.display()
            ));
        }

        if let Ok(destination_metadata) = tokio::fs::metadata(&destination).await {
            if destination_metadata.is_dir() {
                let file_name = source.file_name().ok_or_else(|| {
                    format!("Failed to resolve basename for '{}'", source.display())
                })?;
                destination = destination.join(file_name);
            }
        }

        if let Some(parent) = destination.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("Failed to create '{}': {}", parent.display(), e))?;
        }

        let bytes = tokio::fs::copy(&source, &destination).await.map_err(|e| {
            format!(
                "Failed to copy '{}' to '{}': {}",
                source.display(),
                destination.display(),
                e
            )
        })?;
        let content_type = mime_guess::from_path(&source)
            .first()
            .map(|mime| mime.essence_str().to_string());

        Ok(ToolOutput::json(json!({
            "ok": true,
            "source": {
                "target": self.device_id,
                "path": display_path(&source)
            },
            "destination": {
                "target": self.device_id,
                "path": display_path(&destination)
            },
            "size": bytes,
            "contentType": content_type
        })))
    }
}

fn display_path(path: &Path) -> String {
    path.display().to_string()
}

#[cfg(test)]
mod tests {
    use super::CopyTool;
    use crate::tools::Tool;
    use serde_json::json;
    use std::path::PathBuf;

    fn test_root() -> PathBuf {
        std::env::temp_dir().join(format!("gsv-copy-test-{}", uuid::Uuid::new_v4()))
    }

    #[tokio::test]
    async fn copies_file_to_file() {
        let root = test_root();
        tokio::fs::create_dir_all(&root).await.unwrap();
        tokio::fs::write(root.join("source.txt"), "hello")
            .await
            .unwrap();

        let tool = CopyTool::new(root.clone(), "device-a".to_string());
        let result = tool
            .execute(json!({
                "source": { "path": "source.txt" },
                "destination": { "path": "nested/dest.txt" }
            }))
            .await
            .unwrap();

        assert_eq!(result.data["ok"], true);
        assert_eq!(
            tokio::fs::read_to_string(root.join("nested/dest.txt"))
                .await
                .unwrap(),
            "hello"
        );

        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    async fn copies_file_into_directory() {
        let root = test_root();
        tokio::fs::create_dir_all(root.join("dest")).await.unwrap();
        tokio::fs::write(root.join("source.txt"), "hello")
            .await
            .unwrap();

        let tool = CopyTool::new(root.clone(), "device-a".to_string());
        tool.execute(json!({
            "source": { "path": "source.txt" },
            "destination": { "path": "dest" }
        }))
        .await
        .unwrap();

        assert_eq!(
            tokio::fs::read_to_string(root.join("dest/source.txt"))
                .await
                .unwrap(),
            "hello"
        );

        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    async fn rejects_non_local_endpoints() {
        let root = test_root();
        tokio::fs::create_dir_all(&root).await.unwrap();
        tokio::fs::write(root.join("source.txt"), "hello")
            .await
            .unwrap();

        let tool = CopyTool::new(root.clone(), "device-a".to_string());
        let error = tool
            .execute(json!({
                "source": { "target": "gsv", "path": "source.txt" },
                "destination": { "path": "dest.txt" }
            }))
            .await
            .unwrap_err();

        assert!(error.contains("only accepts local endpoints"));

        tokio::fs::remove_dir_all(root).await.unwrap();
    }
}
