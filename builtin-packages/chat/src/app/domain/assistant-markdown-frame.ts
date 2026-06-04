import { marked, type Token, type Tokens } from "marked";
import {
  layoutWithLines,
  measureLineStats,
  measureNaturalWidth,
  prepareWithSegments,
  type LayoutLine,
  type PreparedTextWithSegments,
} from "@chenglou/pretext";
import {
  materializeRichInlineLineRange,
  measureRichInlineStats,
  prepareRichInline,
  walkRichInlineLineRanges,
  type PreparedRichInline,
} from "@chenglou/pretext/rich-inline";

const SANS_FAMILY = "\"Inter\", \"Segoe UI\", sans-serif";
const MONO_FAMILY = "\"IBM Plex Mono\", \"SFMono-Regular\", Consolas, monospace";
const BODY_FONT = `400 15px ${SANS_FAMILY}`;
const BODY_STRONG_FONT = `700 15px ${SANS_FAMILY}`;
const BODY_EM_FONT = `italic 400 15px ${SANS_FAMILY}`;
const BODY_STRONG_EM_FONT = `italic 700 15px ${SANS_FAMILY}`;
const LINK_FONT = `500 15px ${SANS_FAMILY}`;
const H1_FONT = `800 20px ${SANS_FAMILY}`;
const H2_FONT = `800 17px ${SANS_FAMILY}`;
const H3_FONT = `800 15px ${SANS_FAMILY}`;
const INLINE_CODE_FONT = `500 12px ${MONO_FAMILY}`;
const CODE_FONT = `500 12px ${MONO_FAMILY}`;
const MARKER_FONT = `700 12px ${MONO_FAMILY}`;

const BODY_LINE_HEIGHT = 24;
const H1_LINE_HEIGHT = 30;
const H2_LINE_HEIGHT = 27;
const H3_LINE_HEIGHT = 24;
export const ASSISTANT_CODE_LINE_HEIGHT = 18;
export const ASSISTANT_CODE_PADDING_X = 12;
export const ASSISTANT_CODE_PADDING_Y = 9;
const BLOCK_GAP = 10;
const HARD_BREAK_GAP = 4;
const LIST_ITEM_GAP = 5;
const LIST_NESTING_INDENT = 20;
const BLOCKQUOTE_INDENT = 18;
const LIST_MARKER_GAP = 9;
const RULE_HEIGHT = 18;
const RAIL_OFFSET = 5;
const INLINE_CODE_EXTRA_WIDTH = 12;
const IMAGE_EXTRA_WIDTH = 14;

type InlineVariant = "body" | "heading-1" | "heading-2" | "heading-3";

type MarkState = {
  bold: boolean;
  italic: boolean;
  strike: boolean;
  href: string | null;
};

type ParseContext = {
  listDepth: number;
  quoteDepth: number;
};

type InlinePiece = {
  breakMode: "normal" | "never";
  className: string;
  extraWidth: number;
  font: string;
  href: string | null;
  text: string;
};

type PreparedBlockBase = {
  contentLeft: number;
  marginTop: number;
  markerClassName: string | null;
  markerLeft: number | null;
  markerText: string | null;
  quoteRailLefts: number[];
};

type PreparedInlineBlock = PreparedBlockBase & {
  kind: "inline";
  classNames: string[];
  flow: PreparedRichInline;
  hrefs: Array<string | null>;
  lineHeight: number;
};

type PreparedCodeBlock = PreparedBlockBase & {
  kind: "code";
  lineHeight: number;
  prepared: PreparedTextWithSegments;
};

type PreparedRuleBlock = PreparedBlockBase & {
  kind: "rule";
  height: number;
};

type PreparedBlock = PreparedInlineBlock | PreparedCodeBlock | PreparedRuleBlock;

type BlockFrameBase = {
  contentLeft: number;
  height: number;
  markerClassName: string | null;
  markerLeft: number | null;
  markerText: string | null;
  quoteRailLefts: number[];
  top: number;
};

type InlineBlockFrame = BlockFrameBase & {
  kind: "inline";
  lineHeight: number;
  usedWidth: number;
};

type CodeBlockFrame = BlockFrameBase & {
  kind: "code";
  lineHeight: number;
  width: number;
};

type RuleBlockFrame = BlockFrameBase & {
  kind: "rule";
  width: number;
};

type BlockFrame = InlineBlockFrame | CodeBlockFrame | RuleBlockFrame;

export type AssistantInlineFragmentLayout = {
  className: string;
  href: string | null;
  leadingGap: number;
  text: string;
};

export type AssistantMarkdownBlockLayout =
  | {
      contentLeft: number;
      height: number;
      kind: "inline";
      lineHeight: number;
      lines: Array<{
        fragments: AssistantInlineFragmentLayout[];
        width: number;
      }>;
      markerClassName: string | null;
      markerLeft: number | null;
      markerText: string | null;
      quoteRailLefts: number[];
      top: number;
    }
  | {
      contentLeft: number;
      height: number;
      kind: "code";
      lines: LayoutLine[];
      markerClassName: string | null;
      markerLeft: number | null;
      markerText: string | null;
      quoteRailLefts: number[];
      top: number;
      width: number;
    }
  | {
      contentLeft: number;
      height: number;
      kind: "rule";
      markerClassName: string | null;
      markerLeft: number | null;
      markerText: string | null;
      quoteRailLefts: number[];
      top: number;
      width: number;
    };

export type PreparedAssistantMarkdown = {
  blocks: PreparedBlock[];
};

export type AssistantMarkdownFrame = {
  blocks: AssistantMarkdownBlockLayout[];
  height: number;
  width: number;
};

const EMPTY_MARK_STATE: MarkState = {
  bold: false,
  italic: false,
  strike: false,
  href: null,
};

const markerWidthCache = new Map<string, number>();

export function prepareAssistantMarkdown(markdown: string): PreparedAssistantMarkdown {
  return {
    blocks: parseMarkdownBlocks(markdown),
  };
}

export function layoutAssistantMarkdown(prepared: PreparedAssistantMarkdown, width: number): AssistantMarkdownFrame {
  const contentWidth = Math.max(1, Math.floor(width));
  const frames: BlockFrame[] = [];
  let y = 0;

  for (const block of prepared.blocks) {
    y += block.marginTop;
    const frame = layoutBlockFrame(block, contentWidth, y);
    frames.push(frame);
    y += frame.height;
  }

  return {
    blocks: prepared.blocks.map((block, index) => materializeBlockLayout(block, frames[index] as BlockFrame, contentWidth)),
    height: Math.max(0, y),
    width: contentWidth,
  };
}

function parseMarkdownBlocks(markdown: string): PreparedBlock[] {
  try {
    const tokens = marked.lexer(markdown, { breaks: true, gfm: true });
    return parseBlockTokens(tokens, { listDepth: 0, quoteDepth: 0 });
  } catch {
    return buildPlainTextBlocks(markdown, "body", { listDepth: 0, quoteDepth: 0 });
  }
}

function parseBlockTokens(tokens: readonly Token[], ctx: ParseContext): PreparedBlock[] {
  const blocks: PreparedBlock[] = [];

  for (const token of tokens) {
    switch (token.type) {
      case "space":
      case "def":
        continue;

      case "paragraph":
        appendBlockGroup(blocks, buildInlineBlocksForToken(token, "body", ctx), BLOCK_GAP);
        continue;

      case "heading":
        appendBlockGroup(blocks, buildInlineBlocksForToken(token, headingVariant(tokenDepth(token)), ctx), BLOCK_GAP + 4);
        continue;

      case "code":
        appendBlockGroup(blocks, [buildCodeBlock(tokenText(token), ctx)], BLOCK_GAP);
        continue;

      case "list":
        appendBlockGroup(blocks, buildListBlocks(token as Tokens.List, ctx), BLOCK_GAP);
        continue;

      case "blockquote":
        appendBlockGroup(
          blocks,
          parseBlockTokens(tokenTokens(token), { listDepth: ctx.listDepth, quoteDepth: ctx.quoteDepth + 1 }),
          HARD_BREAK_GAP,
        );
        continue;

      case "hr":
        appendBlockGroup(blocks, [buildRuleBlock(ctx)], BLOCK_GAP + 2);
        continue;

      case "table":
        appendBlockGroup(blocks, [buildCodeBlock(formatTable(token as Tokens.Table), ctx)], BLOCK_GAP);
        continue;

      case "html": {
        const text = tokenText(token).trim().length > 0 ? tokenText(token) : tokenRaw(token);
        appendBlockGroup(blocks, [buildCodeBlock(text, ctx)], BLOCK_GAP);
        continue;
      }

      case "text":
        appendBlockGroup(blocks, buildInlineBlocksForToken(token, "body", ctx), BLOCK_GAP);
        continue;

      default: {
        const fallback = fallbackTextForToken(token);
        if (fallback) {
          appendBlockGroup(blocks, buildPlainTextBlocks(fallback, "body", ctx), BLOCK_GAP);
        }
      }
    }
  }

  return blocks;
}

function buildListBlocks(token: Tokens.List, ctx: ParseContext): PreparedBlock[] {
  const blocks: PreparedBlock[] = [];
  const itemCtx = {
    listDepth: ctx.listDepth + 1,
    quoteDepth: ctx.quoteDepth,
  };

  token.items.forEach((item, index) => {
    let itemBlocks = parseBlockTokens(item.tokens ?? [], itemCtx);
    if (itemBlocks.length === 0) {
      itemBlocks = buildPlainTextBlocks(item.text, "body", itemCtx);
    }
    decorateListItemBlocks(itemBlocks, resolveListMarkerText(token, item, index), resolveListMarkerClassName(token, item));
    appendBlockGroup(blocks, itemBlocks, LIST_ITEM_GAP);
  });

  return blocks;
}

function decorateListItemBlocks(blocks: PreparedBlock[], markerText: string, markerClassName: string): void {
  if (blocks.length === 0) {
    return;
  }
  const markerArea = measureMarkerWidth(markerText) + LIST_MARKER_GAP;
  for (let index = 0; index < blocks.length; index += 1) {
    blocks[index] = shiftBlock(blocks[index] as PreparedBlock, markerArea);
  }
  const firstBlock = blocks[0] as PreparedBlock;
  blocks[0] = {
    ...firstBlock,
    markerClassName,
    markerLeft: firstBlock.contentLeft - markerArea,
    markerText,
  };
}

function buildPlainTextBlocks(text: string, variant: InlineVariant, ctx: ParseContext): PreparedBlock[] {
  const piece = createTextPiece(text, EMPTY_MARK_STATE, variant);
  return piece ? buildPreparedInlineBlocks([[piece]], variant, ctx) : [];
}

function buildInlineBlocks(tokens: readonly Token[], variant: InlineVariant, ctx: ParseContext): PreparedBlock[] {
  const lines = collectInlinePieceLines(tokens, variant);
  return buildPreparedInlineBlocks(lines, variant, ctx);
}

function buildInlineBlocksForToken(token: Token, variant: InlineVariant, ctx: ParseContext): PreparedBlock[] {
  const tokens = tokenTokens(token);
  return tokens.length > 0
    ? buildInlineBlocks(tokens, variant, ctx)
    : buildPlainTextBlocks(tokenText(token), variant, ctx);
}

function buildPreparedInlineBlocks(lines: InlinePiece[][], variant: InlineVariant, ctx: ParseContext): PreparedBlock[] {
  const blocks: PreparedBlock[] = [];
  for (const pieces of lines) {
    const block = buildPreparedInlineBlock(pieces, variant, ctx);
    if (!block) {
      continue;
    }
    blocks.push({
      ...block,
      marginTop: blocks.length === 0 ? 0 : HARD_BREAK_GAP,
    });
  }
  return blocks;
}

function buildPreparedInlineBlock(pieces: InlinePiece[], variant: InlineVariant, ctx: ParseContext): PreparedInlineBlock | null {
  if (pieces.length === 0) {
    return null;
  }
  return {
    ...createBlockBase(ctx),
    classNames: pieces.map((piece) => piece.className),
    flow: prepareRichInline(pieces.map((piece) => ({
      break: piece.breakMode,
      extraWidth: piece.extraWidth,
      font: piece.font,
      text: piece.text,
    }))),
    hrefs: pieces.map((piece) => piece.href),
    kind: "inline",
    lineHeight: lineHeightForVariant(variant),
  };
}

function buildCodeBlock(text: string, ctx: ParseContext): PreparedCodeBlock {
  return {
    ...createBlockBase(ctx),
    kind: "code",
    lineHeight: ASSISTANT_CODE_LINE_HEIGHT,
    prepared: prepareWithSegments(stripSingleTrailingNewline(text), CODE_FONT, { whiteSpace: "pre-wrap" }),
  };
}

function buildRuleBlock(ctx: ParseContext): PreparedRuleBlock {
  return {
    ...createBlockBase(ctx),
    height: RULE_HEIGHT,
    kind: "rule",
  };
}

function createBlockBase(ctx: ParseContext): PreparedBlockBase {
  const listIndent = Math.max(0, ctx.listDepth - 1) * LIST_NESTING_INDENT;
  const contentLeft = listIndent + ctx.quoteDepth * BLOCKQUOTE_INDENT;
  const quoteRailLefts: number[] = [];
  for (let depth = 0; depth < ctx.quoteDepth; depth += 1) {
    quoteRailLefts.push(listIndent + depth * BLOCKQUOTE_INDENT + RAIL_OFFSET);
  }
  return {
    contentLeft,
    marginTop: 0,
    markerClassName: null,
    markerLeft: null,
    markerText: null,
    quoteRailLefts,
  };
}

function collectInlinePieceLines(tokens: readonly Token[], variant: InlineVariant): InlinePiece[][] {
  const lines: InlinePiece[][] = [[]];

  const currentLine = () => lines[lines.length - 1] as InlinePiece[];
  const pushLineBreak = () => lines.push([]);
  const pushPiece = (piece: InlinePiece | null) => {
    if (!piece) {
      return;
    }
    const line = currentLine();
    const previous = line[line.length - 1];
    if (previous && canMergeInlinePieces(previous, piece)) {
      previous.text += piece.text;
      return;
    }
    line.push(piece);
  };

  const walk = (tokenList: readonly Token[], marks: MarkState) => {
    for (const token of tokenList) {
      switch (token.type) {
        case "text":
          if (tokenTokens(token).length > 0) {
            walk(tokenTokens(token), marks);
          } else {
            pushPiece(createTextPiece(tokenText(token), marks, variant));
          }
          continue;

        case "escape":
          pushPiece(createTextPiece(tokenText(token), marks, variant));
          continue;

        case "strong":
          walk(tokenTokens(token), { ...marks, bold: true });
          continue;

        case "em":
          walk(tokenTokens(token), { ...marks, italic: true });
          continue;

        case "del":
          walk(tokenTokens(token), { ...marks, strike: true });
          continue;

        case "codespan":
          pushPiece(createCodePiece(tokenText(token)));
          continue;

        case "link":
          walk(tokenTokens(token), { ...marks, href: parseMarkdownHref(tokenHref(token)) });
          continue;

        case "image":
          pushPiece(createImagePiece(tokenText(token) || tokenHref(token) || "image"));
          continue;

        case "br":
          pushLineBreak();
          continue;

        case "checkbox":
          pushPiece(createTextPiece(tokenChecked(token) ? "[x] " : "[ ] ", marks, variant));
          continue;

        case "html":
          pushPiece(createTextPiece(tokenText(token), marks, variant));
          continue;

        default: {
          const fallback = fallbackTextForToken(token);
          if (fallback) {
            pushPiece(createTextPiece(fallback, marks, variant));
          }
        }
      }
    }
  };

  walk(tokens, EMPTY_MARK_STATE);
  while (lines.length > 0 && (lines[lines.length - 1] as InlinePiece[]).length === 0) {
    lines.pop();
  }
  return lines;
}

function createTextPiece(text: string, marks: MarkState, variant: InlineVariant): InlinePiece | null {
  if (!text) {
    return null;
  }
  return {
    breakMode: "normal",
    className: resolveTextClassName(variant, marks),
    extraWidth: 0,
    font: resolveTextFont(variant, marks),
    href: marks.href,
    text,
  };
}

function createCodePiece(text: string): InlinePiece | null {
  if (!text) {
    return null;
  }
  return {
    breakMode: "normal",
    className: "assistant-fragment assistant-fragment-code",
    extraWidth: INLINE_CODE_EXTRA_WIDTH,
    font: INLINE_CODE_FONT,
    href: null,
    text,
  };
}

function createImagePiece(text: string): InlinePiece {
  return {
    breakMode: "never",
    className: "assistant-fragment assistant-fragment-chip",
    extraWidth: IMAGE_EXTRA_WIDTH,
    font: `700 11px ${SANS_FAMILY}`,
    href: null,
    text,
  };
}

function canMergeInlinePieces(a: InlinePiece, b: InlinePiece): boolean {
  return a.breakMode === b.breakMode
    && a.className === b.className
    && a.extraWidth === b.extraWidth
    && a.font === b.font
    && a.href === b.href;
}

function resolveTextFont(variant: InlineVariant, marks: MarkState): string {
  if (variant === "heading-1") return H1_FONT;
  if (variant === "heading-2") return H2_FONT;
  if (variant === "heading-3") return H3_FONT;
  if (marks.bold && marks.italic) return BODY_STRONG_EM_FONT;
  if (marks.bold) return BODY_STRONG_FONT;
  if (marks.italic) return BODY_EM_FONT;
  if (marks.href) return LINK_FONT;
  return BODY_FONT;
}

function resolveTextClassName(variant: InlineVariant, marks: MarkState): string {
  const classes = ["assistant-fragment", `assistant-fragment-${variant}`];
  if (marks.href) classes.push("is-link");
  if (marks.bold) classes.push("is-strong");
  if (marks.italic) classes.push("is-em");
  if (marks.strike) classes.push("is-del");
  return classes.join(" ");
}

function headingVariant(depth: number): InlineVariant {
  if (depth <= 1) return "heading-1";
  if (depth === 2) return "heading-2";
  if (depth === 3) return "heading-3";
  return "body";
}

function lineHeightForVariant(variant: InlineVariant): number {
  if (variant === "heading-1") return H1_LINE_HEIGHT;
  if (variant === "heading-2") return H2_LINE_HEIGHT;
  if (variant === "heading-3") return H3_LINE_HEIGHT;
  return BODY_LINE_HEIGHT;
}

function appendBlockGroup(target: PreparedBlock[], group: PreparedBlock[], firstMargin: number): void {
  if (group.length === 0) {
    return;
  }
  for (let index = 0; index < group.length; index += 1) {
    const block = group[index] as PreparedBlock;
    target.push({
      ...block,
      marginTop: index === 0 ? (target.length === 0 ? 0 : firstMargin) : block.marginTop,
    });
  }
}

function shiftBlock(block: PreparedBlock, delta: number): PreparedBlock {
  return {
    ...block,
    contentLeft: block.contentLeft + delta,
  };
}

function resolveListMarkerText(list: Tokens.List, item: Tokens.ListItem, index: number): string {
  if (item.task) return item.checked ? "[x]" : "[ ]";
  if (list.ordered) {
    const start = typeof list.start === "number" ? list.start : 1;
    return `${start + index}.`;
  }
  return "-";
}

function resolveListMarkerClassName(list: Tokens.List, item: Tokens.ListItem): string {
  if (item.task) return "assistant-block-marker assistant-block-marker-task";
  return list.ordered
    ? "assistant-block-marker assistant-block-marker-ordered"
    : "assistant-block-marker assistant-block-marker-bullet";
}

function measureMarkerWidth(text: string): number {
  const cached = markerWidthCache.get(text);
  if (cached !== undefined) {
    return cached;
  }
  const width = measureNaturalWidth(prepareWithSegments(text, MARKER_FONT));
  markerWidthCache.set(text, width);
  return width;
}

function layoutBlockFrame(block: PreparedBlock, contentWidth: number, top: number): BlockFrame {
  if (block.kind === "inline") {
    const lineWidth = Math.max(1, contentWidth - block.contentLeft);
    const { lineCount, maxLineWidth } = measureRichInlineStats(block.flow, lineWidth);
    return {
      contentLeft: block.contentLeft,
      height: Math.max(1, lineCount) * block.lineHeight,
      kind: "inline",
      lineHeight: block.lineHeight,
      markerClassName: block.markerClassName,
      markerLeft: block.markerLeft,
      markerText: block.markerText,
      quoteRailLefts: block.quoteRailLefts,
      top,
      usedWidth: maxLineWidth,
    };
  }
  if (block.kind === "code") {
    const boxWidth = Math.max(1, contentWidth - block.contentLeft);
    const innerWidth = Math.max(1, boxWidth - ASSISTANT_CODE_PADDING_X * 2);
    const { lineCount, maxLineWidth } = measureLineStats(block.prepared, innerWidth);
    return {
      contentLeft: block.contentLeft,
      height: Math.max(1, lineCount) * block.lineHeight + ASSISTANT_CODE_PADDING_Y * 2,
      kind: "code",
      lineHeight: block.lineHeight,
      markerClassName: block.markerClassName,
      markerLeft: block.markerLeft,
      markerText: block.markerText,
      quoteRailLefts: block.quoteRailLefts,
      top,
      width: Math.min(boxWidth, Math.max(1, maxLineWidth + ASSISTANT_CODE_PADDING_X * 2)),
    };
  }
  return {
    contentLeft: block.contentLeft,
    height: block.height,
    kind: "rule",
    markerClassName: block.markerClassName,
    markerLeft: block.markerLeft,
    markerText: block.markerText,
    quoteRailLefts: block.quoteRailLefts,
    top,
    width: Math.max(1, contentWidth - block.contentLeft),
  };
}

function materializeBlockLayout(block: PreparedBlock, frame: BlockFrame, contentWidth: number): AssistantMarkdownBlockLayout {
  if (frame.kind === "inline" && block.kind === "inline") {
    const lineWidth = Math.max(1, contentWidth - frame.contentLeft);
    const lines: Array<{ fragments: AssistantInlineFragmentLayout[]; width: number }> = [];
    walkRichInlineLineRanges(block.flow, lineWidth, (range) => {
      const line = materializeRichInlineLineRange(block.flow, range);
      lines.push({
        fragments: line.fragments.map((fragment) => ({
          className: block.classNames[fragment.itemIndex] as string,
          href: block.hrefs[fragment.itemIndex] ?? null,
          leadingGap: fragment.gapBefore,
          text: fragment.text,
        })),
        width: line.width,
      });
    });
    return {
      contentLeft: frame.contentLeft,
      height: frame.height,
      kind: "inline",
      lineHeight: frame.lineHeight,
      lines,
      markerClassName: frame.markerClassName,
      markerLeft: frame.markerLeft,
      markerText: frame.markerText,
      quoteRailLefts: frame.quoteRailLefts,
      top: frame.top,
    };
  }
  if (frame.kind === "code" && block.kind === "code") {
    const boxWidth = Math.max(1, contentWidth - frame.contentLeft);
    const innerWidth = Math.max(1, boxWidth - ASSISTANT_CODE_PADDING_X * 2);
    return {
      contentLeft: frame.contentLeft,
      height: frame.height,
      kind: "code",
      lines: layoutWithLines(block.prepared, innerWidth, frame.lineHeight).lines,
      markerClassName: frame.markerClassName,
      markerLeft: frame.markerLeft,
      markerText: frame.markerText,
      quoteRailLefts: frame.quoteRailLefts,
      top: frame.top,
      width: frame.width,
    };
  }
  if (frame.kind === "rule") {
    return {
      contentLeft: frame.contentLeft,
      height: frame.height,
      kind: "rule",
      markerClassName: frame.markerClassName,
      markerLeft: frame.markerLeft,
      markerText: frame.markerText,
      quoteRailLefts: frame.quoteRailLefts,
      top: frame.top,
      width: frame.width,
    };
  }
  throw new Error("Assistant markdown block/frame mismatch");
}

function parseMarkdownHref(href: string | null | undefined): string | null {
  if (!href) {
    return null;
  }
  try {
    const url = new URL(href);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function formatTable(token: Tokens.Table): string {
  const header = token.header.map((cell) => inlineTokensToPlainText(cell.tokens)).join(" | ");
  const divider = token.header.map(() => "---").join(" | ");
  const rows = token.rows.map((row) => row.map((cell) => inlineTokensToPlainText(cell.tokens)).join(" | "));
  return [header, divider, ...rows].join("\n");
}

function inlineTokensToPlainText(tokens: readonly Token[]): string {
  return tokens.map((token) => {
    switch (token.type) {
      case "strong":
      case "em":
      case "del":
      case "link":
        return inlineTokensToPlainText(tokenTokens(token));
      case "codespan":
      case "escape":
      case "text":
      case "html":
        return tokenText(token);
      case "br":
        return "\n";
      case "image":
        return tokenText(token);
      default:
        return fallbackTextForToken(token);
    }
  }).join("");
}

function fallbackTextForToken(token: Token): string {
  return tokenText(token) || tokenRaw(token);
}

function stripSingleTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

function tokenTokens(token: Token): Token[] {
  const tokens = (token as { tokens?: unknown }).tokens;
  return Array.isArray(tokens) ? tokens as Token[] : [];
}

function tokenText(token: Token): string {
  const text = (token as { text?: unknown }).text;
  return typeof text === "string" ? text : "";
}

function tokenRaw(token: Token): string {
  const raw = (token as { raw?: unknown }).raw;
  return typeof raw === "string" ? raw : "";
}

function tokenHref(token: Token): string | null {
  const href = (token as { href?: unknown }).href;
  return typeof href === "string" ? href : null;
}

function tokenChecked(token: Token): boolean {
  return (token as { checked?: unknown }).checked === true;
}

function tokenDepth(token: Token): number {
  const depth = (token as { depth?: unknown }).depth;
  return typeof depth === "number" ? depth : 0;
}
