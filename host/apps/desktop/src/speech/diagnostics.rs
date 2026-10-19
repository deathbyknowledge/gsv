use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::task::JoinHandle;

#[derive(Default)]
struct Diagnostic {
    cause: Option<&'static str>,
    component: Option<&'static str>,
    received: bool,
    read_failed: bool,
}

impl Diagnostic {
    fn observe(&mut self, line: &[u8]) {
        self.received = true;
        let text = String::from_utf8_lossy(line);
        let text = text.trim_start();
        let mut diagnostic_line = text.starts_with("File \"");
        // Retain only known diagnostic labels: exception messages, traceback
        // source lines and paths can contain private text or user information.
        for cause in [
            "ModuleNotFoundError",
            "ImportError",
            "OSError",
            "RuntimeError",
            "FileNotFoundError",
            "PermissionError",
            "MemoryError",
            "SystemError",
            "AttributeError",
            "ValueError",
            "TypeError",
        ] {
            if text
                .strip_prefix(cause)
                .is_some_and(|rest| rest.starts_with(':'))
            {
                self.cause = Some(cause);
                diagnostic_line = true;
            }
        }
        if text.contains("Failed to load Python shared library")
            || text.contains("error while loading shared libraries")
            || text.contains("Library not loaded:")
            || text.contains("DLL load failed")
        {
            self.cause.get_or_insert("native_library_load_failed");
            diagnostic_line = true;
        }
        if text.contains("Failed to execute script") {
            self.cause.get_or_insert("packaged_startup_failed");
            diagnostic_line = true;
        }
        if diagnostic_line {
            for component in [
                "onnxruntime",
                "numpy",
                "phonemizer",
                "espeakng_loader",
                "kokoro_onnx",
                "sounddevice",
                "libpython",
                "libespeak",
                "libportaudio",
            ] {
                if text.contains(component) {
                    self.component = Some(component);
                    break;
                }
            }
        }
    }

    fn summary(&self) -> String {
        let cause = self.cause.unwrap_or(if self.read_failed {
            "stderr_read_failed"
        } else if self.received {
            "unrecognized_stderr_redacted"
        } else {
            "no_stderr"
        });
        match self.component {
            Some(component) => format!("{cause}; {component}"),
            None => cause.to_string(),
        }
    }
}

pub(super) struct StderrCapture {
    diagnostic: Arc<Mutex<Diagnostic>>,
    task: JoinHandle<()>,
}

impl StderrCapture {
    pub(super) fn start(mut reader: impl AsyncRead + Unpin + Send + 'static) -> Self {
        let diagnostic = Arc::new(Mutex::new(Diagnostic::default()));
        let observed = diagnostic.clone();
        let task = tokio::spawn(async move {
            let mut buffer = [0_u8; 1024];
            let mut line = Vec::with_capacity(2048);
            loop {
                let count = match reader.read(&mut buffer).await {
                    Ok(0) => break,
                    Ok(count) => count,
                    Err(_) => {
                        observed.lock().unwrap().read_failed = true;
                        break;
                    }
                };
                for byte in &buffer[..count] {
                    if *byte == b'\n' {
                        observed.lock().unwrap().observe(&line);
                        line.clear();
                    } else if line.len() < 2048 {
                        line.push(*byte);
                    }
                }
                if !line.is_empty() {
                    observed.lock().unwrap().observe(&line);
                }
            }
        });
        Self { diagnostic, task }
    }

    pub(super) async fn finish(mut self) -> String {
        let _ = tokio::time::timeout(Duration::from_millis(250), &mut self.task).await;
        self.diagnostic.lock().unwrap().summary()
    }
}

impl Drop for StderrCapture {
    fn drop(&mut self) {
        self.task.abort();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncWriteExt;

    #[tokio::test]
    async fn stderr_is_drained_bounded_and_reduced_to_known_labels() {
        let (mut writer, reader) = tokio::io::duplex(64);
        let capture = StderrCapture::start(reader);
        let write = tokio::spawn(async move {
            writer.write_all(&vec![b'x'; 512 * 1024]).await.unwrap();
            writer.write_all(b"\n  File \"/private/person/numpy/core.py\", line 5\nModuleNotFoundError: No module named 'onnxruntime'\nprivate spoken content about numpy and credentials\n").await.unwrap();
        });
        tokio::time::timeout(Duration::from_secs(2), write)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(capture.finish().await, "ModuleNotFoundError; onnxruntime");
    }

    #[tokio::test]
    async fn unfinished_stderr_is_reported_and_capture_is_cancelled_on_teardown() {
        let (mut writer, reader) = tokio::io::duplex(64);
        let capture = StderrCapture::start(reader);
        writer
            .write_all(b"ImportError: DLL load failed: onnxruntime")
            .await
            .unwrap();
        assert_eq!(capture.finish().await, "ImportError; onnxruntime");
        let result = tokio::time::timeout(Duration::from_secs(1), writer.write_all(&[b'x'; 128]))
            .await
            .unwrap();
        assert!(result.is_err());
    }

    #[test]
    fn native_startup_failure_keeps_the_cause_without_paths_or_messages() {
        let mut diagnostic = Diagnostic::default();
        diagnostic.observe(b"[PYI-123:ERROR] Failed to load Python shared library '/private/person/libpython3.12.so': private details");
        assert_eq!(
            diagnostic.summary(),
            "native_library_load_failed; libpython"
        );
    }
}
