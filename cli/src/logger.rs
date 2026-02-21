use serde_json::json;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

const DEFAULT_NODE_LOG_MAX_BYTES: u64 = 10 * 1024 * 1024;
const DEFAULT_NODE_LOG_MAX_FILES: usize = 5;

pub fn node_log_path() -> Result<PathBuf, Box<dyn std::error::Error>> {
    let home = dirs::home_dir().ok_or("Could not determine home directory")?;
    Ok(home.join(".gsv").join("logs").join("node.log"))
}

fn parse_env_u64(name: &str) -> Option<u64> {
    std::env::var(name)
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|v| *v > 0)
}

fn parse_env_usize(name: &str) -> Option<usize> {
    std::env::var(name)
        .ok()
        .and_then(|v| v.trim().parse::<usize>().ok())
        .filter(|v| *v > 0)
}

pub fn node_log_max_bytes() -> u64 {
    parse_env_u64("GSV_NODE_LOG_MAX_BYTES").unwrap_or(DEFAULT_NODE_LOG_MAX_BYTES)
}

pub fn node_log_max_files() -> usize {
    parse_env_usize("GSV_NODE_LOG_MAX_FILES").unwrap_or(DEFAULT_NODE_LOG_MAX_FILES)
}

pub fn rotated_log_path(base: &PathBuf, index: usize) -> PathBuf {
    PathBuf::from(format!("{}.{}", base.to_string_lossy(), index))
}

struct NodeLoggerInner {
    path: PathBuf,
    file: fs::File,
    current_size: u64,
    max_bytes: u64,
    max_files: usize,
}

impl NodeLoggerInner {
    fn open(
        path: &PathBuf,
        max_bytes: u64,
        max_files: usize,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }

        let file = OpenOptions::new().create(true).append(true).open(path)?;
        let current_size = file.metadata().map(|m| m.len()).unwrap_or(0);

        Ok(Self {
            path: path.clone(),
            file,
            current_size,
            max_bytes,
            max_files: max_files.max(1),
        })
    }

    fn rotate_if_needed(&mut self, incoming: usize) -> Result<(), Box<dyn std::error::Error>> {
        let incoming = incoming as u64;
        if self.current_size + incoming <= self.max_bytes {
            return Ok(());
        }

        self.file.flush()?;

        let oldest = rotated_log_path(&self.path, self.max_files);
        if oldest.exists() {
            let _ = fs::remove_file(&oldest);
        }

        if self.max_files > 1 {
            for i in (1..self.max_files).rev() {
                let src = rotated_log_path(&self.path, i);
                if src.exists() {
                    let dst = rotated_log_path(&self.path, i + 1);
                    let _ = fs::rename(&src, &dst);
                }
            }
        }

        if self.path.exists() {
            let _ = fs::rename(&self.path, rotated_log_path(&self.path, 1));
        }

        self.file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&self.path)?;
        self.current_size = 0;

        Ok(())
    }

    fn write_line(&mut self, line: &str) -> Result<(), Box<dyn std::error::Error>> {
        let incoming = line.len() + 1;
        self.rotate_if_needed(incoming)?;
        self.file.write_all(line.as_bytes())?;
        self.file.write_all(b"\n")?;
        self.file.flush()?;
        self.current_size += incoming as u64;
        Ok(())
    }
}

#[derive(Clone)]
pub struct NodeLogger {
    inner: Arc<Mutex<NodeLoggerInner>>,
    node_id: String,
    workspace: String,
}

impl NodeLogger {
    pub fn new(node_id: &str, workspace: &PathBuf) -> Result<Self, Box<dyn std::error::Error>> {
        let path = node_log_path()?;
        let inner = NodeLoggerInner::open(&path, node_log_max_bytes(), node_log_max_files())?;
        Ok(Self {
            inner: Arc::new(Mutex::new(inner)),
            node_id: node_id.to_string(),
            workspace: workspace.display().to_string(),
        })
    }

    pub fn with_path(
        node_id: &str,
        workspace: &str,
        path: &PathBuf,
        max_bytes: u64,
        max_files: usize,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        let inner = NodeLoggerInner::open(path, max_bytes, max_files)?;
        Ok(Self {
            inner: Arc::new(Mutex::new(inner)),
            node_id: node_id.to_string(),
            workspace: workspace.to_string(),
        })
    }

    pub fn info(&self, event: &str, fields: serde_json::Value) {
        self.log("INFO", event, fields);
    }

    pub fn warn(&self, event: &str, fields: serde_json::Value) {
        self.log("WARN", event, fields);
    }

    pub fn error(&self, event: &str, fields: serde_json::Value) {
        self.log("ERROR", event, fields);
    }

    pub fn log(&self, level: &str, event: &str, fields: serde_json::Value) {
        let mut obj = serde_json::Map::new();
        obj.insert(
            "ts".to_string(),
            json!(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
        );
        obj.insert("level".to_string(), json!(level));
        obj.insert("component".to_string(), json!("node"));
        obj.insert("event".to_string(), json!(event));
        obj.insert("nodeId".to_string(), json!(self.node_id));
        obj.insert("workspace".to_string(), json!(self.workspace));

        match fields {
            serde_json::Value::Object(map) => {
                for (k, v) in map {
                    obj.insert(k, v);
                }
            }
            serde_json::Value::Null => {}
            other => {
                obj.insert("data".to_string(), other);
            }
        }

        let line = serde_json::Value::Object(obj).to_string();

        if level == "ERROR" {
            eprintln!("{}", line);
        } else {
            println!("{}", line);
        }

        let mut guard = match self.inner.lock() {
            Ok(guard) => guard,
            Err(_) => {
                eprintln!("Failed to acquire node log writer lock");
                return;
            }
        };

        if let Err(err) = guard.write_line(&line) {
            eprintln!("Failed to write node log file: {}", err);
        }
    }
}
