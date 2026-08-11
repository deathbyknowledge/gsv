use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::ops::Range;
use std::sync::Arc;

use gpui::prelude::FluentBuilder as _;
use gpui::{
    div, img, px, relative, AnyElement, FontStyle, FontWeight, HighlightStyle,
    InteractiveElement as _, InteractiveText, IntoElement, ObjectFit, ParentElement as _,
    StatefulInteractiveElement, StrikethroughStyle, Styled, StyledImage as _, StyledText,
    UnderlineStyle,
};

use crate::client::MediaSource;
use crate::content::{
    MarkdownImage, MediaAttachment, MediaKind, RichBlock, RichDocument, RichInline, RichListItem,
    RichTable, TableAlignment,
};
use crate::model::{Moment, MomentRole, MomentState};
use crate::theme;

use super::media::{MediaCache, MediaDescriptor, MediaVisual};

const RICH_DOCUMENT_CACHE_LIMIT: usize = 64;

#[derive(Clone)]
pub(super) struct CachedRichDocument {
    revision: u64,
    document: RichDocument,
}

impl CachedRichDocument {
    pub fn new(revision: u64, document: RichDocument) -> Self {
        Self { revision, document }
    }
}

pub(super) fn document_for_moment(
    cache: &mut std::collections::HashMap<String, CachedRichDocument>,
    id: &str,
    role: MomentRole,
    state: MomentState,
    text: &str,
    media: &[MediaAttachment],
) -> RichDocument {
    let build_document = || {
        Moment {
            id: id.to_string(),
            role,
            text: text.to_string(),
            media: media.to_vec(),
            run_id: None,
            state,
        }
        .content()
    };
    if role != MomentRole::Intelligence || state != MomentState::Complete {
        return build_document();
    }

    let revision = document_revision(text, media);
    if let Some(cached) = cache.get(id).filter(|cached| cached.revision == revision) {
        return cached.document.clone();
    }
    if cache.len() >= RICH_DOCUMENT_CACHE_LIMIT && !cache.contains_key(id) {
        cache.clear();
    }
    let document = build_document();
    cache.insert(
        id.to_string(),
        CachedRichDocument::new(revision, document.clone()),
    );
    document
}

pub(super) fn needs_rich_renderer(document: &RichDocument) -> bool {
    match document.blocks.as_slice() {
        [] => false,
        [RichBlock::Paragraph(inlines)] => !inlines
            .iter()
            .all(|inline| matches!(inline, RichInline::Text(_) | RichInline::Break { .. })),
        _ => true,
    }
}

pub(super) fn media_descriptors(document: &RichDocument) -> Vec<MediaDescriptor> {
    let mut descriptors = Vec::new();
    collect_media_descriptors(&document.blocks, &mut descriptors);
    descriptors
}

pub(super) fn render_document(
    document: RichDocument,
    media: &MediaCache,
    moment_id: &str,
    base_size: f32,
    color: gpui::Hsla,
    available_height: f32,
) -> AnyElement {
    let stage_height = if document.blocks.len() == 1 {
        available_height.clamp(220.0, 620.0)
    } else {
        (available_height * 0.64).clamp(210.0, 500.0)
    };
    let gap = (base_size * 0.52).clamp(13.0, 28.0);
    div()
        .w_full()
        .flex()
        .flex_col()
        .gap(px(gap))
        .children(
            document
                .blocks
                .into_iter()
                .enumerate()
                .map(|(index, block)| {
                    render_block(
                        block,
                        media,
                        &format!("{moment_id}:{index}"),
                        base_size,
                        color,
                        stage_height,
                    )
                }),
        )
        .into_any_element()
}

fn render_block(
    block: RichBlock,
    media: &MediaCache,
    id: &str,
    base_size: f32,
    color: gpui::Hsla,
    stage_height: f32,
) -> AnyElement {
    match block {
        RichBlock::Paragraph(inlines) => render_inlines(inlines, id, base_size, color),
        RichBlock::Heading { level, content } => {
            let scale = match level {
                1 => 1.32,
                2 => 1.2,
                3 => 1.1,
                _ => 1.0,
            };
            div()
                .font_weight(if level <= 2 {
                    FontWeight::SEMIBOLD
                } else {
                    FontWeight::MEDIUM
                })
                .child(render_inlines(
                    content,
                    &format!("{id}:heading"),
                    (base_size * scale).min(82.0),
                    color,
                ))
                .into_any_element()
        }
        RichBlock::CodeBlock { language, code } => {
            let language = language
                .filter(|language| !language.trim().is_empty())
                .map(|language| language.to_ascii_uppercase());
            div()
                .w_full()
                .flex()
                .flex_col()
                .gap(px(12.0))
                .px(px((base_size * 0.54).clamp(16.0, 26.0)))
                .py(px((base_size * 0.46).clamp(14.0, 24.0)))
                .border_1()
                .border_color(theme::color(theme::TEXT_FAINT))
                .bg(theme::color(theme::VOID).opacity(0.58))
                .when_some(language, |this, language| {
                    this.child(
                        div()
                            .font_family(theme::MONO_FONT)
                            .text_size(px(9.0))
                            .text_color(theme::color(theme::TEXT_FAINT))
                            .child(language),
                    )
                })
                .child(
                    div()
                        .font_family(theme::MONO_FONT)
                        .text_size(px((base_size * 0.62).clamp(14.0, 28.0)))
                        .line_height(relative(1.5))
                        .text_color(theme::color(theme::TEXT_QUIET))
                        .child(code),
                )
                .into_any_element()
        }
        RichBlock::List {
            ordered,
            start,
            items,
        } => render_list(
            items,
            ordered,
            start.unwrap_or(1),
            media,
            id,
            base_size,
            color,
            stage_height,
        ),
        RichBlock::BlockQuote(blocks) => div()
            .w_full()
            .pl(px((base_size * 0.55).clamp(16.0, 28.0)))
            .border_l_2()
            .border_color(theme::color(theme::TEXT_FAINT))
            .text_color(theme::color(theme::TEXT_QUIET))
            .flex()
            .flex_col()
            .gap(px((base_size * 0.4).clamp(10.0, 20.0)))
            .children(blocks.into_iter().enumerate().map(|(index, block)| {
                render_block(
                    block,
                    media,
                    &format!("{id}:quote:{index}"),
                    base_size * 0.92,
                    theme::color(theme::TEXT_QUIET),
                    stage_height,
                )
            }))
            .into_any_element(),
        RichBlock::Rule => div()
            .w_full()
            .h(px(1.0))
            .bg(theme::color(theme::TEXT_FAINT))
            .into_any_element(),
        RichBlock::Table(table) => render_table(table, media, id, base_size, color, stage_height),
        RichBlock::Image(image) => render_markdown_image(image, media, id, stage_height),
        RichBlock::Attachment(attachment) if attachment.kind == MediaKind::Image => {
            render_attachment_image(attachment, media, id, stage_height)
        }
        RichBlock::Attachment(attachment) => render_attachment_card(attachment, base_size, color),
    }
}

fn render_table(
    table: RichTable,
    media: &MediaCache,
    id: &str,
    base_size: f32,
    color: gpui::Hsla,
    stage_height: f32,
) -> AnyElement {
    let cell_size = (base_size * 0.58).clamp(13.0, 27.0);
    let cell_media_height = (stage_height * 0.42).clamp(120.0, 280.0);
    let row_count = table.rows.len();
    let alignments = Arc::new(table.alignments);

    div()
        .w_full()
        .flex()
        .flex_col()
        .border_1()
        .border_color(theme::color(theme::TEXT_FAINT))
        .children(table.rows.into_iter().enumerate().map(|(row_index, row)| {
            let cell_count = row.cells.len();
            let alignments = alignments.clone();
            div()
                .w_full()
                .flex()
                .when(row_index + 1 < row_count, |this| {
                    this.border_b_1()
                        .border_color(theme::color(theme::TEXT_FAINT))
                })
                .when(row.header, |this| {
                    this.bg(theme::color(theme::SELECTION).opacity(0.36))
                        .font_weight(FontWeight::SEMIBOLD)
                })
                .children(
                    row.cells
                        .into_iter()
                        .enumerate()
                        .map(move |(cell_index, cell)| {
                            let alignment = alignments
                                .get(cell_index)
                                .copied()
                                .unwrap_or(TableAlignment::Default);
                            div()
                                .min_w(px(0.0))
                                .flex_1()
                                .px(px((cell_size * 0.72).clamp(10.0, 18.0)))
                                .py(px((cell_size * 0.62).clamp(9.0, 16.0)))
                                .when(cell_index + 1 < cell_count, |this| {
                                    this.border_r_1()
                                        .border_color(theme::color(theme::TEXT_FAINT))
                                })
                                .when(alignment == TableAlignment::Left, |this| this.text_left())
                                .when(alignment == TableAlignment::Center, |this| {
                                    this.text_center()
                                })
                                .when(alignment == TableAlignment::Right, |this| this.text_right())
                                .flex()
                                .flex_col()
                                .gap(px((cell_size * 0.38).clamp(6.0, 12.0)))
                                .children(cell.blocks.into_iter().enumerate().map(
                                    |(block_index, block)| {
                                        render_block(
                                            block,
                                            media,
                                            &format!(
                                                "{id}:row:{row_index}:cell:{cell_index}:{block_index}"
                                            ),
                                            cell_size,
                                            color,
                                            cell_media_height,
                                        )
                                    },
                                ))
                        }),
                )
        }))
        .into_any_element()
}

#[allow(clippy::too_many_arguments)]
fn render_list(
    items: Vec<RichListItem>,
    ordered: bool,
    start: u32,
    media: &MediaCache,
    id: &str,
    base_size: f32,
    color: gpui::Hsla,
    stage_height: f32,
) -> AnyElement {
    div()
        .w_full()
        .flex()
        .flex_col()
        .gap(px((base_size * 0.3).clamp(8.0, 16.0)))
        .children(items.into_iter().enumerate().map(|(index, item)| {
            let marker = match item.checked {
                Some(true) => "✓".to_string(),
                Some(false) => "○".to_string(),
                None if ordered => format!("{}.", start.saturating_add(index as u32)),
                None => "·".to_string(),
            };
            div()
                .w_full()
                .flex()
                .items_start()
                .gap(px((base_size * 0.34).clamp(10.0, 18.0)))
                .child(
                    div()
                        .min_w(px((base_size * 0.7).clamp(22.0, 38.0)))
                        .font_family(theme::MONO_FONT)
                        .text_size(px((base_size * 0.54).clamp(12.0, 22.0)))
                        .text_color(theme::color(theme::TEXT_FAINT))
                        .child(marker),
                )
                .child(
                    div()
                        .min_w(px(0.0))
                        .flex_1()
                        .flex()
                        .flex_col()
                        .gap(px((base_size * 0.28).clamp(7.0, 14.0)))
                        .children(item.blocks.into_iter().enumerate().map(
                            |(block_index, block)| {
                                render_block(
                                    block,
                                    media,
                                    &format!("{id}:item:{index}:{block_index}"),
                                    base_size,
                                    color,
                                    stage_height,
                                )
                            },
                        )),
                )
        }))
        .into_any_element()
}

#[derive(Clone, Copy, Default)]
struct InlineStyle {
    bold: bool,
    italic: bool,
    strikethrough: bool,
    code: bool,
}

struct InlineLayout {
    text: String,
    highlights: Vec<(Range<usize>, HighlightStyle)>,
    link_ranges: Vec<Range<usize>>,
    links: Vec<String>,
}

fn render_inlines(inlines: Vec<RichInline>, id: &str, size: f32, color: gpui::Hsla) -> AnyElement {
    let mut layout = InlineLayout {
        text: String::new(),
        highlights: Vec::new(),
        link_ranges: Vec::new(),
        links: Vec::new(),
    };
    flatten_inlines(&inlines, InlineStyle::default(), None, &mut layout);
    let styled = StyledText::new(layout.text).with_highlights(layout.highlights);
    let text = if layout.link_ranges.is_empty() {
        styled.into_any_element()
    } else {
        let links = Arc::new(layout.links);
        InteractiveText::new(gpui::SharedString::from(id.to_string()), styled)
            .on_click(layout.link_ranges, move |index, _, cx| {
                if let Some(url) = links.get(index) {
                    cx.open_url(url);
                }
            })
            .into_any_element()
    };
    div()
        .w_full()
        .text_size(px(size))
        .line_height(relative(if size <= 34.0 { 1.42 } else { 1.31 }))
        .text_color(color)
        .child(text)
        .into_any_element()
}

fn flatten_inlines(
    inlines: &[RichInline],
    style: InlineStyle,
    link: Option<&str>,
    output: &mut InlineLayout,
) {
    for inline in inlines {
        match inline {
            RichInline::Text(text) | RichInline::Code(text) => {
                let mut leaf_style = style;
                if matches!(inline, RichInline::Code(_)) {
                    leaf_style.code = true;
                }
                append_inline(text, leaf_style, link, output);
            }
            RichInline::Break { hard } => {
                append_inline(if *hard { "\n" } else { " " }, style, link, output);
            }
            RichInline::Emphasis(children) => flatten_inlines(
                children,
                InlineStyle {
                    italic: true,
                    ..style
                },
                link,
                output,
            ),
            RichInline::Strong(children) => flatten_inlines(
                children,
                InlineStyle {
                    bold: true,
                    ..style
                },
                link,
                output,
            ),
            RichInline::Strikethrough(children) => flatten_inlines(
                children,
                InlineStyle {
                    strikethrough: true,
                    ..style
                },
                link,
                output,
            ),
            RichInline::Link {
                destination,
                content,
                ..
            } => flatten_inlines(content, style, Some(destination), output),
        }
    }
}

fn append_inline(text: &str, style: InlineStyle, link: Option<&str>, output: &mut InlineLayout) {
    if text.is_empty() {
        return;
    }
    let start = output.text.len();
    output.text.push_str(text);
    let range = start..output.text.len();
    let mut highlight = HighlightStyle::default();
    if style.bold {
        highlight.font_weight = Some(FontWeight::SEMIBOLD);
    }
    if style.italic {
        highlight.font_style = Some(FontStyle::Italic);
    }
    if style.strikethrough {
        highlight.strikethrough = Some(StrikethroughStyle {
            thickness: px(1.0),
            color: Some(theme::color(theme::TEXT_QUIET)),
        });
    }
    if style.code {
        highlight.color = Some(theme::color(theme::ACCENT));
        highlight.background_color = Some(theme::color(theme::SELECTION).opacity(0.58));
    }
    if let Some(link) = link {
        highlight.color = Some(theme::color(theme::ACCENT));
        highlight.underline = Some(UnderlineStyle {
            thickness: px(1.0),
            color: Some(theme::color(theme::ACCENT)),
            wavy: false,
        });
        output.link_ranges.push(range.clone());
        output.links.push(link.to_string());
    }
    output.highlights.push((range, highlight));
}

fn render_markdown_image(
    image: MarkdownImage,
    media: &MediaCache,
    id: &str,
    stage_height: f32,
) -> AnyElement {
    let descriptor = markdown_image_descriptor(&image);
    let caption = image
        .title
        .clone()
        .or_else(|| (!image.alt.trim().is_empty()).then_some(image.alt.clone()));
    let link = image.link.map(|link| link.destination);
    render_image_stage(descriptor.as_ref(), media, id, stage_height, caption, link)
}

fn render_attachment_image(
    attachment: MediaAttachment,
    media: &MediaCache,
    id: &str,
    stage_height: f32,
) -> AnyElement {
    let descriptor = attachment_descriptor(&attachment);
    let caption = attachment
        .description
        .clone()
        .or_else(|| attachment.filename.clone());
    render_image_stage(descriptor.as_ref(), media, id, stage_height, caption, None)
}

fn render_image_stage(
    descriptor: Option<&MediaDescriptor>,
    media: &MediaCache,
    id: &str,
    stage_height: f32,
    caption: Option<String>,
    link: Option<String>,
) -> AnyElement {
    let visual = descriptor
        .map(|descriptor| media.visual(&descriptor.cache_key))
        .unwrap_or(MediaVisual::Failed);
    let stage = match visual {
        MediaVisual::Loaded(image) => {
            let loading_height = stage_height;
            let fallback_height = stage_height;
            img(image.clone())
                .id(gpui::SharedString::from(format!("{id}:image")))
                .w_full()
                .h(px(stage_height))
                .object_fit(ObjectFit::Contain)
                .with_loading(move || media_placeholder("RENDERING IMAGE", loading_height))
                .with_fallback(move || {
                    media_placeholder("IMAGE COULD NOT BE OPENED", fallback_height)
                })
                .into_any_element()
        }
        MediaVisual::Loading | MediaVisual::Missing => {
            media_placeholder("LOADING IMAGE", stage_height)
        }
        MediaVisual::Failed => media_placeholder("IMAGE COULD NOT BE LOADED", stage_height),
    };
    let stage = if let Some(link) = link {
        div()
            .id(gpui::SharedString::from(format!("{id}:link")))
            .cursor_pointer()
            .on_click(move |_, _, cx| {
                cx.stop_propagation();
                cx.open_url(&link);
            })
            .child(stage)
            .into_any_element()
    } else {
        stage
    };

    div()
        .w_full()
        .flex()
        .flex_col()
        .gap(px(10.0))
        .child(stage)
        .when_some(caption, |this, caption| {
            this.child(
                div()
                    .font_family(theme::MONO_FONT)
                    .text_size(px(9.0))
                    .text_color(theme::color(theme::TEXT_FAINT))
                    .child(caption),
            )
        })
        .into_any_element()
}

fn media_placeholder(label: &'static str, height: f32) -> AnyElement {
    div()
        .w_full()
        .h(px(height))
        .flex()
        .items_center()
        .justify_center()
        .border_1()
        .border_color(theme::color(theme::TEXT_FAINT))
        .bg(theme::color(theme::VOID).opacity(0.42))
        .font_family(theme::MONO_FONT)
        .text_size(px(9.0))
        .text_color(theme::color(theme::TEXT_FAINT))
        .child(label)
        .into_any_element()
}

fn render_attachment_card(
    attachment: MediaAttachment,
    base_size: f32,
    color: gpui::Hsla,
) -> AnyElement {
    let kind = match attachment.kind {
        MediaKind::Image => "IMAGE",
        MediaKind::Audio => "AUDIO",
        MediaKind::Video => "VIDEO",
        MediaKind::Document => "DOCUMENT",
    };
    let title = attachment
        .filename
        .clone()
        .unwrap_or_else(|| kind.to_ascii_lowercase());
    let mut details = vec![attachment.mime_type.clone()];
    if let Some(size) = attachment.size {
        details.push(format_bytes(size));
    }
    if let Some(duration) = attachment.duration {
        details.push(format_duration(duration));
    }
    let supporting_text = attachment.transcription.or(attachment.description);

    div()
        .w_full()
        .flex()
        .flex_col()
        .gap(px(12.0))
        .px(px((base_size * 0.54).clamp(16.0, 26.0)))
        .py(px((base_size * 0.46).clamp(14.0, 24.0)))
        .border_1()
        .border_color(theme::color(theme::TEXT_FAINT))
        .child(
            div()
                .flex()
                .items_center()
                .justify_between()
                .gap(px(18.0))
                .child(
                    div()
                        .min_w(px(0.0))
                        .text_size(px((base_size * 0.72).clamp(16.0, 30.0)))
                        .text_color(color)
                        .child(title),
                )
                .child(
                    div()
                        .flex_shrink_0()
                        .font_family(theme::MONO_FONT)
                        .text_size(px(9.0))
                        .text_color(theme::color(theme::TEXT_FAINT))
                        .child(kind),
                ),
        )
        .child(
            div()
                .font_family(theme::MONO_FONT)
                .text_size(px(9.0))
                .text_color(theme::color(theme::TEXT_FAINT))
                .child(details.join("  ·  ")),
        )
        .when_some(supporting_text, |this, supporting_text| {
            this.child(
                div()
                    .pt(px(4.0))
                    .text_size(px((base_size * 0.62).clamp(15.0, 26.0)))
                    .line_height(relative(1.45))
                    .text_color(theme::color(theme::TEXT_QUIET))
                    .child(supporting_text),
            )
        })
        .into_any_element()
}

fn collect_media_descriptors(blocks: &[RichBlock], output: &mut Vec<MediaDescriptor>) {
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

fn markdown_image_descriptor(image: &MarkdownImage) -> Option<MediaDescriptor> {
    let url = image.url.trim();
    (!url.is_empty()).then(|| MediaDescriptor {
        cache_key: format!("remote:{url}"),
        source: MediaSource::Remote {
            url: url.to_string(),
        },
        mime_type: image_mime_from_url(url).map(str::to_string),
    })
}

fn attachment_descriptor(attachment: &MediaAttachment) -> Option<MediaDescriptor> {
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
        return Some(MediaDescriptor {
            cache_key: format!("process:{key}"),
            source: MediaSource::Process {
                key: key.to_string(),
            },
            mime_type: Some(attachment.mime_type.clone()),
        });
    }
    let url = attachment.url.as_deref()?.trim();
    (!url.is_empty()).then(|| MediaDescriptor {
        cache_key: format!("remote:{url}"),
        source: MediaSource::Remote {
            url: url.to_string(),
        },
        mime_type: Some(attachment.mime_type.clone()),
    })
}

fn document_revision(text: &str, media: &[MediaAttachment]) -> u64 {
    let mut hasher = DefaultHasher::new();
    text.hash(&mut hasher);
    for attachment in media {
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
    hasher.finish()
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

fn format_bytes(bytes: u64) -> String {
    const KIB: f64 = 1024.0;
    const MIB: f64 = KIB * 1024.0;
    let bytes = bytes as f64;
    if bytes >= MIB {
        format!("{:.1} MB", bytes / MIB)
    } else if bytes >= KIB {
        format!("{:.0} KB", bytes / KIB)
    } else {
        format!("{} B", bytes as u64)
    }
}

fn format_duration(seconds: f64) -> String {
    if seconds >= 60.0 {
        format!("{}:{:02}", (seconds / 60.0) as u64, (seconds % 60.0) as u64)
    } else {
        format!("{seconds:.1}s")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::content::parse_markdown;

    #[test]
    fn plain_assistant_text_keeps_the_fast_renderer() {
        let plain = parse_markdown("One clear paragraph.");
        let rich = parse_markdown("One **clear** paragraph.");

        assert!(!needs_rich_renderer(&plain));
        assert!(needs_rich_renderer(&rich));
    }

    #[test]
    fn nested_markdown_images_share_the_remote_media_pipeline() {
        let document = parse_markdown("> ![map](https://example.com/map.png)");
        let descriptors = media_descriptors(&document);

        assert_eq!(descriptors.len(), 1);
        assert_eq!(
            descriptors[0].source,
            MediaSource::Remote {
                url: "https://example.com/map.png".to_string()
            }
        );
        assert_eq!(descriptors[0].mime_type.as_deref(), Some("image/png"));
    }

    #[test]
    fn table_images_share_the_remote_media_pipeline() {
        let document = parse_markdown(
            "| Result | Preview |\n| --- | --- |\n| ready | ![plot](https://example.com/plot.webp) |",
        );
        let descriptors = media_descriptors(&document);

        assert!(needs_rich_renderer(&document));
        assert_eq!(descriptors.len(), 1);
        assert_eq!(
            descriptors[0].source,
            MediaSource::Remote {
                url: "https://example.com/plot.webp".to_string()
            }
        );
    }
}
