import type { ArchivedMessageRecord } from "../../../process/internal/lifecycle";
import { parseArchivedMessageRecord } from "../../../process/history/helpers";

export type ArchiveHistorySelection = {
  generation?: number;
  afterMessageId?: number;
  throughMessageId?: number;
  offset?: number;
  limit?: number;
};

/** Page immutable archives without expanding the whole gzip into shell pipe memory. */
export async function readArchiveHistory(
  body: ReadableStream<Uint8Array>,
  selection: ArchiveHistorySelection,
  signal?: AbortSignal,
): Promise<{ messages: ArchivedMessageRecord[]; offset: number; nextOffset: number; hasMore: boolean }> {
  const offset = selection.offset ?? 0;
  const limit = selection.limit ?? 20;
  const messages: ArchivedMessageRecord[] = [];
  let matched = 0;
  for await (const line of archiveLines(body, signal)) {
    if (!line.trim()) continue;
    const message = parseArchivedMessageRecord(JSON.parse(line));
    if (selection.generation !== undefined && message.generation !== selection.generation) continue;
    if (selection.afterMessageId !== undefined && (message.id === undefined || message.id <= selection.afterMessageId)) continue;
    if (selection.throughMessageId !== undefined && (message.id === undefined || message.id > selection.throughMessageId)) continue;
    if (matched++ < offset) continue;
    if (messages.length === limit) return { messages, offset, nextOffset: offset + messages.length, hasMore: true };
    messages.push(message);
  }
  return { messages, offset, nextOffset: offset + messages.length, hasMore: false };
}

async function* archiveLines(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<string> {
  const reader = body.pipeThrough(new DecompressionStream("gzip"), { signal }).getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  let pending = "";
  try {
    while (true) {
      signal?.throwIfAborted();
      const chunk = await reader.read();
      pending += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      let start = 0;
      let end: number;
      while ((end = pending.indexOf("\n", start)) !== -1) {
        yield pending.slice(start, end);
        start = end + 1;
      }
      pending = pending.slice(start);
      if (chunk.done) break;
    }
    if (pending) yield pending;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
