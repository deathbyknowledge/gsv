use std::collections::HashMap;

use markdown::{
    mdast::{self, Node},
    ParseOptions,
};

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
    pub path: Option<String>,
    pub url: Option<String>,
    pub filename: Option<String>,
    pub size: Option<u64>,
    pub duration: Option<f64>,
    pub transcription: Option<String>,
    pub description: Option<String>,
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
}
