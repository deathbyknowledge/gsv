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

/// The content type the bytes say, else the one the extension says, else
/// text only when the bytes read as text.
pub fn content_type_for(header: &[u8], path: &Path) -> &'static str {
    infer::get(header)
        .map(|kind| kind.mime_type())
        .or_else(|| content_type_from_extension(path))
        .unwrap_or_else(|| {
            if reads_as_text(header) {
                "text/plain"
            } else {
                "application/octet-stream"
            }
        })
}

/// UTF-8 without NUL bytes; a character cut off by the end of the header still counts.
fn reads_as_text(header: &[u8]) -> bool {
    if header.contains(&0) {
        return false;
    }
    match std::str::from_utf8(header) {
        Ok(_) => true,
        Err(error) => error.error_len().is_none(),
    }
}

fn content_type_from_extension(path: &Path) -> Option<&'static str> {
    let content_type = match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()?
    {
        "md" => "text/markdown",
        "json" | "map" => "application/json",
        "yaml" | "yml" => "application/yaml",
        "xml" => "application/xml",
        "toml" => "application/toml",
        "js" | "cjs" | "mjs" | "jsx" => "application/javascript",
        "ts" | "tsx" => "application/typescript",
        "html" | "htm" => "text/html",
        "css" => "text/css",
        "txt" | "log" => "text/plain",
        "csv" => "text/csv",
        "sh" => "text/x-shellscript",
        "py" => "text/x-python",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "wasm" => "application/wasm",
        "data" => "application/octet-stream",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "webm" => "audio/webm",
        "m4a" => "audio/mp4",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "pdf" => "application/pdf",
        _ => return None,
    };
    Some(content_type)
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

    #[test]
    fn bytes_without_a_known_format_or_extension_are_text_only_when_they_read_as_text() {
        let binary = [0x8f, 0x00, 0xd2, 0x41, 0xff, 0x13];
        assert_eq!(
            content_type_for(&binary, Path::new("blob")),
            "application/octet-stream"
        );
        assert_eq!(
            content_type_for("Hola, ¿qué tal?\n".as_bytes(), Path::new("README")),
            "text/plain"
        );
        let cut = "señal".as_bytes();
        assert_eq!(
            content_type_for(&cut[..3], Path::new("Makefile")),
            "text/plain"
        );
    }
}
