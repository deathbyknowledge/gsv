use std::fs::Metadata;
use std::time::UNIX_EPOCH;

pub fn file_revision(metadata: &Metadata) -> String {
    let modified_nanos = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    format!("W/\"{:x}-{:x}\"", metadata.len(), modified_nanos)
}
