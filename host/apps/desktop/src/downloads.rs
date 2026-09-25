use std::path::{Path, PathBuf};

use tauri::{webview::DownloadEvent, Emitter, Manager, Webview};
use url::Url;

fn attachment_url(url: &Url) -> bool {
    url.as_str()
        .strip_prefix("blob:")
        .and_then(|value| Url::parse(value).ok())
        .is_some_and(|origin| crate::trusted_navigation(&origin))
}

fn destination(directory: &Path, suggested: &Path) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(directory)?;
    let filename = suggested.file_name().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "Missing download filename",
        )
    })?;
    let mut path = directory.join(filename);
    let stem = path.file_stem().unwrap_or(filename).to_os_string();
    let extension = path.extension().map(|value| value.to_os_string());
    let mut counter = 0;
    loop {
        match std::fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(path),
            Err(error) => return Err(error),
            Ok(_) => {
                counter += 1;
                let mut name = stem.clone();
                name.push(format!(" ({counter})"));
                if let Some(extension) = &extension {
                    name.push(".");
                    name.push(extension);
                }
                path.set_file_name(name);
            }
        }
    }
}

pub fn handle(webview: Webview, event: DownloadEvent<'_>) -> bool {
    match event {
        DownloadEvent::Requested {
            url,
            destination: path,
        } => {
            // The frontend has already read this attachment through its gateway connection.
            // Let WebKit save its blob; never fetch credentials or navigate to remote content.
            let next = attachment_url(&url)
                .then(|| webview.app_handle().path().download_dir().ok())
                .flatten()
                .and_then(|directory| destination(&directory, path).ok());
            if let Some(next) = next {
                *path = next;
                true
            } else {
                let _ = webview.emit("desktop-download", false);
                false
            }
        }
        #[cfg(not(target_os = "linux"))]
        DownloadEvent::Finished { success, .. } => {
            let _ = webview.emit("desktop-download", success);
            true
        }
        _ => false,
    }
}

#[cfg(target_os = "linux")]
pub fn track_completion(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    use std::{cell::Cell, rc::Rc};
    use webkit2gtk::{DownloadExt, WebContextExt, WebViewExt};

    let owner = window.clone();
    window.with_webview(move |view| {
        let context = view.inner().context().expect("main webview has a context");
        context.connect_download_started(move |_, download| {
            // Wry 0.55.1 shares its failed flag across every download in this context.
            // Observe each WebKit download's terminal state so a failure cannot poison retries.
            let failed = Rc::new(Cell::new(false));
            let failure = failed.clone();
            download.connect_failed(move |_, _| failure.set(true));
            let owner = owner.clone();
            download.connect_finished(move |_| {
                let _ = owner.emit("desktop-download", !failed.get());
            });
        });
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn downloads_only_blobs_from_the_bundled_frontend() {
        for url in [
            "blob:tauri://localhost/file",
            "blob:http://tauri.localhost/file",
        ] {
            assert!(attachment_url(&Url::parse(url).unwrap()));
        }
        for url in [
            "https://example.com/file",
            "file:///etc/passwd",
            "data:text/html,<script></script>",
            "blob:https://example.com/file",
            "blob:tauri://localhost.example.com/file",
            "blob:null/file",
        ] {
            assert!(!attachment_url(&Url::parse(url).unwrap()), "{url}");
        }
    }

    #[test]
    fn saves_under_downloads_without_replacing_existing_files() {
        let root = tempfile::tempdir().unwrap();
        let downloads = root.path().join("Downloads");
        let first = destination(&downloads, Path::new("../../report.txt")).unwrap();
        assert_eq!(first, downloads.join("report.txt"));
        std::fs::write(&first, "original").unwrap();
        let second = destination(&downloads, Path::new("report.txt")).unwrap();
        assert_eq!(second, downloads.join("report (1).txt"));
        std::fs::write(&second, "second").unwrap();
        assert_eq!(
            destination(&downloads, Path::new("report.txt")).unwrap(),
            downloads.join("report (2).txt")
        );
        assert_eq!(std::fs::read_to_string(first).unwrap(), "original");
    }

    #[test]
    fn reports_unavailable_download_directory() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("Downloads");
        std::fs::write(&file, "existing file").unwrap();
        assert!(destination(&file, Path::new("report.txt")).is_err());
    }
}
