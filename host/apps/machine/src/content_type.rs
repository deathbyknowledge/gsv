//! One content type for a file, however it is asked about. The first bytes
//! decide, and the extension only when the bytes say nothing. A read, a
//! transfer, a stat and a copy must agree on it, because a reference made by
//! one of them is verified by another.

use std::path::Path;
use tokio::io::{AsyncReadExt, AsyncSeekExt};

const MIME_SNIFF_BYTES: u64 = 8192;

/// Reads the leading bytes a sniff needs and leaves the file at its start.
pub async fn sniff_header(file: &mut tokio::fs::File) -> std::io::Result<Vec<u8>> {
    let mut header = Vec::new();
    (&mut *file)
        .take(MIME_SNIFF_BYTES)
        .read_to_end(&mut header)
        .await?;
    file.rewind().await?;
    Ok(header)
}

/// The content type the bytes say, else the one the extension says.
pub fn content_type_for(header: &[u8], path: &Path) -> &'static str {
    infer::get(header)
        .map(|kind| kind.mime_type())
        .unwrap_or_else(|| content_type_from_extension(path))
}

pub fn content_type_from_extension(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("md") => "text/markdown",
        Some("json" | "map") => "application/json",
        Some("yaml" | "yml") => "application/yaml",
        Some("xml") => "application/xml",
        Some("toml") => "application/toml",
        Some("js" | "cjs" | "mjs" | "jsx") => "application/javascript",
        Some("ts" | "tsx") => "application/typescript",
        Some("html" | "htm") => "text/html",
        Some("css") => "text/css",
        Some("txt" | "log") => "text/plain",
        Some("csv") => "text/csv",
        Some("sh") => "text/x-shellscript",
        Some("py") => "text/x-python",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("wasm") => "application/wasm",
        Some("data") => "application/octet-stream",
        Some("mp3") => "audio/mpeg",
        Some("wav") => "audio/wav",
        Some("ogg") => "audio/ogg",
        Some("webm") => "audio/webm",
        Some("m4a") => "audio/mp4",
        Some("mp4") => "video/mp4",
        Some("mov") => "video/quicktime",
        Some("pdf") => "application/pdf",
        _ => "text/plain",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bytes_win_over_the_extension_and_the_extension_covers_the_rest() {
        let pdf = b"%PDF-1.4\n1 0 obj\n";
        assert_eq!(
            content_type_for(pdf, Path::new("report.dat")),
            "application/pdf"
        );
        assert_eq!(
            content_type_for(pdf, Path::new("no-extension")),
            "application/pdf"
        );
        assert_eq!(
            content_type_for(b"hello\n", Path::new("notes.md")),
            "text/markdown"
        );
        assert_eq!(
            content_type_for(b"", Path::new("unknown.zzz")),
            "text/plain"
        );
    }
}
