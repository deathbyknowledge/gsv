use crate::protocol::ToolDefinition;
use crate::tools::Tool;
use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
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

    async fn execute(&self, args: Value) -> Result<Value, String> {
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

        // Parse include pattern if provided
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
            let path = entry.path();

            // Apply include filter
            if let Some(ref glob_pattern) = include_glob {
                let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                if !glob_pattern.matches(file_name) {
                    continue;
                }
            }

            // Skip binary files (simple heuristic)
            if let Ok(content) = fs::read_to_string(path) {
                for (line_num, line) in content.lines().enumerate() {
                    if line.contains(&query) {
                        matches.push(SearchMatch {
                            path: path.display().to_string(),
                            line: line_num + 1,
                            content: line.chars().take(200).collect(), // Truncate long lines
                        });

                        // Limit total matches
                        if matches.len() >= 100 {
                            return Ok(json!({
                                "ok": true,
                                "matches": matches,
                                "count": matches.len(),
                                "truncated": true
                            }));
                        }
                    }
                }
            }
        }

        Ok(json!({
            "ok": true,
            "matches": matches,
            "count": matches.len()
        }))
    }
}
