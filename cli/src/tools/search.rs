use crate::protocol::ToolDefinition;
use crate::tools::{Tool, ToolOutput};
use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use tokio_util::sync::CancellationToken;
use walkdir::WalkDir;

pub struct SearchTool {
    workspace: PathBuf,
}

impl SearchTool {
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

    async fn search(
        &self,
        args: Value,
        cancellation: &CancellationToken,
    ) -> Result<ToolOutput, String> {
        let workspace = self.workspace.clone();
        let cancellation = cancellation.clone();
        tokio::task::spawn_blocking(move || Self { workspace }.search_blocking(args, &cancellation))
            .await
            .map_err(|error| format!("Search task failed: {}", error))?
    }

    fn search_blocking(
        &self,
        args: Value,
        cancellation: &CancellationToken,
    ) -> Result<ToolOutput, String> {
        if cancellation.is_cancelled() {
            return Err("Search cancelled".to_string());
        }
        let args: SearchArgs =
            serde_json::from_value(args).map_err(|e| format!("Invalid arguments: {}", e))?;

        let query = args
            .query
            .or(args.pattern)
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "Search query is required.".to_string())?;

        let base_path = args
            .path
            .map(|p| self.resolve_path(&p))
            .unwrap_or_else(|| self.workspace.clone());

        let include_glob = args
            .include
            .as_ref()
            .and_then(|inc| glob::Pattern::new(inc).ok());

        let mut matches: Vec<SearchMatch> = Vec::new();

        for entry in WalkDir::new(&base_path)
            .follow_links(true)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_file())
        {
            if cancellation.is_cancelled() {
                return Err("Search cancelled".to_string());
            }
            let path = entry.path();

            if let Some(ref glob_pattern) = include_glob {
                let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                if !glob_pattern.matches(file_name) {
                    continue;
                }
            }

            if let Some(content) = read_text(path, cancellation)? {
                for (line_num, line) in content.lines().enumerate() {
                    if cancellation.is_cancelled() {
                        return Err("Search cancelled".to_string());
                    }
                    if line.contains(&query) {
                        matches.push(SearchMatch {
                            path: path.display().to_string(),
                            line: line_num + 1,
                            content: line.chars().take(200).collect(),
                        });

                        if matches.len() >= 100 {
                            return Ok(ToolOutput::json(json!({
                                "ok": true,
                                "matches": matches,
                                "count": matches.len(),
                                "truncated": true
                            })));
                        }
                    }
                }
            }
        }

        Ok(ToolOutput::json(json!({
            "ok": true,
            "matches": matches,
            "count": matches.len()
        })))
    }
}

fn read_text(path: &Path, cancellation: &CancellationToken) -> Result<Option<String>, String> {
    let mut file = match fs::File::open(path) {
        Ok(file) => file,
        Err(_) => return Ok(None),
    };
    let mut bytes = Vec::new();
    let mut chunk = [0; 64 * 1024];
    loop {
        if cancellation.is_cancelled() {
            return Err("Search cancelled".to_string());
        }
        match file.read(&mut chunk) {
            Ok(0) => return Ok(String::from_utf8(bytes).ok()),
            Ok(read) => bytes.extend_from_slice(&chunk[..read]),
            Err(_) => return Ok(None),
        }
    }
}

#[derive(Deserialize)]
struct SearchArgs {
    #[serde(default)]
    query: Option<String>,
    #[serde(default)]
    pattern: Option<String>,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    include: Option<String>,
}

#[derive(serde::Serialize)]
struct SearchMatch {
    path: String,
    line: usize,
    content: String,
}

#[async_trait]
impl Tool for SearchTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: "Search".to_string(),
            description: "Search file contents using plain text. Paths are relative to the workspace unless absolute.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Plain text to search for"
                    },
                    "path": {
                        "type": "string",
                        "description": "Directory to search in (default: workspace root)"
                    },
                    "include": {
                        "type": "string",
                        "description": "File pattern to include (e.g., '*.md', '*.{rs,ts}')"
                    }
                },
                "required": ["query"]
            }),
        }
    }

    async fn execute(&self, args: Value) -> Result<ToolOutput, String> {
        self.search(args, &CancellationToken::new()).await
    }

    async fn execute_with_body_cancellable(
        &self,
        args: Value,
        body: Option<Vec<u8>>,
        cancellation: &CancellationToken,
    ) -> Result<ToolOutput, String> {
        if body.is_some() {
            return Err("Search does not accept a request body".to_string());
        }
        self.search(args, cancellation).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn search_observes_request_cancellation() {
        let workspace = std::env::temp_dir().join(format!("gsv-search-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&workspace).await.unwrap();
        tokio::fs::write(workspace.join("file.txt"), "needle")
            .await
            .unwrap();
        let cancellation = CancellationToken::new();
        cancellation.cancel();

        let error = SearchTool::new(workspace.clone())
            .execute_with_body_cancellable(json!({ "query": "needle" }), None, &cancellation)
            .await
            .unwrap_err();

        assert_eq!(error, "Search cancelled");
        tokio::fs::remove_dir_all(workspace).await.unwrap();
    }
}
