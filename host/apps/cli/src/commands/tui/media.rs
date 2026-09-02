use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::{BufWriter, Cursor, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::Duration;

use gsv::kernel_client::KernelClient;
use gsv_tui_core::{Artifact, MediaSlot};
use image::imageops::FilterType;
use image::{DynamicImage, ImageBuffer, ImageReader, Limits, Rgba};
use ratatui::layout::{Rect, Size};
use ratatui::Frame;
use ratatui_image::picker::{Capability, Picker};
use ratatui_image::protocol::Protocol;
use ratatui_image::{Image, Resize};
use serde_json::{json, Value};
use tokio::sync::mpsc;

const MAX_MEDIA_BYTES: usize = 48 * 1024 * 1024;
const MAX_DECODE_ALLOCATION: u64 = 256 * 1024 * 1024;
const MAX_IMAGE_DIMENSION: u32 = 16_384;
const MEDIA_CACHE_ITEMS: usize = 8;
const IMAGE_VARIANTS_PER_ITEM: usize = 4;
const RESOURCE_TIMEOUT: Duration = Duration::from_secs(30);

pub(super) struct ImageManager {
    picker: Picker,
    entries: HashMap<String, ImageEntry>,
    event_sender: mpsc::UnboundedSender<MediaEvent>,
    event_receiver: mpsc::UnboundedReceiver<MediaEvent>,
    generation: u64,
    background: Option<Rgba<u8>>,
}

pub(super) struct ArtifactStore {
    directory: Result<tempfile::TempDir, String>,
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
    source: Arc<DynamicImage>,
    encoding: Option<Size>,
    failed: Option<Size>,
    variants: Vec<ImageVariant>,
}

struct ImageVariant {
    requested: Size,
    protocol: Box<Protocol>,
    last_used: u64,
}

enum MediaEvent {
    Loaded {
        key: String,
        result: Result<DynamicImage, String>,
    },
    Encoded {
        key: String,
        requested: Size,
        result: Result<Box<Protocol>, String>,
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

impl ArtifactStore {
    pub(super) fn new() -> Self {
        let directory = tempfile::Builder::new()
            .prefix("gsv-tui-open-")
            .tempdir()
            .map_err(|error| format!("Could not create a private media directory: {error}"))
            .and_then(|directory| {
                restrict_directory(directory.path())
                    .map_err(|error| format!("Could not protect the media directory: {error}"))?;
                Ok(directory)
            });
        Self { directory }
    }

    pub(super) fn directory(&self) -> Result<PathBuf, String> {
        self.directory
            .as_ref()
            .map(|directory| directory.path().to_path_buf())
            .map_err(Clone::clone)
    }
}

impl ImageManager {
    pub(super) fn detect() -> Self {
        let mut picker = Picker::from_query_stdio().unwrap_or_else(|_| Picker::halfblocks());
        let background = picker.capabilities().iter().find_map(|capability| {
            if let Capability::Background(red, green, blue) = capability {
                Some(Rgba([*red, *green, *blue, 255]))
            } else {
                None
            }
        });
        if let Some(background) = background {
            picker.set_background_color(Some(background));
        }
        let (event_sender, event_receiver) = mpsc::unbounded_channel();
        Self {
            picker,
            entries: HashMap::new(),
            event_sender,
            event_receiver,
            generation: 0,
            background,
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
            let requested = slot.area.as_size();
            let variant = ready
                .variants
                .iter()
                .position(|variant| variant.requested == requested)
                .or_else(|| {
                    ready
                        .variants
                        .iter()
                        .enumerate()
                        .max_by_key(|(_, variant)| variant.last_used)
                        .map(|(index, _)| index)
                });
            let Some(variant) = variant.and_then(|index| ready.variants.get_mut(index)) else {
                continue;
            };
            variant.last_used = self.generation;
            let render_area = centered_protocol_area(slot.area, variant.protocol.size());
            frame.render_widget(
                Image::new(variant.protocol.as_ref()).allow_clipping(true),
                render_area,
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

        let mut encode_work = Vec::new();
        for slot in slots {
            let Some(entry) = self.entries.get_mut(&slot.key) else {
                continue;
            };
            let ImageState::Ready(ready) = &mut entry.state else {
                continue;
            };
            let requested = slot.area.as_size();
            let already_encoded = ready
                .variants
                .iter()
                .any(|variant| variant.requested == requested);
            if requested.width == 0
                || requested.height == 0
                || already_encoded
                || ready.encoding.is_some()
                || ready.failed == Some(requested)
            {
                continue;
            }
            ready.encoding = Some(requested);
            encode_work.push((slot.key.clone(), Arc::clone(&ready.source), requested));
        }
        for (key, source, requested) in encode_work {
            let sender = self.event_sender.clone();
            let picker = self.picker.clone();
            let background = self.background;
            let handle = tokio::task::spawn_blocking(move || {
                let result =
                    encode_image(&picker, source.as_ref(), requested, background).map(Box::new);
                let _ = sender.send(MediaEvent::Encoded {
                    key,
                    requested,
                    result,
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
                    Ok(image) => ImageState::Ready(Box::new(ReadyImage {
                        source: Arc::new(image),
                        encoding: None,
                        failed: None,
                        variants: Vec::new(),
                    })),
                    Err(_) => ImageState::Failed,
                };
            }
            MediaEvent::Encoded {
                key,
                requested,
                result,
            } => {
                let Some(ImageEntry {
                    state: ImageState::Ready(ready),
                    ..
                }) = self.entries.get_mut(&key)
                else {
                    return;
                };
                if ready.encoding != Some(requested) {
                    return;
                }
                ready.encoding = None;
                match result {
                    Ok(protocol) => {
                        ready.failed = None;
                        ready
                            .variants
                            .retain(|variant| variant.requested != requested);
                        ready.variants.push(ImageVariant {
                            requested,
                            protocol,
                            last_used: self.generation,
                        });
                        if ready.variants.len() > IMAGE_VARIANTS_PER_ITEM {
                            let stale = ready
                                .variants
                                .iter()
                                .enumerate()
                                .min_by_key(|(_, variant)| variant.last_used)
                                .map(|(index, _)| index)
                                .unwrap_or(0);
                            ready.variants.remove(stale);
                        }
                    }
                    Err(_) => {
                        ready.failed = Some(requested);
                    }
                }
            }
        }
    }
}

fn encode_image(
    picker: &Picker,
    source: &DynamicImage,
    requested: Size,
    background: Option<Rgba<u8>>,
) -> Result<Protocol, String> {
    let resize = Resize::Fit(Some(FilterType::Lanczos3));
    let encoded_size = resize.size_for(source, picker.font_size(), requested);
    if encoded_size.width == 0 || encoded_size.height == 0 {
        return Err("The terminal image area is empty".to_string());
    }
    let image = resize.resize(source, picker.font_size(), encoded_size, background);
    picker
        .new_protocol(image, encoded_size, Resize::Fit(None))
        .map_err(|error| error.to_string())
}

fn centered_protocol_area(area: Rect, image: Size) -> Rect {
    let width = image.width.min(area.width);
    let height = image.height.min(area.height);
    Rect::new(
        area.x + area.width.saturating_sub(width) / 2,
        area.y + area.height.saturating_sub(height) / 2,
        width,
        height,
    )
}

async fn load_image(
    client: Option<&KernelClient>,
    artifact: Artifact,
) -> Result<DynamicImage, String> {
    if artifact.revision.as_deref() == Some("demo:1") {
        return Ok(demo_image());
    }
    if !artifact.mime_type.starts_with("image/") {
        return Err("The artifact is not an image".to_string());
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
    let source = artifact
        .source
        .as_deref()
        .ok_or_else(|| "The artifact has no resource source".to_string())?;
    let (target, path) = source
        .split_once(':')
        .ok_or_else(|| "The artifact source is not a target resource".to_string())?;
    if target.is_empty() || !path.starts_with('/') {
        return Err("The artifact source is not a canonical target path".to_string());
    }
    let revision = artifact
        .revision
        .as_deref()
        .ok_or_else(|| "The artifact has no immutable revision".to_string())?;
    let size = artifact
        .size
        .ok_or_else(|| "The artifact has no declared size".to_string())?;
    if size > MAX_MEDIA_BYTES as u64 {
        return Err(format!(
            "The artifact exceeds the {MAX_MEDIA_BYTES}-byte transfer limit"
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

pub(super) async fn open_artifact(
    directory: PathBuf,
    client: Option<Arc<KernelClient>>,
    artifact: Artifact,
) -> Result<(), String> {
    let reference = resource_reference(&artifact)?;
    let client = client.ok_or_else(|| "Stored media needs a connected GSV session".to_string())?;
    let bytes = fetch_resource(&client, &reference).await?;
    tokio::task::spawn_blocking(move || {
        let path = materialize_artifact(&directory, &artifact, &bytes)?;
        open_with_system(&path)
    })
    .await
    .map_err(|error| format!("Opening the artifact stopped unexpectedly: {error}"))?
}

fn materialize_artifact(
    directory: &Path,
    artifact: &Artifact,
    bytes: &[u8],
) -> Result<PathBuf, String> {
    let extension = extension_for_mime(&artifact.mime_type)
        .map(str::to_string)
        .or_else(|| safe_extension(artifact.filename.as_deref()));
    let stem = format!("media-{}", uuid::Uuid::new_v4());
    let path = directory.join(match extension.as_deref() {
        Some(extension) => format!("{stem}.{extension}"),
        None => stem,
    });
    let partial = path.with_extension(match extension.as_deref() {
        Some(extension) => format!("{extension}.part"),
        None => "part".to_string(),
    });
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&partial)
        .map_err(|error| format!("Could not create the local media file: {error}"))?;
    restrict_file(&partial)
        .map_err(|error| format!("Could not protect the local media file: {error}"))?;
    let mut writer = BufWriter::new(file);
    if let Err(error) = writer.write_all(bytes).and_then(|_| writer.flush()) {
        let _ = fs::remove_file(&partial);
        return Err(format!("Could not write the local media file: {error}"));
    }
    if let Err(error) = writer.get_ref().sync_all() {
        let _ = fs::remove_file(&partial);
        return Err(format!("Could not finish the local media file: {error}"));
    }
    if let Err(error) = fs::rename(&partial, &path) {
        let _ = fs::remove_file(&partial);
        return Err(format!("Could not publish the local media file: {error}"));
    }
    Ok(path)
}

fn safe_extension(filename: Option<&str>) -> Option<String> {
    let extension = Path::new(filename?)
        .extension()?
        .to_string_lossy()
        .to_ascii_lowercase();
    matches!(
        extension.as_str(),
        "pdf"
            | "txt"
            | "csv"
            | "json"
            | "png"
            | "jpg"
            | "jpeg"
            | "gif"
            | "webp"
            | "svg"
            | "mp3"
            | "m4a"
            | "ogg"
            | "opus"
            | "wav"
            | "flac"
            | "mp4"
            | "webm"
            | "mov"
    )
    .then_some(extension)
}

fn extension_for_mime(mime_type: &str) -> Option<&'static str> {
    match mime_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "application/pdf" => Some("pdf"),
        "audio/mpeg" => Some("mp3"),
        "audio/mp4" => Some("m4a"),
        "audio/ogg" | "application/ogg" => Some("ogg"),
        "audio/opus" => Some("opus"),
        "audio/wav" | "audio/x-wav" => Some("wav"),
        "audio/flac" => Some("flac"),
        "video/mp4" => Some("mp4"),
        "video/webm" => Some("webm"),
        "video/quicktime" => Some("mov"),
        "image/png" => Some("png"),
        "image/jpeg" => Some("jpg"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        "image/svg+xml" => Some("svg"),
        "text/plain" => Some("txt"),
        "text/csv" => Some("csv"),
        "application/json" => Some("json"),
        _ => None,
    }
}

#[cfg(target_os = "macos")]
fn open_with_system(path: &Path) -> Result<(), String> {
    spawn_opener(Command::new("open").arg(path))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_with_system(path: &Path) -> Result<(), String> {
    spawn_opener(Command::new("xdg-open").arg(path))
}

#[cfg(windows)]
fn open_with_system(path: &Path) -> Result<(), String> {
    spawn_opener(Command::new("cmd").args(["/C", "start", ""]).arg(path))
}

fn spawn_opener(command: &mut Command) -> Result<(), String> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(drop)
        .map_err(|error| format!("Could not launch the system media viewer: {error}"))
}

#[cfg(unix)]
fn restrict_directory(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt as _;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
}

#[cfg(not(unix))]
fn restrict_directory(_: &Path) -> std::io::Result<()> {
    Ok(())
}

#[cfg(unix)]
fn restrict_file(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt as _;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn restrict_file(_: &Path) -> std::io::Result<()> {
    Ok(())
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
    use ratatui::layout::Size;
    use ratatui_image::picker::Picker;

    use super::{demo_image, encode_image, materialize_artifact, resource_reference, ImageState};

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
    fn ogg_audio_materializes_with_a_playable_extension() {
        let directory = tempfile::tempdir().expect("temporary artifact directory");
        let artifact = Artifact {
            kind: MediaKind::Audio,
            mime_type: "audio/ogg".to_string(),
            filename: Some("voice-message.ogg".to_string()),
            size: Some(4),
            duration_ms: Some(500),
            transcription: None,
            source: Some("gsv:/home/ship/voice-message.ogg".to_string()),
            revision: Some("sha256:voice".to_string()),
        };

        let reference = resource_reference(&artifact).expect("canonical audio reference");
        assert_eq!(reference.content_type, "audio/ogg");
        let path =
            materialize_artifact(directory.path(), &artifact, b"OggS").expect("materialized audio");
        assert_eq!(
            path.extension().and_then(|value| value.to_str()),
            Some("ogg")
        );
        assert_eq!(std::fs::read(path).expect("audio bytes"), b"OggS");
    }

    #[test]
    fn demo_image_has_a_widescreen_shape() {
        let image = demo_image();
        assert_eq!(image.width(), 960);
        assert_eq!(image.height(), 540);
    }

    #[test]
    fn encoding_a_new_size_leaves_the_visible_variant_intact() {
        let picker = Picker::halfblocks();
        let image = demo_image();
        let compact =
            encode_image(&picker, &image, Size::new(20, 8), None).expect("compact terminal image");
        let compact_size = compact.size();

        let expanded = encode_image(&picker, &image, Size::new(60, 20), None)
            .expect("expanded terminal image");

        assert_eq!(compact.size(), compact_size);
        assert!(expanded.size().width >= compact.size().width);
        assert!(expanded.size().height >= compact.size().height);
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
