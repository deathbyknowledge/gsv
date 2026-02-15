// Integration tests for CLI tools

#[tokio::test]
async fn test_bash_tool_execution() {
    use gsv::tools::{BashTool, Tool};
    use serde_json::json;

    let workspace = std::env::temp_dir();
    let tool = BashTool::new(workspace.clone());

    // Test definition
    let def = tool.definition();
    assert_eq!(def.name, "Bash");

    // Test simple command
    let result = tool
        .execute(json!({
            "command": "echo hello"
        }))
        .await
        .unwrap();

    assert_eq!(result["status"], "completed");
    assert_eq!(result["exitCode"], 0);
    assert!(result["output"].as_str().unwrap().contains("hello"));
}

#[tokio::test]
async fn test_bash_tool_workdir() {
    use gsv::tools::{BashTool, Tool};
    use serde_json::json;

    let workspace = std::env::temp_dir();
    let tool = BashTool::new(workspace.clone());

    // Test with custom workdir
    let result = tool
        .execute(json!({
            "command": "pwd",
            "workdir": "/tmp"
        }))
        .await
        .unwrap();

    assert_eq!(result["status"], "completed");
    assert_eq!(result["exitCode"], 0);
    assert!(
        result["output"].as_str().unwrap().contains("/tmp")
            || result["output"].as_str().unwrap().contains("/private/tmp")
    ); // macOS
}

#[tokio::test]
async fn test_bash_background_returns_session_id() {
    use gsv::tools::{BashTool, ProcessTool, Tool};
    use serde_json::json;

    let workspace = std::env::temp_dir();
    let bash = BashTool::new(workspace.clone());
    let process = ProcessTool::new();

    let start = bash
        .execute(json!({
            "command": "sleep 1; echo async-finished",
            "background": true
        }))
        .await
        .unwrap();

    assert_eq!(start["status"], "running");
    let session_id = start["sessionId"].as_str().unwrap().to_string();
    assert!(!session_id.is_empty());

    let listed = process.execute(json!({ "action": "list" })).await.unwrap();
    let sessions = listed["sessions"].as_array().unwrap();
    assert!(sessions
        .iter()
        .any(|entry| entry["sessionId"] == session_id));
}

#[tokio::test]
async fn test_process_tool_poll_log_and_kill_background_session() {
    use gsv::tools::{BashTool, ProcessTool, Tool};
    use serde_json::json;

    let workspace = std::env::temp_dir();
    let bash = BashTool::new(workspace.clone());
    let process = ProcessTool::new();

    let start = bash
        .execute(json!({
            "command": "while true; do echo heartbeat; sleep 0.2; done",
            "background": true
        }))
        .await
        .unwrap();
    assert_eq!(start["status"], "running");

    let session_id = start["sessionId"].as_str().unwrap().to_string();

    let poll_running = process
        .execute(json!({
            "action": "poll",
            "sessionId": session_id.clone()
        }))
        .await
        .unwrap();
    assert_eq!(poll_running["running"], true);

    let mut saw_heartbeat = false;
    let mut last_log = String::new();
    for _ in 0..80 {
        let log = process
            .execute(json!({
                "action": "log",
                "sessionId": session_id.clone()
            }))
            .await
            .unwrap();
        let output = log["log"].as_str().unwrap_or("");
        last_log = output.to_string();
        if output.contains("heartbeat") {
            saw_heartbeat = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }

    let kill = process
        .execute(json!({
            "action": "kill",
            "sessionId": session_id.clone()
        }))
        .await
        .unwrap();
    assert_eq!(kill["status"], "running");

    for _ in 0..80 {
        let poll = process
            .execute(json!({
                "action": "poll",
                "sessionId": session_id.clone()
            }))
            .await
            .unwrap();
        if poll["running"] == false {
            assert_ne!(poll["status"], "running");
            assert!(
                saw_heartbeat,
                "expected heartbeat in process log before kill, last log: {last_log}"
            );
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }

    panic!("background session did not exit after kill");
}

#[tokio::test]
async fn test_read_tool() {
    use gsv::tools::{ReadTool, Tool};
    use serde_json::json;
    use std::io::Write;

    let workspace = std::env::temp_dir();
    let tool = ReadTool::new(workspace.clone());

    // Create a test file
    let test_file = workspace.join("gsv_test_read.txt");
    {
        let mut f = std::fs::File::create(&test_file).unwrap();
        writeln!(f, "line 1").unwrap();
        writeln!(f, "line 2").unwrap();
        writeln!(f, "line 3").unwrap();
    }

    // Test reading
    let result = tool
        .execute(json!({
            "path": test_file.to_str().unwrap()
        }))
        .await
        .unwrap();

    let content = result["content"].as_str().unwrap();
    assert!(content.contains("line 1"));
    assert!(content.contains("line 2"));
    assert_eq!(result["lines"], 3);

    // Cleanup
    std::fs::remove_file(&test_file).ok();
}

#[tokio::test]
async fn test_read_tool_with_offset_limit() {
    use gsv::tools::{ReadTool, Tool};
    use serde_json::json;
    use std::io::Write;

    let workspace = std::env::temp_dir();
    let tool = ReadTool::new(workspace.clone());

    // Create a test file
    let test_file = workspace.join("gsv_test_read_offset.txt");
    {
        let mut f = std::fs::File::create(&test_file).unwrap();
        for i in 1..=10 {
            writeln!(f, "line {}", i).unwrap();
        }
    }

    // Test with offset and limit
    let result = tool
        .execute(json!({
            "path": test_file.to_str().unwrap(),
            "offset": 2,
            "limit": 3
        }))
        .await
        .unwrap();

    let content = result["content"].as_str().unwrap();
    assert!(content.contains("line 3"));
    assert!(content.contains("line 4"));
    assert!(content.contains("line 5"));
    assert!(!content.contains("line 1"));
    assert!(!content.contains("line 6"));
    assert_eq!(result["lines"], 3);

    // Cleanup
    std::fs::remove_file(&test_file).ok();
}

#[tokio::test]
async fn test_write_tool() {
    use gsv::tools::{Tool, WriteTool};
    use serde_json::json;

    let workspace = std::env::temp_dir();
    let tool = WriteTool::new(workspace.clone());

    let test_file = workspace.join("gsv_test_write.txt");

    // Test writing - returns "bytes" not "success"
    let result = tool
        .execute(json!({
            "path": test_file.to_str().unwrap(),
            "content": "test content\nline 2"
        }))
        .await
        .unwrap();

    assert_eq!(result["bytes"], 19); // "test content\nline 2" = 19 bytes

    // Verify content
    let content = std::fs::read_to_string(&test_file).unwrap();
    assert_eq!(content, "test content\nline 2");

    // Cleanup
    std::fs::remove_file(&test_file).ok();
}

#[tokio::test]
async fn test_edit_tool() {
    use gsv::tools::{EditTool, Tool};
    use serde_json::json;
    use std::io::Write;

    let workspace = std::env::temp_dir();
    let tool = EditTool::new(workspace.clone());

    // Create a test file
    let test_file = workspace.join("gsv_test_edit.txt");
    {
        let mut f = std::fs::File::create(&test_file).unwrap();
        writeln!(f, "hello world").unwrap();
        writeln!(f, "foo bar").unwrap();
    }

    // Test editing - returns "path" and "replacements"
    let result = tool
        .execute(json!({
            "path": test_file.to_str().unwrap(),
            "oldString": "hello world",
            "newString": "goodbye world"
        }))
        .await
        .unwrap();

    assert_eq!(result["replacements"], 1);

    // Verify content
    let content = std::fs::read_to_string(&test_file).unwrap();
    assert!(content.contains("goodbye world"));
    assert!(!content.contains("hello world"));

    // Cleanup
    std::fs::remove_file(&test_file).ok();
}

#[tokio::test]
async fn test_glob_tool() {
    use gsv::tools::{GlobTool, Tool};
    use serde_json::json;

    let workspace = std::env::temp_dir().join("gsv_glob_test");
    std::fs::create_dir_all(&workspace).unwrap();

    let tool = GlobTool::new(workspace.clone());

    // Create test files
    std::fs::File::create(workspace.join("test1.txt")).unwrap();
    std::fs::File::create(workspace.join("test2.txt")).unwrap();
    std::fs::File::create(workspace.join("other.md")).unwrap();

    // Test globbing
    let result = tool
        .execute(json!({
            "pattern": "*.txt",
            "path": workspace.to_str().unwrap()
        }))
        .await
        .unwrap();

    let matches = result["matches"].as_array().unwrap();
    assert_eq!(matches.len(), 2);

    // Cleanup
    std::fs::remove_dir_all(&workspace).ok();
}

#[tokio::test]
async fn test_grep_tool() {
    use gsv::tools::{GrepTool, Tool};
    use serde_json::json;
    use std::io::Write;

    let workspace = std::env::temp_dir().join("gsv_grep_test");
    std::fs::create_dir_all(&workspace).unwrap();

    let tool = GrepTool::new(workspace.clone());

    // Create test files
    {
        let mut f = std::fs::File::create(workspace.join("file1.txt")).unwrap();
        writeln!(f, "hello world").unwrap();
        writeln!(f, "foo bar").unwrap();
    }
    {
        let mut f = std::fs::File::create(workspace.join("file2.txt")).unwrap();
        writeln!(f, "hello again").unwrap();
        writeln!(f, "baz qux").unwrap();
    }

    // Test grepping
    let result = tool
        .execute(json!({
            "pattern": "hello",
            "path": workspace.to_str().unwrap()
        }))
        .await
        .unwrap();

    let matches = result["matches"].as_array().unwrap();
    assert_eq!(matches.len(), 2); // Found in both files

    // Cleanup
    std::fs::remove_dir_all(&workspace).ok();
}

#[test]
fn test_all_tools_with_workspace() {
    use gsv::tools::all_tools_with_workspace;

    let workspace = std::env::temp_dir();
    let tools = all_tools_with_workspace(workspace);

    // Should have 7 tools: Bash, Process, Read, Write, Edit, Glob, Grep
    assert_eq!(tools.len(), 7);

    let names: Vec<_> = tools.iter().map(|t| t.definition().name).collect();
    assert!(names.contains(&"Bash".to_string()));
    assert!(names.contains(&"Process".to_string()));
    assert!(names.contains(&"Read".to_string()));
    assert!(names.contains(&"Write".to_string()));
    assert!(names.contains(&"Edit".to_string()));
    assert!(names.contains(&"Glob".to_string()));
    assert!(names.contains(&"Grep".to_string()));
}

#[test]
fn test_config_load_default() {
    use gsv::config::CliConfig;

    // Should return default config when file doesn't exist
    let cfg = CliConfig::load();

    assert_eq!(cfg.default_session(), "agent:main:cli:dm:main");
    // Default URL is ws://localhost:8787/ws
    let url = cfg.gateway_url();
    assert!(url.starts_with("ws://") || url.starts_with("wss://"));
}

#[test]
fn test_config_sample() {
    use gsv::config::sample_config;

    let sample = sample_config();

    // Should contain expected sections
    assert!(sample.contains("[gateway]"));
    assert!(sample.contains("[r2]"));
    assert!(sample.contains("[session]"));
}
