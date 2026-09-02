use std::collections::{HashMap, HashSet};
use std::io::Cursor;
use std::sync::Arc;
use std::time::Duration;

use gsv::kernel_client::KernelClient;
use gsv_tui_core::{Artifact, MediaSlot};
use image::imageops::FilterType;
use image::{DynamicImage, ImageBuffer, ImageReader, Limits, Rgba};
use ratatui::Frame;
use ratatui_image::picker::{Capability, Picker};
use ratatui_image::thread::{ResizeRequest, ResizeResponse, ThreadProtocol};
use ratatui_image::{Resize, StatefulImage};
use serde_json::{json, Value};
use tokio::sync::mpsc::{self, UnboundedReceiver};

const MAX_MEDIA_BYTES: usize = 48 * 1024 * 1024;
const MAX_DECODE_ALLOCATION: u64 = 256 * 1024 * 1024;
const MAX_IMAGE_DIMENSION: u32 = 16_384;
const MEDIA_CACHE_ITEMS: usize = 8;
const RESOURCE_TIMEOUT: Duration = Duration::from_secs(30);

pub(super) struct ImageManager {
    picker: Picker,
    entries: HashMap<String, ImageEntry>,
    event_sender: mpsc::UnboundedSender<MediaEvent>,
    event_receiver: mpsc::UnboundedReceiver<MediaEvent>,
    generation: u64,
}

struct ImageEntry {
    state: ImageState,
    last_visible: u64,
}

enum ImageState {
    Loading(tokio::task::AbortHandle),
    Ready(Box<ReadyImage>),
    Failed,
}

impl Drop for ImageState {
    fn drop(&mut self) {
        if let Self::Loading(abort) = self {
            abort.abort();
        }
    }
}

struct ReadyImage {
    protocol: ThreadProtocol,
    resize_requests: UnboundedReceiver<ResizeRequest>,
}

enum MediaEvent {
    Loaded {
        key: String,
        result: Result<DynamicImage, String>,
    },
    Resized {
        key: String,
        result: Box<Result<ResizeResponse, String>>,
    },
}

#[derive(Clone)]
struct ResourceReference {
    target: String,
    path: String,
    revision: String,
    content_type: String,
    size: u64,
}

impl ImageManager {
    pub(super) fn detect() -> Self {
        let mut picker = Picker::from_query_stdio().unwrap_or_else(|_| Picker::halfblocks());
        if let Some((red, green, blue)) = picker.capabilities().iter().find_map(|capability| {
            if let Capability::Background(red, green, blue) = capability {
                Some((*red, *green, *blue))
            } else {
                None
            }
        }) {
            picker.set_background_color(Some(Rgba([red, green, blue, 255])));
        }
        let (event_sender, event_receiver) = mpsc::unbounded_channel();
        Self {
            picker,
            entries: HashMap::new(),
            event_sender,
            event_receiver,
            generation: 0,
        }
    }

    pub(super) fn render(&mut self, frame: &mut Frame<'_>, slots: &[MediaSlot]) {
        self.generation = self.generation.wrapping_add(1);
        for slot in slots {
            let Some(entry) = self.entries.get_mut(&slot.key) else {
                continue;
            };
            entry.last_visible = self.generation;
            let ImageState::Ready(ready) = &mut entry.state else {
                continue;
            };
            frame.render_stateful_widget(
                StatefulImage::new().resize(Resize::Fit(Some(FilterType::Lanczos3))),
                slot.area,
                &mut ready.protocol,
            );
        }
    }

    pub(super) fn synchronize(&mut self, slots: &[MediaSlot], client: Option<&Arc<KernelClient>>) {
        let visible = slots
            .iter()
            .map(|slot| slot.key.as_str())
            .collect::<HashSet<_>>();
        for slot in slots {
            if self.entries.contains_key(&slot.key) {
                continue;
            }
            let key = slot.key.clone();
            let artifact = slot.artifact.clone();
            let sender = self.event_sender.clone();
            let client = client.cloned();
            let event_key = key.clone();
            let handle = tokio::spawn(async move {
                let result = load_image(client.as_deref(), artifact).await;
                let _ = sender.send(MediaEvent::Loaded {
                    key: event_key,
                    result,
                });
            });
            let abort = handle.abort_handle();
            drop(handle);
            self.entries.insert(
                key,
                ImageEntry {
                    state: ImageState::Loading(abort),
                    last_visible: self.generation,
                },
            );
        }

        let mut resize_work = Vec::new();
        for (key, entry) in &mut self.entries {
            let ImageState::Ready(ready) = &mut entry.state else {
                continue;
            };
            while let Ok(request) = ready.resize_requests.try_recv() {
                resize_work.push((key.clone(), request));
            }
        }
        for (key, request) in resize_work {
            let sender = self.event_sender.clone();
            let handle = tokio::task::spawn_blocking(move || {
                let result = request.resize_encode().map_err(|error| error.to_string());
                let _ = sender.send(MediaEvent::Resized {
                    key,
                    result: Box::new(result),
                });
            });
            drop(handle);
        }

        if self.entries.len() > MEDIA_CACHE_ITEMS {
            let mut stale = self
                .entries
                .iter()
                .filter(|(key, _)| !visible.contains(key.as_str()))
                .map(|(key, entry)| (key.clone(), entry.last_visible))
                .collect::<Vec<_>>();
            stale.sort_by_key(|(_, last_visible)| *last_visible);
            let remove_count = self.entries.len().saturating_sub(MEDIA_CACHE_ITEMS);
            for (key, _) in stale.into_iter().take(remove_count) {
                self.entries.remove(&key);
            }
        }
    }

    pub(super) async fn next_event(&mut self) {
        if let Some(event) = self.event_receiver.recv().await {
            self.apply_event(event);
        }
    }

    fn apply_event(&mut self, event: MediaEvent) {
        match event {
            MediaEvent::Loaded { key, result } => {
                let Some(entry) = self.entries.get_mut(&key) else {
                    return;
                };
                entry.state = match result {
                    Ok(image) => {
                        let (resize_sender, resize_requests) = mpsc::unbounded_channel();
                        let protocol = self.picker.new_resize_protocol(image);
                        ImageState::Ready(Box::new(ReadyImage {
                            protocol: ThreadProtocol::new(resize_sender, Some(protocol)),
                            resize_requests,
                        }))
                    }
                    Err(_) => ImageState::Failed,
                };
            }
            MediaEvent::Resized { key, result } => {
                let Some(ImageEntry {
                    state: ImageState::Ready(ready),
                    ..
                }) = self.entries.get_mut(&key)
                else {
                    return;
                };
                match *result {
                    Ok(response) => {
                        ready.protocol.update_resized_protocol(response);
                    }
                    Err(_) => {
                        ready.protocol.empty_protocol();
                    }
                }
            }
        }
    }
}

async fn load_image(
    client: Option<&KernelClient>,
    artifact: Artifact,
) -> Result<DynamicImage, String> {
    if artifact.revision.as_deref() == Some("demo:1") {
        return Ok(demo_image());
    }
    let reference = resource_reference(&artifact)?;
    let client = client.ok_or_else(|| "Stored media needs a connected GSV session".to_string())?;
    let bytes = fetch_resource(client, &reference).await?;
    tokio::task::spawn_blocking(move || decode_image(bytes))
        .await
        .map_err(|error| format!("Image decoding stopped unexpectedly: {error}"))?
}

fn decode_image(bytes: Vec<u8>) -> Result<DynamicImage, String> {
    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|error| format!("Image format detection failed: {error}"))?;
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_IMAGE_DIMENSION);
    limits.max_image_height = Some(MAX_IMAGE_DIMENSION);
    limits.max_alloc = Some(MAX_DECODE_ALLOCATION);
    reader.limits(limits);
    reader
        .decode()
        .map_err(|error| format!("Image decoding failed: {error}"))
}

fn resource_reference(artifact: &Artifact) -> Result<ResourceReference, String> {
    if !artifact.mime_type.starts_with("image/") {
        return Err("The artifact is not an image".to_string());
    }
    let source = artifact
        .source
        .as_deref()
        .ok_or_else(|| "The image has no resource source".to_string())?;
    let (target, path) = source
        .split_once(':')
        .ok_or_else(|| "The image source is not a target resource".to_string())?;
    if target.is_empty() || !path.starts_with('/') {
        return Err("The image source is not a canonical target path".to_string());
    }
    let revision = artifact
        .revision
        .as_deref()
        .ok_or_else(|| "The image has no immutable revision".to_string())?;
    let size = artifact
        .size
        .ok_or_else(|| "The image has no declared size".to_string())?;
    if size > MAX_MEDIA_BYTES as u64 {
        return Err(format!(
            "The image exceeds the {MAX_MEDIA_BYTES}-byte transfer limit"
        ));
    }
    Ok(ResourceReference {
        target: target.to_string(),
        path: path.to_string(),
        revision: revision.to_string(),
        content_type: artifact.mime_type.clone(),
        size,
    })
}

async fn fetch_resource(
    client: &KernelClient,
    reference: &ResourceReference,
) -> Result<Vec<u8>, String> {
    let response = client
        .connection()
        .request_response(
            "fs.transfer.send",
            Some(json!({
                "target": reference.target,
                "path": reference.path,
                "revision": reference.revision,
            })),
            RESOURCE_TIMEOUT,
        )
        .await
        .map_err(|error| format!("Resource read failed: {error}"))?;
    let data = response.data;
    if data.get("ok").and_then(Value::as_bool) == Some(false) {
        if let Some(mut body) = response.body {
            body.cancel("Resource read was rejected");
        }
        return Err(data
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("The gateway rejected the resource read")
            .to_string());
    }
    let matches = data.get("path").and_then(Value::as_str) == Some(reference.path.as_str())
        && data.get("revision").and_then(Value::as_str) == Some(reference.revision.as_str())
        && data.get("contentType").and_then(Value::as_str) == Some(reference.content_type.as_str())
        && data.get("size").and_then(Value::as_u64) == Some(reference.size);
    if !matches {
        if let Some(mut body) = response.body {
            body.cancel("Resource metadata did not match its reference");
        }
        return Err("GSV returned a different resource revision than requested".to_string());
    }
    let Some(mut body) = response.body else {
        return Err("GSV returned resource metadata without its body".to_string());
    };
    if body.length().is_some_and(|length| length != reference.size) {
        body.cancel("Resource body length did not match its reference");
        return Err("GSV returned an inconsistent resource body length".to_string());
    }
    let bytes = body
        .read_all(MAX_MEDIA_BYTES)
        .await
        .map_err(|error| format!("Resource body read failed: {error}"))?;
    if bytes.len() as u64 != reference.size {
        return Err("The resource bytes did not match the declared size".to_string());
    }
    Ok(bytes)
}

fn demo_image() -> DynamicImage {
    const WIDTH: u32 = 960;
    const HEIGHT: u32 = 540;
    let image = ImageBuffer::from_fn(WIDTH, HEIGHT, |x, y| {
        let horizon = ((x + y) % 256) as u8;
        let glow = 255_u8.saturating_sub(
            u8::try_from((x.abs_diff(WIDTH * 3 / 5) + y.abs_diff(HEIGHT / 3)) / 6)
                .unwrap_or(u8::MAX),
        );
        Rgba([
            10_u8.saturating_add(glow / 10),
            12_u8.saturating_add(glow / 7),
            16_u8.saturating_add(glow / 5),
            255_u8.saturating_sub(horizon / 10),
        ])
    });
    DynamicImage::ImageRgba8(image)
}

#[cfg(test)]
mod tests {
    use gsv_tui_core::{Artifact, MediaKind};

    use super::{demo_image, resource_reference, ImageState};

    #[test]
    fn canonical_resource_is_parsed_without_changing_its_identity() {
        let artifact = Artifact {
            kind: MediaKind::Image,
            mime_type: "image/png".to_string(),
            filename: Some("chart.png".to_string()),
            size: Some(42),
            duration_ms: None,
            transcription: None,
            source: Some("macbook:/Users/sam/chart.png".to_string()),
            revision: Some("sha256:exact".to_string()),
        };
        let reference = resource_reference(&artifact).expect("canonical reference");
        assert_eq!(reference.target, "macbook");
        assert_eq!(reference.path, "/Users/sam/chart.png");
        assert_eq!(reference.revision, "sha256:exact");
    }

    #[test]
    fn demo_image_has_a_widescreen_shape() {
        let image = demo_image();
        assert_eq!(image.width(), 960);
        assert_eq!(image.height(), 540);
    }

    #[tokio::test]
    async fn dropping_a_loading_image_cancels_its_resource_task() {
        let task = tokio::spawn(std::future::pending::<()>());
        let state = ImageState::Loading(task.abort_handle());
        drop(state);
        let error = task.await.expect_err("loading task should be cancelled");
        assert!(error.is_cancelled());
    }
}
