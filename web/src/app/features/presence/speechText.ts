import {
  INTERIM_SPEECH_MAX_CHARS,
  SPEECH_CHUNK_MAX_CHARS,
  SPEECH_FIRST_CHUNK_MAX_CHARS,
  SPEECH_FIRST_CHUNK_MIN_CHARS,
  SPEECH_FIRST_CHUNK_TARGET_CHARS,
} from "./constants";
import type { SpeechChunk } from "./types";

export function normalizeInterimSpeechText(text: string): string {
  if (text.includes("```") || text.includes("\n|")) {
    return "";
  }
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length > INTERIM_SPEECH_MAX_CHARS) {
    return "";
  }
  return /[.!?:;)]$/.test(normalized) ? normalized : `${normalized}.`;
}

export function selectSpeechPrefix(
  pending: string,
  final: boolean,
  firstChunk: boolean,
): { text: string; consumed: number } | null {
  const leading = pending.match(/^\s*/)?.[0].length ?? 0;
  const body = pending.slice(leading);
  if (!body.trim()) {
    return null;
  }

  const minChars = SPEECH_FIRST_CHUNK_MIN_CHARS;
  const maxChars = firstChunk ? SPEECH_FIRST_CHUNK_MAX_CHARS : SPEECH_CHUNK_MAX_CHARS;
  const sentenceEnd = sentenceEndAfter(body, minChars);
  let end = sentenceEnd;

  if (end === null || end > maxChars) {
    if (!final && body.length < maxChars) {
      return null;
    }
    end = wordBoundaryAt(body, maxChars);
  }

  if (final && body.length <= maxChars && (sentenceEnd === null || sentenceEnd > body.length)) {
    end = body.length;
  }

  const text = body.slice(0, end).trim();
  return text ? { text, consumed: leading + end } : null;
}

export function chunkSpeechText(text: string): SpeechChunk[] {
  const chunks: string[] = [];

  for (const block of speechBlocks(text)) {
    if (isMarkdownStructuralBlock(block)) {
      flushSpeechChunk(chunks, block);
      continue;
    }
    for (const sentence of splitSpeechSentences(block)) {
      const maxChars = chunks.length === 0 ? SPEECH_FIRST_CHUNK_MAX_CHARS : SPEECH_CHUNK_MAX_CHARS;
      for (const part of splitLongSpeechPart(sentence, maxChars)) {
        flushSpeechChunk(chunks, part);
      }
    }
  }

  const balanced = balanceSpeechChunks(chunks);
  return balanced.map((chunk, index) => ({
    text: chunk,
    index,
    total: balanced.length,
  }));
}

function sentenceEndAfter(text: string, minChars: number): number | null {
  const matcher = /[.!?](?:["')\]]+)?(?:\s+|$)/g;
  for (;;) {
    const match = matcher.exec(text);
    if (!match) {
      return null;
    }
    const end = match.index + match[0].length;
    if (end >= minChars) {
      return end;
    }
  }
}

function wordBoundaryAt(text: string, maxChars: number): number {
  if (text.length <= maxChars) {
    return text.length;
  }
  for (let index = Math.min(maxChars, text.length - 1); index > 0; index -= 1) {
    if (/\s/.test(text[index])) {
      return index;
    }
  }
  return Math.min(maxChars, text.length);
}

function balanceSpeechChunks(chunks: string[]): string[] {
  if (chunks.length <= 1 || chunks[0].length >= SPEECH_FIRST_CHUNK_MIN_CHARS) {
    return chunks;
  }

  const balanced = chunks.slice();
  while (balanced.length > 1 && balanced[0].length < SPEECH_FIRST_CHUNK_MIN_CHARS) {
    const merged = `${balanced[0]} ${balanced[1]}`.trim();
    if (merged.length <= SPEECH_FIRST_CHUNK_TARGET_CHARS) {
      balanced.splice(0, 2, merged);
      continue;
    }

    const availableChars = SPEECH_FIRST_CHUNK_TARGET_CHARS - balanced[0].length - 1;
    const [head, tail] = splitSpeechPrefixText(balanced[1], availableChars);
    if (!head) {
      break;
    }
    balanced[0] = `${balanced[0]} ${head}`.trim();
    if (tail) {
      balanced[1] = tail;
    } else {
      balanced.splice(1, 1);
    }
    break;
  }
  return balanced;
}

function splitSpeechPrefixText(text: string, maxChars: number): [string, string] {
  if (maxChars <= 0 || text.length <= maxChars) {
    return [text.trim(), ""];
  }

  const words = text.split(/\s+/).filter(Boolean);
  let consumed = 0;
  let prefix = "";
  for (const word of words) {
    const next = prefix ? `${prefix} ${word}` : word;
    if (next.length > maxChars) {
      break;
    }
    prefix = next;
    consumed += 1;
  }
  return [prefix, words.slice(consumed).join(" ")];
}

function speechBlocks(text: string): string[] {
  return text
    .replace(/\r/g, "")
    .split(/\n{2,}/)
    .flatMap((block) => splitSpeechMarkdownBlock(block))
    .map((line) => punctuateSpeechLine(line.trim()))
    .filter(Boolean);
}

function splitSpeechMarkdownBlock(block: string): string[] {
  const trimmed = block.trim();
  if (!trimmed) {
    return [];
  }
  if (isMarkdownStructuralBlock(trimmed)) {
    return [trimmed];
  }
  return trimmed.split(/\n+/);
}

function isMarkdownStructuralBlock(block: string): boolean {
  const lines = block.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) {
    return false;
  }
  const first = lines[0];
  if (first.startsWith("```") || first.startsWith("~~~")) {
    return true;
  }
  return lines.length >= 2 && lines.every((line) => line.startsWith("|"));
}

function punctuateSpeechLine(line: string): string {
  if (!line) {
    return "";
  }
  if (isMarkdownStructuralBlock(line)) {
    return line;
  }
  const cleaned = line.replace(/^[-*+]\s+/, "").replace(/^\d+[.)]\s+/, "").trim();
  if (!cleaned) {
    return "";
  }
  return /[.!?:;)]$/.test(cleaned) ? cleaned : `${cleaned}.`;
}

function splitSpeechSentences(text: string): string[] {
  return (text.match(/[^.!?]+[.!?]+(?:["')\]]+)?|[^.!?]+$/g) ?? [text])
    .map((part) => part.trim())
    .filter(Boolean);
}

function splitLongSpeechPart(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) {
    return [text];
  }
  const chunks: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/)) {
    if (!word) {
      continue;
    }
    const next = current ? `${current} ${word}` : word;
    if (next.length <= maxChars) {
      current = next;
      continue;
    }
    flushSpeechChunk(chunks, current);
    current = word;
  }
  flushSpeechChunk(chunks, current);
  return chunks;
}

function flushSpeechChunk(chunks: string[], value: string): void {
  const normalized = value.trim();
  if (normalized) {
    chunks.push(normalized);
  }
}
