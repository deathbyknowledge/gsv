use crate::protocol::ToolDefinition;
use crate::tools::{Tool, ToolOutput};
use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use tokio_util::sync::CancellationToken;
use walkdir::WalkDir;

const MAX_MATCHES: usize = 100;
const MAX_SEARCH_FILES: usize = 25_000;
const MAX_SEARCH_FILE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_SEARCH_TOTAL_BYTES: u64 = 128 * 1024 * 1024;

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
        let mut scanned_bytes = 0_u64;
        let mut truncated = false;

        for (scanned_files, entry) in WalkDir::new(&base_path)
            .follow_links(false)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_file())
            .enumerate()
        {
            if cancellation.is_cancelled() {
                return Err("Search cancelled".to_string());
            }
            if scanned_files >= MAX_SEARCH_FILES {
                truncated = true;
                break;
            }
            let path = entry.path();
            if let Some(pattern) = &include_glob {
                let file_name = path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("");
                if !pattern.matches(file_name) {
                    continue;
                }
            }

            let remaining_bytes = MAX_SEARCH_TOTAL_BYTES.saturating_sub(scanned_bytes);
            if remaining_bytes == 0 {
                truncated = true;
                break;
            }
            let result = search_text_file(
                path,
                &query,
                cancellation,
                remaining_bytes.min(MAX_SEARCH_FILE_BYTES),
                MAX_MATCHES - matches.len(),
            )?;
            scanned_bytes = scanned_bytes.saturating_add(result.bytes_read);
            truncated |= result.truncated;
            matches.extend(result.matches);
            if matches.len() >= MAX_MATCHES {
                truncated = true;
                break;
            }
        }

        Ok(search_output(matches, truncated))
    }
}

struct FileSearchResult {
    matches: Vec<SearchMatch>,
    bytes_read: u64,
    truncated: bool,
}

fn search_text_file(
    path: &Path,
    query: &str,
    cancellation: &CancellationToken,
    max_bytes: u64,
    max_matches: usize,
) -> Result<FileSearchResult, String> {
    let empty = |bytes_read, truncated| FileSearchResult {
        matches: Vec::new(),
        bytes_read,
        truncated,
    };

    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(_) => return Ok(empty(0, false)),
    };
    if file
        .metadata()
        .map(|metadata| metadata.len() > max_bytes)
        .unwrap_or(false)
    {
        return Ok(empty(0, true));
    }

    let mut reader = BufReader::new(file.take(max_bytes.saturating_add(1)));
    let mut line = String::new();
    let mut line_number = 0_usize;
    let mut bytes_read = 0_u64;
    let mut matches = Vec::new();
    loop {
        if cancellation.is_cancelled() {
            return Err("Search cancelled".to_string());
        }

        line.clear();
        let read = match reader.read_line(&mut line) {
            Ok(read) => read,
            Err(error) if error.kind() == std::io::ErrorKind::InvalidData => {
                return Ok(empty(bytes_read, false));
            }
            Err(_) => return Ok(empty(bytes_read, false)),
        };
        if read == 0 {
            return Ok(FileSearchResult {
                matches,
                bytes_read,
                truncated: false,
            });
        }
        bytes_read = bytes_read.saturating_add(read as u64);
        if bytes_read > max_bytes {
            return Ok(FileSearchResult {
                matches,
                bytes_read: max_bytes,
                truncated: true,
            });
        }
        if line.as_bytes().contains(&0) {
            return Ok(empty(bytes_read, false));
        }

        line_number += 1;
        if line.contains(query) {
            matches.push(SearchMatch {
                path: path.display().to_string(),
                line: line_number,
                content: line
                    .trim_end_matches(['\r', '\n'])
                    .chars()
                    .take(200)
                    .collect(),
            });
            if matches.len() >= max_matches {
                return Ok(FileSearchResult {
                    matches,
                    bytes_read,
                    truncated: true,
                });
            }
        }
    }
}

fn search_output(matches: Vec<SearchMatch>, truncated: bool) -> ToolOutput {
    let count = matches.len();
    let mut output = json!({
        "ok": true,
        "matches": matches,
        "count": count,
    });
    if truncated {
        output["truncated"] = json!(true);
    }
    ToolOutput::json(output)
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
            .execute_with_body_cancellable(
                json!({ "query": "needle", "include": "*.md" }),
                None,
                &cancellation,
            )
            .await
            .unwrap_err();

        assert_eq!(error, "Search cancelled");
        tokio::fs::remove_dir_all(workspace).await.unwrap();
    }

    #[tokio::test]
    async fn search_skips_binary_and_oversized_files() {
        let workspace = std::env::temp_dir().join(format!("gsv-search-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&workspace).await.unwrap();
        tokio::fs::write(workspace.join("text.txt"), "needle\n")
            .await
            .unwrap();
        tokio::fs::write(workspace.join("binary.bin"), b"needle\0binary")
            .await
            .unwrap();
        let oversized = fs::File::create(workspace.join("oversized.txt")).unwrap();
        oversized.set_len(MAX_SEARCH_FILE_BYTES + 1).unwrap();

        let output = SearchTool::new(workspace.clone())
            .execute(json!({ "query": "needle" }))
            .await
            .unwrap();

        assert_eq!(output.data["count"], 1);
        assert_eq!(
            output.data["matches"][0]["path"],
            workspace.join("text.txt").display().to_string()
        );
        assert_eq!(output.data["truncated"], true);
        tokio::fs::remove_dir_all(workspace).await.unwrap();
    }
}
