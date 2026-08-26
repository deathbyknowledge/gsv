use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::ops::Range;
use std::sync::Arc;

use crate::content::{
    parse_markdown, FileResourceReference, MarkdownImage, MediaAttachment, MediaKind, RichBlock,
    RichDocument, RichInline,
};

/// Content-domain output that can be prepared away from GPUI's event thread and cheaply shared
/// with subsequent render frames.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct PreparedContent {
    revision: ContentRevision,
    document: Arc<RichDocument>,
    rich: bool,
    media: Arc<[PreparedMediaDescriptor]>,
    inline_text: Arc<[PreparedInlineText]>,
}

impl PreparedContent {
    pub(crate) fn revision(&self) -> ContentRevision {
        self.revision
    }

    pub(crate) fn document(&self) -> &Arc<RichDocument> {
        &self.document
    }

    pub(crate) fn is_rich(&self) -> bool {
        self.rich
    }

    pub(crate) fn media(&self) -> &[PreparedMediaDescriptor] {
        &self.media
    }

    /// Inline text in depth-first block order. `block_ordinal` counts every rich block, including
    /// structural blocks that do not themselves contain inline text.
    pub(crate) fn inline_text(&self) -> &[PreparedInlineText] {
        &self.inline_text
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub(crate) struct ContentRevision(u64);

impl ContentRevision {
    pub(crate) fn get(self) -> u64 {
        self.0
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct PreparedMediaDescriptor {
    pub cache_key: Arc<str>,
    pub source: PreparedMediaSource,
    pub mime_type: Option<Arc<str>>,
    pub origin: PreparedMediaOrigin,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum PreparedMediaOrigin {
    Markdown,
    Attachment,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum PreparedMediaSource {
    Process {
        key: Arc<str>,
    },
    Conversation {
        conversation_id: Arc<str>,
        key: Arc<str>,
    },
    Remote {
        url: Arc<str>,
    },
    Resource {
        reference: FileResourceReference,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct PreparedInlineText {
    pub block_ordinal: usize,
    pub text: Arc<str>,
    pub spans: Arc<[PreparedTextSpan]>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct PreparedTextSpan {
    pub range: Range<usize>,
    pub style: PreparedInlineStyle,
    pub link: Option<PreparedLink>,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct PreparedInlineStyle {
    pub bold: bool,
    pub italic: bool,
    pub strikethrough: bool,
    pub code: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct PreparedLink {
    pub destination: Arc<str>,
    pub title: Option<Arc<str>>,
}

pub(crate) fn is_allowed_external_link(destination: &str) -> bool {
    url::Url::parse(destination.trim())
        .is_ok_and(|url| matches!(url.scheme(), "http" | "https" | "mailto"))
}

/// Parse and normalize one completed intelligence response. The function has no GPUI or transport
/// dependencies, so callers can run it on a background executor and discard a stale result by its
/// revision before publishing it to the active conversation.
#[cfg(test)]
pub(crate) fn prepare_completed_assistant(
    text: String,
    attachments: Vec<MediaAttachment>,
) -> PreparedContent {
    let revision = content_revision(&text, &attachments);
    prepare_completed_assistant_with_revision(revision, &text, &attachments)
}

pub(crate) fn prepare_completed_assistant_with_revision(
    revision: ContentRevision,
    text: &str,
    attachments: &[MediaAttachment],
) -> PreparedContent {
    let document = Arc::new(parse_markdown(text).with_attachments(attachments));
    prepare_document(revision, document)
}

#[cfg(test)]
pub(crate) fn prepare_literal_content(
    text: String,
    attachments: Vec<MediaAttachment>,
) -> PreparedContent {
    let revision = content_revision(&text, &attachments);
    prepare_literal_content_with_revision(revision, &text, &attachments)
}

pub(crate) fn prepare_literal_content_with_revision(
    revision: ContentRevision,
    text: &str,
    attachments: &[MediaAttachment],
) -> PreparedContent {
    let document = Arc::new(RichDocument::literal(text).with_attachments(attachments));
    prepare_document(revision, document)
}

fn prepare_document(revision: ContentRevision, document: Arc<RichDocument>) -> PreparedContent {
    let rich = needs_rich_renderer(&document);

    let mut media = Vec::new();
    collect_media_descriptors(&document.blocks, &mut media);

    let mut inline_text = Vec::new();
    let mut block_ordinal = 0;
    collect_inline_text(&document.blocks, &mut block_ordinal, &mut inline_text);

    PreparedContent {
        revision,
        document,
        rich,
        media: media.into(),
        inline_text: inline_text.into(),
    }
}

pub(crate) fn content_revision(text: &str, attachments: &[MediaAttachment]) -> ContentRevision {
    let mut hasher = DefaultHasher::new();
    text.hash(&mut hasher);
    for attachment in attachments {
        match attachment.kind {
            MediaKind::Image => 0_u8,
            MediaKind::Audio => 1,
            MediaKind::Video => 2,
            MediaKind::Document => 3,
        }
        .hash(&mut hasher);
        attachment.mime_type.hash(&mut hasher);
        attachment.key.hash(&mut hasher);
        attachment.path.hash(&mut hasher);
        attachment.url.hash(&mut hasher);
        attachment.filename.hash(&mut hasher);
        attachment.size.hash(&mut hasher);
        attachment.duration.map(f64::to_bits).hash(&mut hasher);
        attachment.transcription.hash(&mut hasher);
        attachment.description.hash(&mut hasher);
    }
    ContentRevision(hasher.finish())
}

fn needs_rich_renderer(document: &RichDocument) -> bool {
    match document.blocks.as_slice() {
        [] => false,
        [RichBlock::Paragraph(inlines)] => !inlines
            .iter()
            .all(|inline| matches!(inline, RichInline::Text(_) | RichInline::Break { .. })),
        _ => true,
    }
}

fn collect_inline_text(
    blocks: &[RichBlock],
    next_ordinal: &mut usize,
    output: &mut Vec<PreparedInlineText>,
) {
    for block in blocks {
        let block_ordinal = *next_ordinal;
        *next_ordinal += 1;
        match block {
            RichBlock::Paragraph(inlines)
            | RichBlock::Heading {
                content: inlines, ..
            } => {
                output.push(prepare_inline_text(block_ordinal, inlines));
            }
            RichBlock::BlockQuote(children) => {
                collect_inline_text(children, next_ordinal, output);
            }
            RichBlock::List { items, .. } => {
                for item in items {
                    collect_inline_text(&item.blocks, next_ordinal, output);
                }
            }
            RichBlock::Table(table) => {
                for row in &table.rows {
                    for cell in &row.cells {
                        collect_inline_text(&cell.blocks, next_ordinal, output);
                    }
                }
            }
            RichBlock::CodeBlock { .. }
            | RichBlock::Rule
            | RichBlock::Image(_)
            | RichBlock::Attachment(_) => {}
        }
    }
}

fn prepare_inline_text(block_ordinal: usize, inlines: &[RichInline]) -> PreparedInlineText {
    let mut text = String::new();
    let mut spans = Vec::new();
    flatten_inlines(
        inlines,
        PreparedInlineStyle::default(),
        None,
        &mut text,
        &mut spans,
    );
    PreparedInlineText {
        block_ordinal,
        text: text.into(),
        spans: spans.into(),
    }
}

fn flatten_inlines(
    inlines: &[RichInline],
    style: PreparedInlineStyle,
    link: Option<&PreparedLink>,
    text: &mut String,
    spans: &mut Vec<PreparedTextSpan>,
) {
    for inline in inlines {
        match inline {
            RichInline::Text(value) | RichInline::Code(value) => {
                let mut leaf_style = style;
                if matches!(inline, RichInline::Code(_)) {
                    leaf_style.code = true;
                }
                append_text(value, leaf_style, link, text, spans);
            }
            RichInline::Break { hard } => {
                append_text(if *hard { "\n" } else { " " }, style, link, text, spans);
            }
            RichInline::Emphasis(children) => flatten_inlines(
                children,
                PreparedInlineStyle {
                    italic: true,
                    ..style
                },
                link,
                text,
                spans,
            ),
            RichInline::Strong(children) => flatten_inlines(
                children,
                PreparedInlineStyle {
                    bold: true,
                    ..style
                },
                link,
                text,
                spans,
            ),
            RichInline::Strikethrough(children) => flatten_inlines(
                children,
                PreparedInlineStyle {
                    strikethrough: true,
                    ..style
                },
                link,
                text,
                spans,
            ),
            RichInline::Link {
                destination,
                title,
                content,
            } => {
                let prepared_link = is_allowed_external_link(destination).then(|| PreparedLink {
                    destination: Arc::from(destination.trim()),
                    title: title.as_deref().map(Arc::from),
                });
                flatten_inlines(content, style, prepared_link.as_ref(), text, spans);
            }
        }
    }
}

fn append_text(
    value: &str,
    style: PreparedInlineStyle,
    link: Option<&PreparedLink>,
    text: &mut String,
    spans: &mut Vec<PreparedTextSpan>,
) {
    if value.is_empty() {
        return;
    }
    let start = text.len();
    text.push_str(value);
    let end = text.len();
    let link = link.cloned();

    if let Some(previous) = spans.last_mut() {
        if previous.range.end == start && previous.style == style && previous.link == link {
            previous.range.end = end;
            return;
        }
    }
    spans.push(PreparedTextSpan {
        range: start..end,
        style,
        link,
    });
}

fn collect_media_descriptors(blocks: &[RichBlock], output: &mut Vec<PreparedMediaDescriptor>) {
    for block in blocks {
        match block {
            RichBlock::Image(image) => {
                if let Some(descriptor) = markdown_image_descriptor(image) {
                    output.push(descriptor);
                }
            }
            RichBlock::Attachment(attachment) if attachment.kind == MediaKind::Image => {
                if let Some(descriptor) = attachment_descriptor(attachment) {
                    output.push(descriptor);
                }
            }
            RichBlock::BlockQuote(children) => collect_media_descriptors(children, output),
            RichBlock::List { items, .. } => {
                for item in items {
                    collect_media_descriptors(&item.blocks, output);
                }
            }
            RichBlock::Table(table) => {
                for row in &table.rows {
                    for cell in &row.cells {
                        collect_media_descriptors(&cell.blocks, output);
                    }
                }
            }
            _ => {}
        }
    }
}

fn markdown_image_descriptor(image: &MarkdownImage) -> Option<PreparedMediaDescriptor> {
    let url = image.url.trim();
    if url.is_empty() {
        return None;
    }
    Some(remote_descriptor(
        url,
        image_mime_from_url(url),
        PreparedMediaOrigin::Markdown,
    ))
}

fn attachment_descriptor(attachment: &MediaAttachment) -> Option<PreparedMediaDescriptor> {
    if let Some(reference) = &attachment.resource {
        return Some(PreparedMediaDescriptor {
            cache_key: Arc::from(format!(
                "resource:{}:{}:{}",
                reference.target, reference.path, reference.revision
            )),
            source: PreparedMediaSource::Resource {
                reference: reference.clone(),
            },
            mime_type: Some(Arc::from(reference.content_type.as_str())),
            origin: PreparedMediaOrigin::Attachment,
        });
    }
    if let Some(key) = attachment
        .key
        .as_deref()
        .or_else(|| {
            attachment
                .path
                .as_deref()
                .map(|path| path.trim_start_matches('/'))
        })
        .filter(|key| !key.is_empty())
    {
        if let Some(conversation_id) = attachment.conversation_id.as_deref() {
            return Some(PreparedMediaDescriptor {
                cache_key: Arc::from(format!("conversation:{conversation_id}:{key}")),
                source: PreparedMediaSource::Conversation {
                    conversation_id: Arc::from(conversation_id),
                    key: Arc::from(key),
                },
                mime_type: Some(Arc::from(attachment.mime_type.as_str())),
                origin: PreparedMediaOrigin::Attachment,
            });
        }
        return Some(PreparedMediaDescriptor {
            cache_key: Arc::from(format!("process:{key}")),
            source: PreparedMediaSource::Process {
                key: Arc::from(key),
            },
            mime_type: Some(Arc::from(attachment.mime_type.as_str())),
            origin: PreparedMediaOrigin::Attachment,
        });
    }
    let url = attachment.url.as_deref()?.trim();
    (!url.is_empty()).then(|| {
        remote_descriptor(
            url,
            Some(attachment.mime_type.as_str()),
            PreparedMediaOrigin::Attachment,
        )
    })
}

fn remote_descriptor(
    url: &str,
    mime_type: Option<&str>,
    origin: PreparedMediaOrigin,
) -> PreparedMediaDescriptor {
    PreparedMediaDescriptor {
        cache_key: Arc::from(format!("remote:{url}")),
        source: PreparedMediaSource::Remote {
            url: Arc::from(url),
        },
        mime_type: mime_type.map(Arc::from),
        origin,
    }
}

fn image_mime_from_url(url: &str) -> Option<&'static str> {
    let path = url.split(['?', '#']).next()?.to_ascii_lowercase();
    if path.ends_with(".png") {
        Some("image/png")
    } else if path.ends_with(".jpg") || path.ends_with(".jpeg") {
        Some("image/jpeg")
    } else if path.ends_with(".webp") {
        Some("image/webp")
    } else if path.ends_with(".gif") {
        Some("image/gif")
    } else if path.ends_with(".svg") {
        Some("image/svg+xml")
    } else if path.ends_with(".bmp") {
        Some("image/bmp")
    } else if path.ends_with(".tif") || path.ends_with(".tiff") {
        Some("image/tiff")
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn attachment(kind: MediaKind) -> MediaAttachment {
        MediaAttachment {
            kind,
            mime_type: "image/png".to_string(),
            key: None,
            conversation_id: None,
            path: None,
            url: None,
            filename: None,
            size: None,
            duration: None,
            transcription: None,
            description: None,
            resource: None,
        }
    }

    #[test]
    fn prepared_content_is_sendable_and_immutable_by_sharing() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<PreparedContent>();

        let prepared = prepare_completed_assistant("One **clear** result.".to_string(), Vec::new());
        let shared = prepared.document().clone();
        assert_eq!(Arc::strong_count(&shared), 2);
        assert!(prepared.is_rich());
    }

    #[test]
    fn revision_covers_text_and_media_semantics() {
        let mut image = attachment(MediaKind::Image);
        image.key = Some("agents/hank/media/plot.png".to_string());
        let original = content_revision("result", &[image.clone()]);

        assert_eq!(original, content_revision("result", &[image.clone()]));
        assert_ne!(original, content_revision("changed", &[image.clone()]));
        image.description = Some("A plot".to_string());
        assert_ne!(original, content_revision("result", &[image]));
    }

    #[test]
    fn resource_cache_identity_includes_the_immutable_revision() {
        let mut first = attachment(MediaKind::Image);
        first.resource = Some(FileResourceReference {
            target: "gsv".to_string(),
            path: "/root/image.png".to_string(),
            revision: "revision-one".to_string(),
            content_type: "image/png".to_string(),
            size: 3,
            expires_at: None,
        });
        let mut second = first.clone();
        second.resource.as_mut().expect("resource fixture").revision = "revision-two".to_string();

        let first = prepare_completed_assistant(String::new(), vec![first]);
        let second = prepare_completed_assistant(String::new(), vec![second]);

        assert_ne!(first.media()[0].cache_key, second.media()[0].cache_key);
    }

    #[test]
    fn prepared_candidate_reuses_the_supplied_revision() {
        let revision = content_revision("prepared once", &[]);
        let prepared = prepare_completed_assistant_with_revision(revision, "prepared once", &[]);

        assert_eq!(prepared.revision(), revision);
    }

    #[test]
    fn inline_text_is_flattened_once_with_composable_styles_and_links() {
        let prepared = prepare_completed_assistant(
            "Before **bold and _both_** [`code`](https://example.com) after.".to_string(),
            Vec::new(),
        );
        let inline = &prepared.inline_text()[0];

        assert_eq!(inline.text.as_ref(), "Before bold and both code after.");
        let both = inline
            .spans
            .iter()
            .find(|span| &inline.text[span.range.clone()] == "both")
            .expect("nested emphasis should retain a span");
        assert!(both.style.bold);
        assert!(both.style.italic);
        let code = inline
            .spans
            .iter()
            .find(|span| &inline.text[span.range.clone()] == "code")
            .expect("linked code should retain a span");
        assert!(code.style.code);
        assert_eq!(
            code.link.as_ref().map(|link| link.destination.as_ref()),
            Some("https://example.com")
        );
    }

    #[test]
    fn unsafe_markdown_links_remain_text_without_click_targets() {
        let prepared = prepare_completed_assistant(
            "[local](file:///tmp/private) [script](javascript:alert(1)) [safe](https://example.com)"
                .to_string(),
            Vec::new(),
        );
        let inline = &prepared.inline_text()[0];
        let linked = inline
            .spans
            .iter()
            .filter_map(|span| span.link.as_ref())
            .collect::<Vec<_>>();

        assert_eq!(linked.len(), 1);
        assert_eq!(linked[0].destination.as_ref(), "https://example.com");
        assert!(inline.text.contains("local"));
        assert!(inline.text.contains("script"));
    }

    #[test]
    fn media_is_normalized_in_document_order_before_rendering() {
        let mut process_image = attachment(MediaKind::Image);
        process_image.path = Some("/agents/hank/media/result.png".to_string());
        let prepared = prepare_completed_assistant(
            "> ![remote](https://example.com/map.webp?size=2)".to_string(),
            vec![process_image],
        );

        assert_eq!(prepared.media().len(), 2);
        assert_eq!(
            prepared.media()[0],
            PreparedMediaDescriptor {
                cache_key: Arc::from("remote:https://example.com/map.webp?size=2"),
                source: PreparedMediaSource::Remote {
                    url: Arc::from("https://example.com/map.webp?size=2")
                },
                mime_type: Some(Arc::from("image/webp")),
                origin: PreparedMediaOrigin::Markdown,
            }
        );
        assert_eq!(
            prepared.media()[1].source,
            PreparedMediaSource::Process {
                key: Arc::from("agents/hank/media/result.png")
            }
        );
        assert_eq!(prepared.media()[1].origin, PreparedMediaOrigin::Attachment);
    }

    #[test]
    fn plain_completed_text_keeps_the_plain_renderer_fast_path() {
        let prepared = prepare_completed_assistant("One clear paragraph.".to_string(), Vec::new());

        assert!(!prepared.is_rich());
        assert_eq!(prepared.inline_text().len(), 1);
        assert_eq!(prepared.inline_text()[0].block_ordinal, 0);
        assert_eq!(
            prepared.revision().get(),
            content_revision("One clear paragraph.", &[]).get()
        );
    }

    #[test]
    fn literal_preparation_does_not_interpret_markdown() {
        let prepared = prepare_literal_content("**literal**".to_string(), Vec::new());

        assert_eq!(
            prepared.document().blocks,
            vec![RichBlock::Paragraph(vec![RichInline::Text(
                "**literal**".to_string()
            )])]
        );
    }
}
