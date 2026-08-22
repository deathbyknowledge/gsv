use std::collections::HashMap;

use markdown::{
    mdast::{self, Node},
    ParseOptions,
};
use serde_json::Value;

#[derive(Clone, Debug, PartialEq)]
pub struct RichDocument {
    pub blocks: Vec<RichBlock>,
}

impl RichDocument {
    pub fn literal(text: &str) -> Self {
        let blocks = (!text.is_empty())
            .then_some(RichBlock::Paragraph(vec![RichInline::Text(
                text.to_string(),
            )]))
            .into_iter()
            .collect();
        Self { blocks }
    }

    pub fn with_attachments(mut self, attachments: &[MediaAttachment]) -> Self {
        self.blocks
            .extend(attachments.iter().cloned().map(RichBlock::Attachment));
        self
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum RichBlock {
    Paragraph(Vec<RichInline>),
    Heading {
        level: u8,
        content: Vec<RichInline>,
    },
    CodeBlock {
        language: Option<String>,
        code: String,
    },
    List {
        ordered: bool,
        start: Option<u32>,
        items: Vec<RichListItem>,
    },
    Table(RichTable),
    BlockQuote(Vec<RichBlock>),
    Rule,
    Image(MarkdownImage),
    Attachment(MediaAttachment),
}

#[derive(Clone, Debug, PartialEq)]
pub struct RichListItem {
    pub checked: Option<bool>,
    pub blocks: Vec<RichBlock>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RichTable {
    pub alignments: Vec<TableAlignment>,
    pub rows: Vec<RichTableRow>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RichTableRow {
    pub header: bool,
    pub cells: Vec<RichTableCell>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RichTableCell {
    pub blocks: Vec<RichBlock>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TableAlignment {
    Default,
    Left,
    Center,
    Right,
}

#[derive(Clone, Debug, PartialEq)]
pub enum RichInline {
    Text(String),
    Emphasis(Vec<RichInline>),
    Strong(Vec<RichInline>),
    Strikethrough(Vec<RichInline>),
    Code(String),
    Link {
        destination: String,
        title: Option<String>,
        content: Vec<RichInline>,
    },
    Break {
        hard: bool,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub struct MarkdownImage {
    pub url: String,
    pub alt: String,
    pub title: Option<String>,
    pub link: Option<RichLink>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RichLink {
    pub destination: String,
    pub title: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MediaKind {
    Image,
    Audio,
    Video,
    Document,
}

#[derive(Clone, Debug, PartialEq)]
pub struct MediaAttachment {
    pub kind: MediaKind,
    pub mime_type: String,
    pub key: Option<String>,
    pub conversation_id: Option<String>,
    pub path: Option<String>,
    pub url: Option<String>,
    pub filename: Option<String>,
    pub size: Option<u64>,
    pub duration: Option<f64>,
    pub transcription: Option<String>,
    pub description: Option<String>,
    pub resource: Option<FileResourceReference>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FileResourceReference {
    pub target: String,
    pub path: String,
    pub revision: String,
    pub content_type: String,
    pub size: u64,
    pub expires_at: Option<u64>,
}

pub fn parse_media_attachments(value: &Value) -> Vec<MediaAttachment> {
    let Some(items) = value.as_array() else {
        return Vec::new();
    };
    items.iter().filter_map(parse_media_attachment).collect()
}

fn parse_media_attachment(item: &Value) -> Option<MediaAttachment> {
    let item = item.as_object()?;
    if item.get("type").and_then(Value::as_str) == Some("resource") {
        return parse_resource_attachment(item);
    }
    let kind = match item.get("type").and_then(Value::as_str)? {
        "image" => MediaKind::Image,
        "audio" => MediaKind::Audio,
        "video" => MediaKind::Video,
        "document" => MediaKind::Document,
        _ => return None,
    };
    let mime_type = nonempty_string(item.get("mimeType"))?;
    Some(MediaAttachment {
        kind,
        mime_type,
        key: nonempty_string(item.get("key")),
        conversation_id: nonempty_string(item.get("conversationId")),
        path: nonempty_string(item.get("path")),
        url: nonempty_string(item.get("url")),
        filename: nonempty_string(item.get("filename")),
        size: item.get("size").and_then(Value::as_u64),
        duration: item.get("duration").and_then(Value::as_f64),
        transcription: nonempty_string(item.get("transcription")),
        description: nonempty_string(item.get("description")),
        resource: None,
    })
}

fn parse_resource_attachment(block: &serde_json::Map<String, Value>) -> Option<MediaAttachment> {
    const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
    if block.len() != 2 {
        return None;
    }
    let resource = block.get("ref")?.as_object()?;
    if !matches!(resource.len(), 6 | 7)
        || resource.get("type").and_then(Value::as_str) != Some("file")
    {
        return None;
    }
    let target = bounded_resource_string(resource.get("target"), 256)?;
    let path = bounded_resource_string(resource.get("path"), 8_192)?;
    let revision = bounded_resource_string(resource.get("revision"), 1_024)?;
    let content_type = bounded_resource_string(resource.get("contentType"), 256)?;
    let size = resource.get("size")?.as_u64()?;
    if size > MAX_SAFE_INTEGER {
        return None;
    }
    let expires_at = match resource.get("expiresAt") {
        Some(value) => {
            let expires_at = value.as_u64()?;
            if expires_at > MAX_SAFE_INTEGER {
                return None;
            }
            Some(expires_at)
        }
        None => None,
    };
    let kind = media_kind_from_content_type(&content_type);
    let filename = path
        .split('/')
        .rfind(|part| !part.is_empty())
        .map(str::to_string);
    Some(MediaAttachment {
        kind,
        mime_type: content_type.clone(),
        key: None,
        conversation_id: None,
        path: None,
        url: None,
        filename,
        size: Some(size),
        duration: None,
        transcription: None,
        description: None,
        resource: Some(FileResourceReference {
            target,
            path,
            revision,
            content_type,
            size,
            expires_at,
        }),
    })
}

fn bounded_resource_string(value: Option<&Value>, max_chars: usize) -> Option<String> {
    let value = nonempty_string(value)?;
    (value.chars().count() <= max_chars).then_some(value)
}

fn nonempty_string(value: Option<&Value>) -> Option<String> {
    value?
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn media_kind_from_content_type(content_type: &str) -> MediaKind {
    let normalized = content_type.to_ascii_lowercase();
    if normalized.starts_with("image/") {
        MediaKind::Image
    } else if normalized.starts_with("audio/") {
        MediaKind::Audio
    } else if normalized.starts_with("video/") {
        MediaKind::Video
    } else {
        MediaKind::Document
    }
}

pub fn parse_markdown(source: &str) -> RichDocument {
    let Ok(root) = markdown::to_mdast(source, &ParseOptions::gfm()) else {
        return RichDocument::literal(source);
    };
    let definitions = collect_definitions(&root);
    RichDocument {
        blocks: parse_blocks(&root, &definitions),
    }
}

type Definitions<'a> = HashMap<&'a str, (&'a str, Option<&'a str>)>;

fn collect_definitions(root: &Node) -> Definitions<'_> {
    fn visit<'a>(node: &'a Node, definitions: &mut Definitions<'a>) {
        if let Node::Definition(definition) = node {
            definitions.insert(
                definition.identifier.as_str(),
                (definition.url.as_str(), definition.title.as_deref()),
            );
        }
        if let Some(children) = node.children() {
            for child in children {
                visit(child, definitions);
            }
        }
    }

    let mut definitions = HashMap::new();
    visit(root, &mut definitions);
    definitions
}

fn parse_blocks(node: &Node, definitions: &Definitions<'_>) -> Vec<RichBlock> {
    match node {
        Node::Root(root) => root
            .children
            .iter()
            .flat_map(|child| parse_blocks(child, definitions))
            .collect(),
        Node::Paragraph(paragraph) => phrase_blocks(
            parse_phrasing(&paragraph.children, definitions),
            RichBlock::Paragraph,
        ),
        Node::Heading(heading) => {
            phrase_blocks(parse_phrasing(&heading.children, definitions), |content| {
                RichBlock::Heading {
                    level: heading.depth,
                    content,
                }
            })
        }
        Node::Code(code) => vec![RichBlock::CodeBlock {
            language: code.lang.clone(),
            code: code.value.clone(),
        }],
        Node::List(list) => vec![RichBlock::List {
            ordered: list.ordered,
            start: list.start,
            items: list
                .children
                .iter()
                .filter_map(|child| match child {
                    Node::ListItem(item) => Some(RichListItem {
                        checked: item.checked,
                        blocks: item
                            .children
                            .iter()
                            .flat_map(|child| parse_blocks(child, definitions))
                            .collect(),
                    }),
                    _ => None,
                })
                .collect(),
        }],
        Node::Table(table) => vec![RichBlock::Table(RichTable {
            alignments: table.align.iter().copied().map(table_alignment).collect(),
            rows: table
                .children
                .iter()
                .enumerate()
                .filter_map(|(index, child)| match child {
                    Node::TableRow(row) => Some(RichTableRow {
                        header: index == 0,
                        cells: row
                            .children
                            .iter()
                            .filter_map(|child| match child {
                                Node::TableCell(cell) => Some(RichTableCell {
                                    blocks: phrase_blocks(
                                        parse_phrasing(&cell.children, definitions),
                                        RichBlock::Paragraph,
                                    ),
                                }),
                                _ => None,
                            })
                            .collect(),
                    }),
                    _ => None,
                })
                .collect(),
        })],
        Node::Blockquote(blockquote) => vec![RichBlock::BlockQuote(
            blockquote
                .children
                .iter()
                .flat_map(|child| parse_blocks(child, definitions))
                .collect(),
        )],
        Node::ThematicBreak(_) => vec![RichBlock::Rule],
        Node::Image(image) => vec![RichBlock::Image(markdown_image(image))],
        Node::ImageReference(image) => definition_image(image, definitions)
            .map(RichBlock::Image)
            .into_iter()
            .collect(),
        Node::Definition(_) => Vec::new(),
        Node::Html(html) => RichDocument::literal(&html.value).blocks,
        other => {
            let text = other.to_string();
            RichDocument::literal(&text).blocks
        }
    }
}

fn table_alignment(alignment: mdast::AlignKind) -> TableAlignment {
    match alignment {
        mdast::AlignKind::None => TableAlignment::Default,
        mdast::AlignKind::Left => TableAlignment::Left,
        mdast::AlignKind::Center => TableAlignment::Center,
        mdast::AlignKind::Right => TableAlignment::Right,
    }
}

#[derive(Clone, Debug, PartialEq)]
enum PhrasePart {
    Inline(RichInline),
    Image(MarkdownImage),
}

fn parse_phrasing(children: &[Node], definitions: &Definitions<'_>) -> Vec<PhrasePart> {
    children
        .iter()
        .flat_map(|child| parse_phrase(child, definitions))
        .collect()
}

fn parse_phrase(node: &Node, definitions: &Definitions<'_>) -> Vec<PhrasePart> {
    match node {
        Node::Text(text) => text_parts(&text.value),
        Node::Emphasis(emphasis) => wrap_inline(
            parse_phrasing(&emphasis.children, definitions),
            RichInline::Emphasis,
        ),
        Node::Strong(strong) => wrap_inline(
            parse_phrasing(&strong.children, definitions),
            RichInline::Strong,
        ),
        Node::Delete(deleted) => wrap_inline(
            parse_phrasing(&deleted.children, definitions),
            RichInline::Strikethrough,
        ),
        Node::InlineCode(code) => vec![PhrasePart::Inline(RichInline::Code(code.value.clone()))],
        Node::InlineMath(math) => vec![PhrasePart::Inline(RichInline::Code(math.value.clone()))],
        Node::Break(_) => vec![PhrasePart::Inline(RichInline::Break { hard: true })],
        Node::Link(link) => link_parts(
            parse_phrasing(&link.children, definitions),
            RichLink {
                destination: link.url.clone(),
                title: link.title.clone(),
            },
        ),
        Node::LinkReference(link) => {
            let parts = parse_phrasing(&link.children, definitions);
            definitions
                .get(link.identifier.as_str())
                .map(|(url, title)| {
                    link_parts(
                        parts.clone(),
                        RichLink {
                            destination: (*url).to_string(),
                            title: title.map(str::to_string),
                        },
                    )
                })
                .unwrap_or(parts)
        }
        Node::Image(image) => vec![PhrasePart::Image(markdown_image(image))],
        Node::ImageReference(image) => definition_image(image, definitions)
            .map(PhrasePart::Image)
            .into_iter()
            .collect(),
        Node::Html(html) => text_parts(&html.value),
        Node::MdxTextExpression(expression) => text_parts(&expression.value),
        Node::FootnoteReference(footnote) => text_parts(&format!("[{}]", footnote.identifier)),
        other => other
            .children()
            .map(|children| parse_phrasing(children, definitions))
            .unwrap_or_else(|| text_parts(&other.to_string())),
    }
}

fn text_parts(text: &str) -> Vec<PhrasePart> {
    let mut parts = Vec::new();
    for (index, segment) in text.split('\n').enumerate() {
        if index > 0 {
            parts.push(PhrasePart::Inline(RichInline::Break { hard: false }));
        }
        if !segment.is_empty() {
            parts.push(PhrasePart::Inline(RichInline::Text(segment.to_string())));
        }
    }
    parts
}

fn wrap_inline(
    parts: Vec<PhrasePart>,
    wrap: impl Fn(Vec<RichInline>) -> RichInline,
) -> Vec<PhrasePart> {
    let mut output = Vec::new();
    let mut inlines = Vec::new();
    for part in parts {
        match part {
            PhrasePart::Inline(inline) => inlines.push(inline),
            PhrasePart::Image(image) => {
                if !inlines.is_empty() {
                    output.push(PhrasePart::Inline(wrap(std::mem::take(&mut inlines))));
                }
                output.push(PhrasePart::Image(image));
            }
        }
    }
    if !inlines.is_empty() {
        output.push(PhrasePart::Inline(wrap(inlines)));
    }
    output
}

fn link_parts(parts: Vec<PhrasePart>, link: RichLink) -> Vec<PhrasePart> {
    let mut output = Vec::new();
    let mut inlines = Vec::new();
    for part in parts {
        match part {
            PhrasePart::Inline(inline) => inlines.push(inline),
            PhrasePart::Image(mut image) => {
                if !inlines.is_empty() {
                    output.push(PhrasePart::Inline(RichInline::Link {
                        destination: link.destination.clone(),
                        title: link.title.clone(),
                        content: std::mem::take(&mut inlines),
                    }));
                }
                image.link = Some(link.clone());
                output.push(PhrasePart::Image(image));
            }
        }
    }
    if !inlines.is_empty() {
        output.push(PhrasePart::Inline(RichInline::Link {
            destination: link.destination,
            title: link.title,
            content: inlines,
        }));
    }
    output
}

fn phrase_blocks(
    parts: Vec<PhrasePart>,
    text_block: impl Fn(Vec<RichInline>) -> RichBlock,
) -> Vec<RichBlock> {
    let mut blocks = Vec::new();
    let mut inlines = Vec::new();
    for part in parts {
        match part {
            PhrasePart::Inline(inline) => inlines.push(inline),
            PhrasePart::Image(image) => {
                if !inlines.is_empty() {
                    blocks.push(text_block(std::mem::take(&mut inlines)));
                }
                blocks.push(RichBlock::Image(image));
            }
        }
    }
    if !inlines.is_empty() {
        blocks.push(text_block(inlines));
    }
    blocks
}

fn markdown_image(image: &mdast::Image) -> MarkdownImage {
    MarkdownImage {
        url: image.url.clone(),
        alt: image.alt.clone(),
        title: image.title.clone(),
        link: None,
    }
}

fn definition_image(
    image: &mdast::ImageReference,
    definitions: &Definitions<'_>,
) -> Option<MarkdownImage> {
    definitions
        .get(image.identifier.as_str())
        .map(|(url, title)| MarkdownImage {
            url: (*url).to_string(),
            alt: image.alt.clone(),
            title: title.map(str::to_string),
            link: None,
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_keeps_block_and_inline_semantics() {
        let document = parse_markdown(
            "# Result\n\nThis is *quiet*, **clear**, and [`typed`](https://example.com).\n\n```rust\nlet answer = 42;\n```\n\n> one\n>\n> two\n\n1. first\n2. second\n\n---",
        );

        assert!(matches!(
            document.blocks.first(),
            Some(RichBlock::Heading { level: 1, .. })
        ));
        assert!(matches!(
            document.blocks.get(1),
            Some(RichBlock::Paragraph(content))
                if content.iter().any(|part| matches!(part, RichInline::Emphasis(_)))
                    && content.iter().any(|part| matches!(part, RichInline::Strong(_)))
                    && content.iter().any(|part| matches!(part, RichInline::Link { .. }))
        ));
        assert!(document.blocks.iter().any(|block| matches!(
            block,
            RichBlock::CodeBlock { language: Some(language), code }
                if language == "rust" && code == "let answer = 42;"
        )));
        assert!(document
            .blocks
            .iter()
            .any(|block| matches!(block, RichBlock::BlockQuote(_))));
        assert!(document.blocks.iter().any(|block| matches!(
            block,
            RichBlock::List { ordered: true, start: Some(1), items }
                if items.len() == 2
        )));
        assert!(matches!(document.blocks.last(), Some(RichBlock::Rule)));
    }

    #[test]
    fn markdown_images_stay_in_source_order() {
        let document = parse_markdown(
            "Before ![sky](https://example.com/sky.jpg \"Morning\") after.\n\n[![map][map]][details]\n\n[map]: https://example.com/map.png\n[details]: https://example.com/details",
        );

        assert!(matches!(
            document.blocks.as_slice(),
            [
                RichBlock::Paragraph(before),
                RichBlock::Image(MarkdownImage { url: first_url, title: Some(title), .. }),
                RichBlock::Paragraph(after),
                RichBlock::Image(MarkdownImage { url: second_url, link: Some(RichLink { destination, .. }), .. })
            ] if before == &[RichInline::Text("Before ".to_string())]
                && first_url == "https://example.com/sky.jpg"
                && title == "Morning"
                && after == &[RichInline::Text(" after.".to_string())]
                && second_url == "https://example.com/map.png"
                && destination == "https://example.com/details"
        ));
    }

    #[test]
    fn markdown_distinguishes_soft_and_hard_breaks() {
        let document = parse_markdown("soft\nbreak  \nhard");
        assert!(matches!(
            document.blocks.first(),
            Some(RichBlock::Paragraph(content))
                if content.iter().any(|inline| matches!(inline, RichInline::Break { hard: false }))
                    && content.iter().any(|inline| matches!(inline, RichInline::Break { hard: true }))
        ));
    }

    #[test]
    fn markdown_preserves_gfm_table_structure_and_alignment() {
        let document = parse_markdown(
            "| Item | State | Detail |\n| :--- | :---: | ---: |\n| **Build** | `done` | [open](https://example.com) |\n| Preview | ![plot](https://example.com/plot.png) | 42 |",
        );

        assert!(matches!(document.blocks.first(), Some(RichBlock::Table(_))));
        let Some(RichBlock::Table(table)) = document.blocks.first() else {
            return;
        };
        assert_eq!(
            table.alignments,
            vec![
                TableAlignment::Left,
                TableAlignment::Center,
                TableAlignment::Right
            ]
        );
        assert_eq!(table.rows.len(), 3);
        assert!(table.rows[0].header);
        assert!(!table.rows[1].header);
        assert_eq!(table.rows[0].cells.len(), 3);
        assert!(matches!(
            table.rows[1].cells[0].blocks.as_slice(),
            [RichBlock::Paragraph(content)]
                if matches!(content.as_slice(), [RichInline::Strong(_)])
        ));
        assert!(matches!(
            table.rows[1].cells[2].blocks.as_slice(),
            [RichBlock::Paragraph(content)]
                if matches!(content.as_slice(), [RichInline::Link { destination, .. }]
                    if destination == "https://example.com")
        ));
        assert!(matches!(
            table.rows[2].cells[1].blocks.as_slice(),
            [RichBlock::Image(MarkdownImage { url, .. })]
                if url == "https://example.com/plot.png"
        ));
    }

    #[test]
    fn resource_blocks_are_validated_once_at_history_ingress() {
        let resource = serde_json::json!([{
            "type": "resource",
            "ref": {
                "type": "file",
                "target": "gsv",
                "path": "/root/.gsv/media/archived-media:one",
                "revision": "revision-one",
                "contentType": "image/png",
                "size": 3
            }
        }]);

        let media = parse_media_attachments(&resource);

        assert_eq!(media.len(), 1);
        assert_eq!(media[0].kind, MediaKind::Image);
        assert_eq!(media[0].filename.as_deref(), Some("archived-media:one"));
        assert_eq!(
            media[0].resource,
            Some(FileResourceReference {
                target: "gsv".to_string(),
                path: "/root/.gsv/media/archived-media:one".to_string(),
                revision: "revision-one".to_string(),
                content_type: "image/png".to_string(),
                size: 3,
                expires_at: None,
            })
        );
    }
}
