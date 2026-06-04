import { layout, prepareWithSegments, walkLineRanges, type PreparedTextWithSegments } from "@chenglou/pretext";

const USER_BUBBLE_FONT = "13px Inter";
const USER_BUBBLE_HEADER_FONT = "800 11px Inter";
const USER_BUBBLE_LINE_HEIGHT = 13 * 1.45;
const USER_BUBBLE_PADDING_X = 24;
const USER_BUBBLE_MIN_WIDTH = 156;
const USER_BUBBLE_MAX_WIDTH = 820;
const USER_BUBBLE_MAX_RATIO = 0.88;
const USER_BUBBLE_HEADER_ACTION_WIDTH = 25;
const USER_BUBBLE_HEADER_GAP = 10;
const USER_BUBBLE_HEADER_BUFFER = 10;

export function computeUserBubbleWidth(text: string, containerWidth: number, headerParts: string[] = []): number | null {
  if (!text.trim() || !Number.isFinite(containerWidth) || containerWidth <= 0) {
    return null;
  }
  const maxOuterWidth = Math.max(
    USER_BUBBLE_MIN_WIDTH,
    Math.min(USER_BUBBLE_MAX_WIDTH, Math.floor(containerWidth * USER_BUBBLE_MAX_RATIO)),
  );
  const maxContentWidth = Math.max(1, maxOuterWidth - USER_BUBBLE_PADDING_X);

  try {
    const prepared = prepareWithSegments(text, USER_BUBBLE_FONT, { whiteSpace: "pre-wrap" });
    const initialLineCount = layout(prepared, maxContentWidth, USER_BUBBLE_LINE_HEIGHT).lineCount;
    if (initialLineCount <= 0) {
      return null;
    }
    const tightMetrics = findTightWrapMetrics(prepared, maxContentWidth, initialLineCount);
    const headerWidth = measureUserBubbleHeaderWidth(headerParts);
    return clamp(
      Math.max(Math.ceil(tightMetrics.maxLineWidth) + USER_BUBBLE_PADDING_X, headerWidth),
      USER_BUBBLE_MIN_WIDTH,
      maxOuterWidth,
    );
  } catch {
    return null;
  }
}

function measureUserBubbleHeaderWidth(parts: string[]): number {
  const labels = parts.map((part) => part.trim()).filter(Boolean);
  if (labels.length === 0) {
    return USER_BUBBLE_MIN_WIDTH;
  }
  const labelsWidth = labels.reduce((sum, label) => {
    const prepared = prepareWithSegments(label, USER_BUBBLE_HEADER_FONT);
    return sum + measureSingleLineWidth(prepared);
  }, 0);
  return Math.ceil(
    labelsWidth
    + USER_BUBBLE_HEADER_ACTION_WIDTH
    + USER_BUBBLE_HEADER_GAP * (labels.length + 1)
    + USER_BUBBLE_PADDING_X
    + USER_BUBBLE_HEADER_BUFFER,
  );
}

function measureSingleLineWidth(prepared: PreparedTextWithSegments): number {
  let width = 0;
  walkLineRanges(prepared, 1000, (line) => {
    width = Math.max(width, line.width);
  });
  return width;
}

function findTightWrapMetrics(
  prepared: PreparedTextWithSegments,
  maxContentWidth: number,
  targetLineCount: number,
): { maxLineWidth: number } {
  let low = 1;
  let high = Math.max(1, Math.ceil(maxContentWidth));
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const lineCount = layout(prepared, mid, USER_BUBBLE_LINE_HEIGHT).lineCount;
    if (lineCount <= targetLineCount) {
      high = mid;
    } else {
      low = mid + 1;
    }
  }
  return collectLineStats(prepared, low);
}

function collectLineStats(prepared: PreparedTextWithSegments, width: number): { maxLineWidth: number } {
  let maxLineWidth = 0;
  walkLineRanges(prepared, width, (line) => {
    if (line.width > maxLineWidth) {
      maxLineWidth = line.width;
    }
  });
  return { maxLineWidth };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
