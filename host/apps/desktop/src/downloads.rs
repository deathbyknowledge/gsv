use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::Mutex,
};

use tauri::{webview::DownloadEvent, Emitter, Manager, Webview};
use url::Url;

fn attachment_url(url: &Url) -> bool {
    url.as_str()
        .strip_prefix("blob:")
        .and_then(|value| Url::parse(value).ok())
        .is_some_and(|origin| crate::trusted_navigation(&origin))
}

#[derive(Default)]
pub struct Downloads(Mutex<Reservations>);

#[derive(Default)]
struct Reservations(HashMap<Url, Pending>);

#[derive(Default)]
struct Pending {
    remaining: usize,
    paths: HashSet<PathBuf>,
}

impl Reservations {
    fn start(&mut self, url: Url, directory: Option<PathBuf>, suggested: &Path) -> Option<PathBuf> {
        let path = directory.and_then(|directory| {
            destination(&directory, suggested, |path| {
                self.0.values().any(|pending| pending.paths.contains(path))
            })
            .ok()
        });
        let pending = self.0.entry(url).or_default();
        pending.remaining += 1;
        if let Some(path) = &path {
            pending.paths.insert(path.clone());
        }
        path
    }

    fn finish(&mut self, url: &Url) {
        if let Some(pending) = self.0.get_mut(url) {
            pending.remaining -= 1;
            // macOS reports only the source URL, not a download ID or destination.
            // Keep all names for repeated clicks on that blob until its last download ends.
            if pending.remaining == 0 {
                self.0.remove(url);
            }
        }
    }
}

fn destination(
    directory: &Path,
    suggested: &Path,
    reserved: impl Fn(&Path) -> bool,
) -> std::io::Result<PathBuf> {
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
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if !reserved(&path) {
                    return Ok(path);
                }
            }
            Err(error) => return Err(error),
            Ok(_) => {}
        }
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

pub fn handle(webview: Webview, event: DownloadEvent<'_>) -> bool {
    match event {
        DownloadEvent::Requested {
            url,
            destination: path,
        } => {
            // The frontend has already read this attachment through its gateway connection.
            // Let WebKit save its blob; never fetch credentials or navigate to remote content.
            let directory = attachment_url(&url)
                .then(|| webview.app_handle().path().download_dir().ok())
                .flatten();
            let downloads = webview.state::<Downloads>();
            let next = downloads
                .0
                .lock()
                .expect("download reservations")
                .start(url, directory, path);
            if let Some(next) = next {
                *path = next;
                true
            } else {
                let _ = webview.emit("desktop-download", false);
                false
            }
        }
        #[cfg(not(target_os = "linux"))]
        DownloadEvent::Finished { url, success, .. } => {
            webview
                .state::<Downloads>()
                .0
                .lock()
                .expect("download reservations")
                .finish(&url);
            let _ = webview.emit("desktop-download", success);
            true
        }
        _ => false,
    }
}

#[cfg(target_os = "linux")]
pub fn track_completion(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    use std::{cell::Cell, rc::Rc};
    use webkit2gtk::{DownloadExt, URIRequestExt, WebContextExt, WebViewExt};

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
            download.connect_finished(move |download| {
                if let Some(url) = download
                    .request()
                    .and_then(|request| request.uri())
                    .and_then(|uri| Url::parse(&uri).ok())
                {
                    owner
                        .state::<Downloads>()
                        .0
                        .lock()
                        .expect("download reservations")
                        .finish(&url);
                }
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
        let first = destination(&downloads, Path::new("../../report.txt"), |_| false).unwrap();
        assert_eq!(first, downloads.join("report.txt"));
        std::fs::write(&first, "original").unwrap();
        let second = destination(&downloads, Path::new("report.txt"), |_| false).unwrap();
        assert_eq!(second, downloads.join("report (1).txt"));
        std::fs::write(&second, "second").unwrap();
        assert_eq!(
            destination(&downloads, Path::new("report.txt"), |_| false).unwrap(),
            downloads.join("report (2).txt")
        );
        assert_eq!(std::fs::read_to_string(first).unwrap(), "original");
    }

    #[test]
    fn reports_unavailable_download_directory() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("Downloads");
        std::fs::write(&file, "existing file").unwrap();
        assert!(destination(&file, Path::new("report.txt"), |_| false).is_err());
    }

    #[test]
    fn reserves_names_before_webkit_creates_files() {
        let root = tempfile::tempdir().unwrap();
        let mut reservations = Reservations::default();
        let source = Url::parse("blob:tauri://localhost/first").unwrap();
        let other = Url::parse("blob:tauri://localhost/second").unwrap();
        let name = Path::new("report.txt");
        let start = |reservations: &mut Reservations, url: Url| {
            reservations
                .start(url, Some(root.path().to_path_buf()), name)
                .unwrap()
        };
        assert_eq!(
            start(&mut reservations, source.clone()),
            root.path().join(name)
        );
        assert_eq!(
            start(&mut reservations, source.clone()),
            root.path().join("report (1).txt")
        );
        // A failed download may have no file, and repeated clicks may finish out of order.
        reservations.finish(&source);
        assert_eq!(
            start(&mut reservations, other.clone()),
            root.path().join("report (2).txt")
        );
        // A rejected request with the same URL must not release another download's reservation.
        assert!(reservations.start(source.clone(), None, name).is_none());
        reservations.finish(&source);
        assert_eq!(
            start(&mut reservations, other.clone()),
            root.path().join("report (3).txt")
        );
        reservations.finish(&source);
        assert_eq!(
            start(&mut reservations, other.clone()),
            root.path().join(name)
        );
        for _ in 0..3 {
            reservations.finish(&other);
        }
        assert!(reservations.0.is_empty());
    }
}
