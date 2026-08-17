use gpui::prelude::FluentBuilder as _;
use gpui::{
    div, img, px, relative, AnyElement, FontStyle, FontWeight, HighlightStyle,
    InteractiveElement as _, IntoElement, ObjectFit, ParentElement as _,
    StatefulInteractiveElement, StrikethroughStyle, Styled, StyledImage as _, UnderlineStyle,
};

use crate::client::{ClientCommand, MediaFileAction, MediaSource};
use crate::content::{
    MarkdownImage, MediaAttachment, MediaKind, RichBlock, RichListItem, RichTable, TableAlignment,
};
use crate::prepared::{
    is_allowed_external_link, PreparedContent, PreparedInlineText, PreparedMediaOrigin,
    PreparedMediaSource, PreparedTextSpan,
};
use crate::theme;

use super::media::{MediaCache, MediaDescriptor, MediaVisual};
use super::selection::{SelectableText, TextSelection};

pub(super) fn media_descriptors(
    content: &PreparedContent,
    include_markdown_images: bool,
) -> Vec<MediaDescriptor> {
    content
        .media()
        .iter()
        .filter(|descriptor| {
            include_markdown_images || descriptor.origin == PreparedMediaOrigin::Attachment
        })
        .map(|descriptor| MediaDescriptor {
            cache_key: descriptor.cache_key.to_string(),
            source: match &descriptor.source {
                PreparedMediaSource::Process { key } => MediaSource::Process {
                    key: key.to_string(),
                },
                PreparedMediaSource::Remote { url } => MediaSource::Remote {
                    url: url.to_string(),
                },
            },
            mime_type: descriptor.mime_type.as_deref().map(str::to_string),
        })
        .collect()
}

#[derive(Clone, Copy)]
pub(super) struct RichRenderContext<'a> {
    media: &'a MediaCache,
    commands: &'a tokio::sync::mpsc::UnboundedSender<ClientCommand>,
    base_size: f32,
    color: gpui::Hsla,
    stage_height: f32,
}

impl<'a> RichRenderContext<'a> {
    pub(super) fn new(
        media: &'a MediaCache,
        commands: &'a tokio::sync::mpsc::UnboundedSender<ClientCommand>,
        base_size: f32,
        color: gpui::Hsla,
        stage_height: f32,
    ) -> Self {
        Self {
            media,
            commands,
            base_size,
            color,
            stage_height,
        }
    }

    fn with_typography(self, base_size: f32, color: gpui::Hsla, stage_height: f32) -> Self {
        Self {
            base_size,
            color,
            stage_height,
            ..self
        }
    }
}

pub(super) fn render_document(
    content: PreparedContent,
    selection: &TextSelection,
    moment_id: &str,
    context: RichRenderContext<'_>,
) -> AnyElement {
    let document = content.document();
    let stage_height = if document.blocks.len() == 1 {
        context.stage_height.clamp(220.0, 620.0)
    } else {
        (context.stage_height * 0.64).clamp(210.0, 500.0)
    };
    let gap = (context.base_size * 0.52).clamp(13.0, 28.0);
    let context = context.with_typography(context.base_size, context.color, stage_height);
    let mut cursor = PreparedBlockCursor::new(content.inline_text(), selection);
    let blocks = document
        .blocks
        .iter()
        .enumerate()
        .map(|(index, block)| {
            render_block(block, &mut cursor, &format!("{moment_id}:{index}"), context)
        })
        .collect::<Vec<_>>();
    div()
        .w_full()
        .flex()
        .flex_col()
        .gap(px(gap))
        .children(blocks)
        .into_any_element()
}

struct PreparedBlockCursor<'a> {
    inlines: &'a [PreparedInlineText],
    selection: &'a TextSelection,
    next_block: usize,
    next_inline: usize,
    next_selection: u32,
}

impl<'a> PreparedBlockCursor<'a> {
    fn new(inlines: &'a [PreparedInlineText], selection: &'a TextSelection) -> Self {
        Self {
            inlines,
            selection,
            next_block: 0,
            next_inline: 0,
            next_selection: 1,
        }
    }

    fn begin_block(&mut self) -> usize {
        let ordinal = self.next_block;
        self.next_block += 1;
        ordinal
    }

    fn inline(&mut self, ordinal: usize) -> &'a PreparedInlineText {
        let inline = self
            .inlines
            .get(self.next_inline)
            .expect("prepared inline content must match its document");
        assert_eq!(
            inline.block_ordinal, ordinal,
            "prepared inline order must match its document"
        );
        self.next_inline += 1;
        inline
    }

    fn selectable(
        &mut self,
        id: impl Into<gpui::SharedString>,
        text: impl Into<gpui::SharedString>,
    ) -> SelectableText {
        let order = self.next_selection;
        self.next_selection = self.next_selection.saturating_add(1);
        SelectableText::new(id, self.selection.clone(), order, text)
    }
}

fn render_block(
    block: &RichBlock,
    cursor: &mut PreparedBlockCursor<'_>,
    id: &str,
    context: RichRenderContext<'_>,
) -> AnyElement {
    let RichRenderContext {
        media,
        commands,
        base_size,
        color,
        stage_height,
    } = context;
    let ordinal = cursor.begin_block();
    match block {
        RichBlock::Paragraph(_) => {
            let inline = cursor.inline(ordinal).clone();
            render_inlines(&inline, cursor, id, base_size, color)
        }
        RichBlock::Heading { level, .. } => {
            let scale = match level {
                1 => 1.32,
                2 => 1.2,
                3 => 1.1,
                _ => 1.0,
            };
            let inline = cursor.inline(ordinal).clone();
            div()
                .font_weight(if *level <= 2 {
                    FontWeight::SEMIBOLD
                } else {
                    FontWeight::MEDIUM
                })
                .child(render_inlines(
                    &inline,
                    cursor,
                    &format!("{id}:heading"),
                    (base_size * scale).min(82.0),
                    color,
                ))
                .into_any_element()
        }
        RichBlock::CodeBlock { language, code } => {
            let language = language
                .as_ref()
                .filter(|language| !language.trim().is_empty())
                .map(|language| language.to_ascii_uppercase());
            let language =
                language.map(|language| cursor.selectable(format!("{id}:language"), language));
            let code = cursor
                .selectable(format!("{id}:code"), code.clone())
                .separator_before("\n");
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
        } => render_list(items, *ordered, start.unwrap_or(1), cursor, id, context),
        RichBlock::BlockQuote(blocks) => {
            let blocks = blocks
                .iter()
                .enumerate()
                .map(|(index, block)| {
                    render_block(
                        block,
                        cursor,
                        &format!("{id}:quote:{index}"),
                        context.with_typography(
                            base_size * 0.92,
                            theme::color(theme::TEXT_QUIET),
                            stage_height,
                        ),
                    )
                })
                .collect::<Vec<_>>();
            div()
                .w_full()
                .pl(px((base_size * 0.55).clamp(16.0, 28.0)))
                .border_l_2()
                .border_color(theme::color(theme::TEXT_FAINT))
                .text_color(theme::color(theme::TEXT_QUIET))
                .flex()
                .flex_col()
                .gap(px((base_size * 0.4).clamp(10.0, 20.0)))
                .children(blocks)
                .into_any_element()
        }
        RichBlock::Rule => div()
            .w_full()
            .h(px(1.0))
            .bg(theme::color(theme::TEXT_FAINT))
            .into_any_element(),
        RichBlock::Table(table) => render_table(table, cursor, id, context),
        RichBlock::Image(image) => render_markdown_image(image, cursor, media, id, stage_height),
        RichBlock::Attachment(attachment) if attachment.kind == MediaKind::Image => {
            render_attachment_image(attachment, cursor, media, id, stage_height)
        }
        RichBlock::Attachment(attachment) => {
            render_attachment_card(attachment, cursor, commands, id, base_size, color)
        }
    }
}

fn render_table(
    table: &RichTable,
    cursor: &mut PreparedBlockCursor<'_>,
    id: &str,
    context: RichRenderContext<'_>,
) -> AnyElement {
    let RichRenderContext {
        base_size,
        color,
        stage_height,
        ..
    } = context;
    let cell_size = (base_size * 0.58).clamp(13.0, 27.0);
    let cell_media_height = (stage_height * 0.42).clamp(120.0, 280.0);
    let row_count = table.rows.len();
    let mut rendered_rows = Vec::with_capacity(row_count);
    for (row_index, row) in table.rows.iter().enumerate() {
        let cell_count = row.cells.len();
        let mut rendered_cells = Vec::with_capacity(cell_count);
        for (cell_index, cell) in row.cells.iter().enumerate() {
            let alignment = table
                .alignments
                .get(cell_index)
                .copied()
                .unwrap_or(TableAlignment::Default);
            let blocks = cell
                .blocks
                .iter()
                .enumerate()
                .map(|(block_index, block)| {
                    render_block(
                        block,
                        cursor,
                        &format!("{id}:row:{row_index}:cell:{cell_index}:{block_index}"),
                        context.with_typography(cell_size, color, cell_media_height),
                    )
                })
                .collect::<Vec<_>>();
            rendered_cells.push(
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
                    .children(blocks),
            );
        }
        rendered_rows.push(
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
                .children(rendered_cells),
        );
    }

    div()
        .w_full()
        .flex()
        .flex_col()
        .border_1()
        .border_color(theme::color(theme::TEXT_FAINT))
        .children(rendered_rows)
        .into_any_element()
}

fn render_list(
    items: &[RichListItem],
    ordered: bool,
    start: u32,
    cursor: &mut PreparedBlockCursor<'_>,
    id: &str,
    context: RichRenderContext<'_>,
) -> AnyElement {
    let base_size = context.base_size;
    let mut rendered_items = Vec::with_capacity(items.len());
    for (index, item) in items.iter().enumerate() {
        let marker = match item.checked {
            Some(true) => "✓".to_string(),
            Some(false) => "○".to_string(),
            None if ordered => format!("{}.", start.saturating_add(index as u32)),
            None => "·".to_string(),
        };
        let blocks = item
            .blocks
            .iter()
            .enumerate()
            .map(|(block_index, block)| {
                render_block(
                    block,
                    cursor,
                    &format!("{id}:item:{index}:{block_index}"),
                    context,
                )
            })
            .collect::<Vec<_>>();
        rendered_items.push(
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
                        .children(blocks),
                ),
        );
    }
    div()
        .w_full()
        .flex()
        .flex_col()
        .gap(px((base_size * 0.3).clamp(8.0, 16.0)))
        .children(rendered_items)
        .into_any_element()
}

fn render_inlines(
    inline: &PreparedInlineText,
    cursor: &mut PreparedBlockCursor<'_>,
    id: &str,
    size: f32,
    color: gpui::Hsla,
) -> AnyElement {
    let mut highlights = Vec::with_capacity(inline.spans.len());
    let mut link_ranges = Vec::new();
    let mut links = Vec::new();
    for span in inline.spans.iter() {
        let highlight = highlight_for_span(span);
        if let Some(link) = &span.link {
            link_ranges.push(span.range.clone());
            links.push(link.destination.to_string());
        }
        highlights.push((span.range.clone(), highlight));
    }
    let text = cursor
        .selectable(id.to_string(), inline.text.clone())
        .highlights(highlights)
        .links(link_ranges.into_iter().zip(links).collect::<Vec<_>>());
    div()
        .w_full()
        .text_size(px(size))
        .line_height(relative(crate::typography::line_height_for(size)))
        .text_color(color)
        .child(text)
        .into_any_element()
}

fn highlight_for_span(span: &PreparedTextSpan) -> HighlightStyle {
    let mut highlight = HighlightStyle::default();
    if span.style.bold {
        highlight.font_weight = Some(FontWeight::SEMIBOLD);
    }
    if span.style.italic {
        highlight.font_style = Some(FontStyle::Italic);
    }
    if span.style.strikethrough {
        highlight.strikethrough = Some(StrikethroughStyle {
            thickness: px(1.0),
            color: Some(theme::color(theme::TEXT_QUIET)),
        });
    }
    if span.style.code {
        highlight.color = Some(theme::color(theme::ACCENT));
        highlight.background_color = Some(theme::color(theme::SELECTION).opacity(0.58));
    }
    if span.link.is_some() {
        highlight.color = Some(theme::color(theme::ACCENT));
        highlight.underline = Some(UnderlineStyle {
            thickness: px(1.0),
            color: Some(theme::color(theme::ACCENT)),
            wavy: false,
        });
    }
    highlight
}

fn render_markdown_image(
    image: &MarkdownImage,
    cursor: &mut PreparedBlockCursor<'_>,
    media: &MediaCache,
    id: &str,
    stage_height: f32,
) -> AnyElement {
    let descriptor = markdown_image_descriptor(image);
    let caption = image
        .title
        .clone()
        .or_else(|| (!image.alt.trim().is_empty()).then_some(image.alt.clone()));
    let link = image
        .link
        .as_ref()
        .filter(|link| is_allowed_external_link(&link.destination))
        .map(|link| link.destination.trim().to_string());
    render_image_stage(
        descriptor.as_ref(),
        cursor,
        media,
        id,
        stage_height,
        caption,
        link,
    )
}

fn render_attachment_image(
    attachment: &MediaAttachment,
    cursor: &mut PreparedBlockCursor<'_>,
    media: &MediaCache,
    id: &str,
    stage_height: f32,
) -> AnyElement {
    let descriptor = attachment_descriptor(attachment);
    let caption = attachment
        .description
        .clone()
        .or_else(|| attachment.filename.clone());
    render_image_stage(
        descriptor.as_ref(),
        cursor,
        media,
        id,
        stage_height,
        caption,
        None,
    )
}

fn render_image_stage(
    descriptor: Option<&MediaDescriptor>,
    cursor: &mut PreparedBlockCursor<'_>,
    media: &MediaCache,
    id: &str,
    stage_height: f32,
    caption: Option<String>,
    link: Option<String>,
) -> AnyElement {
    let caption = caption.map(|caption| {
        cursor
            .selectable(format!("{id}:caption"), caption)
            .separator_before("\n")
    });
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
    attachment: &MediaAttachment,
    cursor: &mut PreparedBlockCursor<'_>,
    commands: &tokio::sync::mpsc::UnboundedSender<ClientCommand>,
    id: &str,
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
    let supporting_text = attachment
        .transcription
        .clone()
        .or_else(|| attachment.description.clone());
    let filename = attachment.filename.clone();
    let mime_type = Some(attachment.mime_type.clone());
    let source = attachment_source(attachment);
    let open = source.clone().map(|source| {
        let commands = commands.clone();
        div()
            .id(gpui::SharedString::from(format!("{id}:open")))
            .cursor_pointer()
            .font_family(theme::MONO_FONT)
            .text_size(px(10.0))
            .text_color(theme::color(theme::ACCENT))
            .on_click(move |_, _, cx| {
                cx.stop_propagation();
                let _ = commands.send(ClientCommand::MaterializeMedia {
                    source: source.clone(),
                    filename: filename.clone(),
                    mime_type: mime_type.clone(),
                    action: MediaFileAction::Open,
                });
            })
            .child("OPEN")
    });
    let save = source.map(|source| {
        let commands = commands.clone();
        let filename = attachment.filename.clone();
        let mime_type = Some(attachment.mime_type.clone());
        div()
            .id(gpui::SharedString::from(format!("{id}:save")))
            .cursor_pointer()
            .font_family(theme::MONO_FONT)
            .text_size(px(10.0))
            .text_color(theme::color(theme::TEXT_QUIET))
            .on_click(move |_, _, cx| {
                cx.stop_propagation();
                let _ = commands.send(ClientCommand::MaterializeMedia {
                    source: source.clone(),
                    filename: filename.clone(),
                    mime_type: mime_type.clone(),
                    action: MediaFileAction::Save,
                });
            })
            .child("SAVE")
    });
    let title = cursor.selectable(format!("{id}:title"), title);
    let kind = cursor
        .selectable(format!("{id}:kind"), kind)
        .separator_before("  ");
    let details = cursor
        .selectable(format!("{id}:details"), details.join("  ·  "))
        .separator_before("\n");
    let supporting_text = supporting_text.map(|supporting_text| {
        cursor
            .selectable(format!("{id}:supporting"), supporting_text)
            .separator_before("\n\n")
    });

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
                .child(details),
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
        .when(open.is_some() || save.is_some(), |this| {
            this.child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(18.0))
                    .children(open)
                    .children(save),
            )
        })
        .into_any_element()
}

fn attachment_source(attachment: &MediaAttachment) -> Option<MediaSource> {
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
        return Some(MediaSource::Process {
            key: key.to_string(),
        });
    }
    attachment
        .url
        .as_deref()
        .map(str::trim)
        .filter(|url| !url.is_empty())
        .map(|url| MediaSource::Remote {
            url: url.to_string(),
        })
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
    use crate::prepared::prepare_completed_assistant;

    #[test]
    fn plain_assistant_text_keeps_the_fast_renderer() {
        let plain = prepare_completed_assistant("One clear paragraph.".to_string(), Vec::new());
        let rich = prepare_completed_assistant("One **clear** paragraph.".to_string(), Vec::new());

        assert!(!plain.is_rich());
        assert!(rich.is_rich());
    }

    #[test]
    fn nested_markdown_images_share_the_remote_media_pipeline() {
        let content = prepare_completed_assistant(
            "> ![map](https://example.com/map.png)".to_string(),
            Vec::new(),
        );
        let descriptors = media_descriptors(&content, true);

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
    fn streaming_media_descriptors_suppress_markdown_urls_but_keep_attachments() {
        let attachment = MediaAttachment {
            kind: MediaKind::Image,
            mime_type: "image/png".to_string(),
            key: Some("agents/hank/media/result.png".to_string()),
            path: None,
            url: None,
            filename: None,
            size: None,
            duration: None,
            transcription: None,
            description: None,
        };
        let content = prepare_completed_assistant(
            "![changing](https://example.com/provisional.png)".to_string(),
            vec![attachment],
        );

        let provisional = media_descriptors(&content, false);
        let completed = media_descriptors(&content, true);

        assert_eq!(provisional.len(), 1);
        assert!(matches!(provisional[0].source, MediaSource::Process { .. }));
        assert_eq!(completed.len(), 2);
        assert!(matches!(completed[0].source, MediaSource::Remote { .. }));
    }

    #[test]
    fn table_images_share_the_remote_media_pipeline() {
        let content = prepare_completed_assistant(
            "| Result | Preview |\n| --- | --- |\n| ready | ![plot](https://example.com/plot.webp) |".to_string(),
            Vec::new(),
        );
        let descriptors = media_descriptors(&content, true);

        assert!(content.is_rich());
        assert_eq!(descriptors.len(), 1);
        assert_eq!(
            descriptors[0].source,
            MediaSource::Remote {
                url: "https://example.com/plot.webp".to_string()
            }
        );
    }
}
