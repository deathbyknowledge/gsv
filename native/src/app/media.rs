use std::collections::{HashMap, HashSet};
use std::io::Cursor;
use std::sync::Arc;

use gpui::{Image, ImageFormat};
use tokio::sync::mpsc::UnboundedSender;

use crate::client::{ClientCommand, MediaSource};

const MEDIA_CACHE_ITEMS: usize = 12;
const MEDIA_CACHE_BYTES: usize = 128 * 1024 * 1024;
const MAX_DECODED_IMAGE_BYTES: usize = 96 * 1024 * 1024;
const MAX_IMAGE_DIMENSION: u32 = 16_384;
const MAX_SVG_BYTES: usize = 2 * 1024 * 1024;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct MediaDescriptor {
    pub cache_key: String,
    pub source: MediaSource,
    pub mime_type: Option<String>,
}

pub(super) enum MediaVisual<'a> {
    Loading,
    Loaded(&'a Arc<Image>),
    Failed,
    Missing,
}

pub(super) struct MediaCache {
    entries: HashMap<String, MediaEntry>,
    requests: HashMap<u64, PendingMedia>,
    visible: HashSet<String>,
    next_request_id: u64,
    clock: u64,
}

struct MediaEntry {
    state: MediaState,
    last_used: u64,
}

enum MediaState {
    Loading {
        request_id: u64,
    },
    Loaded {
        image: Arc<Image>,
        resident_bytes: usize,
    },
    Failed,
}

struct PendingMedia {
    cache_key: String,
    expected_mime_type: Option<String>,
}

impl Default for MediaCache {
    fn default() -> Self {
        Self {
            entries: HashMap::new(),
            requests: HashMap::new(),
            visible: HashSet::new(),
            next_request_id: 1,
            clock: 0,
        }
    }
}

impl MediaCache {
    pub fn sync(
        &mut self,
        desired: impl IntoIterator<Item = MediaDescriptor>,
        commands: &UnboundedSender<ClientCommand>,
    ) -> Vec<Arc<Image>> {
        let mut desired_keys = HashSet::new();
        let desired = desired
            .into_iter()
            .filter(|descriptor| desired_keys.insert(descriptor.cache_key.clone()))
            .collect::<Vec<_>>();
        let visible = desired
            .iter()
            .take(MEDIA_CACHE_ITEMS)
            .map(|descriptor| descriptor.cache_key.clone())
            .collect::<HashSet<_>>();
        let mut released = Vec::new();

        let stale = self
            .entries
            .iter()
            .filter(|(key, entry)| {
                !desired_keys.contains(*key)
                    && matches!(entry.state, MediaState::Loading { .. } | MediaState::Failed)
            })
            .map(|(key, _)| key.clone())
            .collect::<Vec<_>>();
        for key in stale {
            if let Some(MediaEntry {
                state: MediaState::Loading { request_id },
                ..
            }) = self.entries.remove(&key)
            {
                self.requests.remove(&request_id);
                let _ = commands.send(ClientCommand::CancelMedia { request_id });
            }
        }

        for descriptor in desired.iter().skip(MEDIA_CACHE_ITEMS) {
            let key = &descriptor.cache_key;
            if let Some(entry) = self.entries.remove(key) {
                match entry.state {
                    MediaState::Loading { request_id } => {
                        self.requests.remove(&request_id);
                        let _ = commands.send(ClientCommand::CancelMedia { request_id });
                    }
                    MediaState::Loaded { image, .. } => released.push(image),
                    MediaState::Failed => {}
                }
            }
            self.entries.insert(
                key.clone(),
                MediaEntry {
                    state: MediaState::Failed,
                    last_used: self.clock,
                },
            );
        }

        self.visible = visible;
        for descriptor in desired.into_iter().take(MEDIA_CACHE_ITEMS) {
            let key = descriptor.cache_key;
            self.clock = self.clock.wrapping_add(1);
            if let Some(entry) = self.entries.get_mut(&key) {
                entry.last_used = self.clock;
                continue;
            }

            let request_id = self.next_request_id;
            self.next_request_id = self.next_request_id.wrapping_add(1).max(1);
            self.requests.insert(
                request_id,
                PendingMedia {
                    cache_key: key.clone(),
                    expected_mime_type: descriptor.mime_type,
                },
            );
            self.entries.insert(
                key.clone(),
                MediaEntry {
                    state: MediaState::Loading { request_id },
                    last_used: self.clock,
                },
            );
            if commands
                .send(ClientCommand::LoadMedia {
                    request_id,
                    source: descriptor.source,
                })
                .is_err()
            {
                self.requests.remove(&request_id);
                if let Some(entry) = self.entries.get_mut(&key) {
                    entry.state = MediaState::Failed;
                }
            }
        }
        released.extend(self.prune());
        released
    }

    pub fn loaded(
        &mut self,
        request_id: u64,
        bytes: Arc<[u8]>,
        mime_type: Option<String>,
    ) -> Vec<Arc<Image>> {
        let Some(pending) = self.requests.remove(&request_id) else {
            return Vec::new();
        };
        let Some(entry) = self.entries.get(&pending.cache_key) else {
            return Vec::new();
        };
        if !matches!(entry.state, MediaState::Loading { request_id: active } if active == request_id)
        {
            return Vec::new();
        }

        let loaded_bytes = self
            .entries
            .values()
            .filter_map(|entry| match entry.state {
                MediaState::Loaded { resident_bytes, .. } => Some(resident_bytes),
                _ => None,
            })
            .sum::<usize>();
        let format = image_format(
            mime_type
                .as_deref()
                .or(pending.expected_mime_type.as_deref()),
            &bytes,
        );
        let resident_bytes = format.and_then(|format| image_resident_bytes(format, &bytes));
        let within_budget = resident_bytes.is_some_and(|resident_bytes| {
            resident_bytes <= MEDIA_CACHE_BYTES
                && loaded_bytes
                    .checked_add(resident_bytes)
                    .is_some_and(|total| total <= MEDIA_CACHE_BYTES)
        });
        let entry = self
            .entries
            .get_mut(&pending.cache_key)
            .expect("the active media entry must still exist");
        entry.state = match (format, resident_bytes) {
            (Some(format), Some(resident_bytes)) if within_budget => MediaState::Loaded {
                image: Arc::new(Image::from_bytes(format, bytes.to_vec())),
                resident_bytes,
            },
            _ => MediaState::Failed,
        };
        self.prune()
    }

    pub fn failed(&mut self, request_id: u64) {
        let Some(pending) = self.requests.remove(&request_id) else {
            return;
        };
        if let Some(entry) = self.entries.get_mut(&pending.cache_key) {
            if matches!(entry.state, MediaState::Loading { request_id: active } if active == request_id)
            {
                entry.state = MediaState::Failed;
            }
        }
    }

    pub fn visual(&self, cache_key: &str) -> MediaVisual<'_> {
        match self.entries.get(cache_key).map(|entry| &entry.state) {
            Some(MediaState::Loading { .. }) => MediaVisual::Loading,
            Some(MediaState::Loaded { image, .. }) => MediaVisual::Loaded(image),
            Some(MediaState::Failed) => MediaVisual::Failed,
            None => MediaVisual::Missing,
        }
    }

    pub fn clear(&mut self, commands: &UnboundedSender<ClientCommand>) -> Vec<Arc<Image>> {
        for request_id in self.requests.keys().copied().collect::<Vec<_>>() {
            let _ = commands.send(ClientCommand::CancelMedia { request_id });
        }
        let released = self
            .entries
            .drain()
            .filter_map(|(_, entry)| match entry.state {
                MediaState::Loaded { image, .. } => Some(image),
                _ => None,
            })
            .collect();
        self.requests.clear();
        self.visible.clear();
        released
    }

    fn prune(&mut self) -> Vec<Arc<Image>> {
        let mut released = Vec::new();
        loop {
            let loaded_count = self
                .entries
                .values()
                .filter(|entry| matches!(entry.state, MediaState::Loaded { .. }))
                .count();
            let loaded_bytes = self
                .entries
                .values()
                .filter_map(|entry| match entry.state {
                    MediaState::Loaded { resident_bytes, .. } => Some(resident_bytes),
                    _ => None,
                })
                .sum::<usize>();
            if loaded_count <= MEDIA_CACHE_ITEMS && loaded_bytes <= MEDIA_CACHE_BYTES {
                break;
            }
            let Some(oldest) = self
                .entries
                .iter()
                .filter(|(key, entry)| {
                    !self.visible.contains(*key) && matches!(entry.state, MediaState::Loaded { .. })
                })
                .min_by_key(|(_, entry)| entry.last_used)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            if let Some(MediaEntry {
                state: MediaState::Loaded { image, .. },
                ..
            }) = self.entries.remove(&oldest)
            {
                released.push(image);
            }
        }
        released
    }
}

fn image_resident_bytes(format: ImageFormat, bytes: &[u8]) -> Option<usize> {
    let decoded_bytes = match format {
        ImageFormat::Gif => gif_decoded_bytes(bytes)?,
        ImageFormat::Svg => {
            if bytes.len() > MAX_SVG_BYTES {
                return None;
            }
            let tree = usvg::Tree::from_data(bytes, &usvg::Options::default()).ok()?;
            decoded_bytes(
                tree.size().width().ceil() as u64,
                tree.size().height().ceil() as u64,
                1,
            )?
        }
        format => {
            let format = match format {
                ImageFormat::Png => image::ImageFormat::Png,
                ImageFormat::Jpeg => image::ImageFormat::Jpeg,
                ImageFormat::Webp => image::ImageFormat::WebP,
                ImageFormat::Bmp => image::ImageFormat::Bmp,
                ImageFormat::Tiff => image::ImageFormat::Tiff,
                ImageFormat::Gif | ImageFormat::Svg => return None,
            };
            let (width, height) = image::ImageReader::with_format(Cursor::new(bytes), format)
                .into_dimensions()
                .ok()?;
            decoded_bytes(u64::from(width), u64::from(height), 1)?
        }
    };
    bytes.len().checked_add(decoded_bytes)
}

fn decoded_bytes(width: u64, height: u64, frames: u64) -> Option<usize> {
    if width == 0
        || height == 0
        || width > u64::from(MAX_IMAGE_DIMENSION)
        || height > u64::from(MAX_IMAGE_DIMENSION)
        || frames == 0
    {
        return None;
    }
    let bytes = width
        .checked_mul(height)?
        .checked_mul(4)?
        .checked_mul(frames)?;
    (bytes <= MAX_DECODED_IMAGE_BYTES as u64).then_some(bytes as usize)
}

fn gif_decoded_bytes(bytes: &[u8]) -> Option<usize> {
    if bytes.len() < 13 || !(bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a")) {
        return None;
    }
    let width = u16::from_le_bytes([bytes[6], bytes[7]]) as u64;
    let height = u16::from_le_bytes([bytes[8], bytes[9]]) as u64;
    let packed = bytes[10];
    let mut cursor = 13_usize;
    if packed & 0x80 != 0 {
        let table_bytes = 3_usize.checked_mul(1_usize << ((packed & 0x07) + 1))?;
        cursor = cursor.checked_add(table_bytes)?;
    }

    let mut frames = 0_u64;
    loop {
        let marker = *bytes.get(cursor)?;
        cursor += 1;
        match marker {
            0x3b => break,
            0x21 => {
                cursor = cursor.checked_add(1)?;
                skip_gif_sub_blocks(bytes, &mut cursor)?;
            }
            0x2c => {
                let descriptor = bytes.get(cursor..cursor.checked_add(9)?)?;
                cursor += 9;
                if descriptor[8] & 0x80 != 0 {
                    let table_bytes =
                        3_usize.checked_mul(1_usize << ((descriptor[8] & 0x07) + 1))?;
                    cursor = cursor.checked_add(table_bytes)?;
                }
                cursor = cursor.checked_add(1)?;
                skip_gif_sub_blocks(bytes, &mut cursor)?;
                frames = frames.checked_add(1)?;
                decoded_bytes(width, height, frames)?;
            }
            _ => return None,
        }
    }
    decoded_bytes(width, height, frames)
}

fn skip_gif_sub_blocks(bytes: &[u8], cursor: &mut usize) -> Option<()> {
    loop {
        let length = usize::from(*bytes.get(*cursor)?);
        *cursor = cursor.checked_add(1)?;
        if length == 0 {
            return Some(());
        }
        *cursor = cursor.checked_add(length)?;
        bytes.get(..*cursor)?;
    }
}

pub(super) fn release_assets(images: Vec<Arc<Image>>, cx: &mut gpui::App) {
    for image in images {
        image.remove_asset(cx);
    }
}

fn image_format(mime_type: Option<&str>, bytes: &[u8]) -> Option<ImageFormat> {
    let mime_type = mime_type
        .and_then(|value| value.split(';').next())
        .map(str::trim)
        .map(str::to_ascii_lowercase);
    if let Some(format) = mime_type.as_deref().and_then(ImageFormat::from_mime_type) {
        return Some(format);
    }
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some(ImageFormat::Png)
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some(ImageFormat::Jpeg)
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some(ImageFormat::Gif)
    } else if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        Some(ImageFormat::Webp)
    } else if bytes.starts_with(b"BM") {
        Some(ImageFormat::Bmp)
    } else if bytes.starts_with(b"II*\0") || bytes.starts_with(b"MM\0*") {
        Some(ImageFormat::Tiff)
    } else {
        let prefix = String::from_utf8_lossy(&bytes[..bytes.len().min(1024)]);
        (prefix.contains("<svg") && !prefix.contains("<!ENTITY")).then_some(ImageFormat::Svg)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn one_pixel_png() -> Arc<[u8]> {
        let mut bytes = Vec::new();
        image::DynamicImage::ImageRgba8(image::RgbaImage::new(1, 1))
            .write_to(&mut Cursor::new(&mut bytes), image::ImageFormat::Png)
            .expect("the test image should encode");
        Arc::from(bytes)
    }

    #[test]
    fn detects_supported_image_formats_from_mime_or_bytes() {
        assert_eq!(
            image_format(Some("image/jpeg; charset=binary"), b"not decoded yet"),
            Some(ImageFormat::Jpeg)
        );
        assert_eq!(
            image_format(None, b"\x89PNG\r\n\x1a\nrest"),
            Some(ImageFormat::Png)
        );
        assert_eq!(image_format(None, b"not an image"), None);
        assert!(image_resident_bytes(ImageFormat::Png, &one_pixel_png()).is_some());
    }

    #[test]
    fn rejects_animated_images_that_expand_past_the_decode_budget() {
        let mut gif = b"GIF89a\x00\x10\x00\x10\x00\x00\x00".to_vec();
        let frame = b"\x2c\x00\x00\x00\x00\x00\x10\x00\x10\x00\x02\x01\x00\x00";
        gif.extend_from_slice(frame);
        gif.extend_from_slice(frame);
        gif.push(0x3b);

        assert_eq!(gif_decoded_bytes(&gif), None);
    }

    #[test]
    fn leaving_a_loading_moment_cancels_its_request() {
        let (commands, mut receiver) = tokio::sync::mpsc::unbounded_channel();
        let mut cache = MediaCache::default();
        drop(cache.sync(
            [MediaDescriptor {
                cache_key: "remote:https://example.com/a.png".to_string(),
                source: MediaSource::Remote {
                    url: "https://example.com/a.png".to_string(),
                },
                mime_type: Some("image/png".to_string()),
            }],
            &commands,
        ));
        let command = receiver.try_recv().expect("load command");
        assert!(matches!(command, ClientCommand::LoadMedia { .. }));
        let ClientCommand::LoadMedia { request_id, .. } = command else {
            return;
        };

        drop(cache.sync([], &commands));

        assert!(matches!(
            receiver.try_recv(),
            Ok(ClientCommand::CancelMedia { request_id: cancelled }) if cancelled == request_id
        ));
    }

    #[test]
    fn selected_media_has_a_bounded_request_count() {
        let (commands, mut receiver) = tokio::sync::mpsc::unbounded_channel();
        let mut cache = MediaCache::default();
        let desired = (0..MEDIA_CACHE_ITEMS + 3).map(|index| MediaDescriptor {
            cache_key: format!("remote:https://example.com/{index}.png"),
            source: MediaSource::Remote {
                url: format!("https://example.com/{index}.png"),
            },
            mime_type: Some("image/png".to_string()),
        });

        drop(cache.sync(desired, &commands));

        let loads = std::iter::from_fn(|| receiver.try_recv().ok())
            .filter(|command| matches!(command, ClientCommand::LoadMedia { .. }))
            .count();
        assert_eq!(loads, MEDIA_CACHE_ITEMS);
    }

    #[test]
    fn completed_media_cannot_exceed_the_cache_budget() {
        let (commands, _receiver) = tokio::sync::mpsc::unbounded_channel();
        let mut cache = MediaCache::default();
        cache.entries.insert(
            "existing".to_string(),
            MediaEntry {
                state: MediaState::Loaded {
                    image: Arc::new(Image::empty()),
                    resident_bytes: MEDIA_CACHE_BYTES,
                },
                last_used: 0,
            },
        );
        let key = "remote:https://example.com/new.png".to_string();
        drop(cache.sync(
            [MediaDescriptor {
                cache_key: key.clone(),
                source: MediaSource::Remote {
                    url: "https://example.com/new.png".to_string(),
                },
                mime_type: Some("image/png".to_string()),
            }],
            &commands,
        ));
        let request_id = cache.entries.get(&key).and_then(|entry| match entry.state {
            MediaState::Loading { request_id } => Some(request_id),
            _ => None,
        });
        assert!(request_id.is_some(), "new media should start loading");

        drop(cache.loaded(
            request_id.unwrap_or_default(),
            one_pixel_png(),
            Some("image/png".to_string()),
        ));

        assert!(matches!(cache.visual(&key), MediaVisual::Failed));
    }
}
