import { describe, expect, it } from "vitest";
import type { JsonObject } from "@humansandmachines/gsv/protocol";
import { gzipContextEpochArchive, serializeArchivedMessage } from "./history/helpers";
import type { MessageRecord } from "./store";
import type { ArchivedMediaRewrite } from "./internal/lifecycle";

const header = { schemaVersion: 1, installationId: "synthetic", process: { pid: "process", uid: 0 } };
const epoch = { id: "epoch", systemPrompt: "Synthetic \"quoted\" context\nline", observedProjection: null };
const message: MessageRecord = {
  id: 1, generation: 1, runId: "run", role: "assistant", content: "Original text \"quoted\"\nline",
  toolCalls: null, toolCallId: null, media: null, origin: null, createdAt: 1,
  metadata: JSON.stringify({ fallback: { used: true, from: { provider: "openai-codex", model: "gpt-6-astra" }, to: { provider: "gsv", model: "default" }, reason: "synthetic error\n".repeat(80000) } }),
  records: [{ kind: "note", payload: { text: "Original text", thinking: [] } }],
};

async function decompress(stream: ReadableStream<Uint8Array>): Promise<string> {
  return await new Response(stream.pipeThrough(new DecompressionStream("gzip"))).text();
}

describe("context epoch archive streaming", () => {
  it.each([false, true])("preserves exact uncompressed archive bytes with records=%s", async (includeRecords) => {
    const messages = includeRecords ? [message, { ...message, id: 2 }] : [];
    const runBoundaries: JsonObject[] = includeRecords ? [{ runId: "run", status: "completed" }] : [];
    const expected = JSON.stringify({ ...header, epoch: { ...epoch, processActivity: messages.map(item => serializeArchivedMessage(item)), runBoundaries } });
    const actual = await decompress(gzipContextEpochArchive({ header, epoch, messages, runBoundaries, mediaRewrites: new Map() }));
    expect(actual).toBe(expected);
  });

  it("propagates cancellation before serializing retained metadata", async () => {
    const controller = new AbortController();
    controller.abort(new Error("synthetic cancellation"));
    const stream = gzipContextEpochArchive({ header, epoch, messages: [message], runBoundaries: [], mediaRewrites: new Map(), signal: controller.signal });
    await expect(decompress(stream)).rejects.toThrow("synthetic cancellation");
  });

  it("preserves media rewrites in compatibility and typed archive records", async () => {
    const media = { type: "image" as const, mimeType: "image/png", key: "original", path: "/original" };
    const withMedia: MessageRecord = {
      ...message,
      metadata: null,
      media: JSON.stringify([media]),
      records: [{ kind: "note", payload: { text: "Image", thinking: [], media: [media] } }],
    };
    const mediaRewrites = new Map<string, ArchivedMediaRewrite>([
      ["original", { key: "archive/image", path: "/archive/image", revision: "immutable-revision" }],
    ]);
    const expected = JSON.stringify({ ...header, epoch: { ...epoch, processActivity: [serializeArchivedMessage(withMedia, mediaRewrites)], runBoundaries: [] } });
    const actual = await decompress(gzipContextEpochArchive({ header, epoch, messages: [withMedia], runBoundaries: [], mediaRewrites }));
    expect(actual).toBe(expected);
  });

});
