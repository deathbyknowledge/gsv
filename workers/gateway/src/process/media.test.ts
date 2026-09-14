import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";

import type { ProcMediaInput } from "@humansandmachines/gsv/protocol";
import { DEFAULT_AUDIO_TRANSCRIPTION_MODEL, DEFAULT_IMAGE_READING_MODEL, deleteProcessMedia, parseStoredProcessMedia, processMediaPath, storeIncomingProcessMedia } from "./media";
import type { MediaExecutor } from "../inference/media-client";
import { describeStoredProcessMedia } from "./history/media-renderer";

const touchedPids = new Set<string>();

function pidForTest(name: string): string {
  const pid = `media-test-${name}-${crypto.randomUUID()}`;
  touchedPids.add(pid);
  return pid;
}

async function storedMedia(
  pid: string,
  input: Omit<ProcMediaInput, "key" | "size">,
): Promise<ProcMediaInput> {
  const key = `var/media/0/${pid}/${crypto.randomUUID()}`;
  const bytes = new Uint8Array([1, 2, 3]);
  await env.STORAGE.put(key, bytes, {
    httpMetadata: { contentType: input.mimeType },
  });
  return { ...input, key, size: bytes.byteLength };
}

afterEach(async () => {
  for (const pid of touchedPids) {
    await deleteProcessMedia(env.STORAGE, 0, pid);
  }
  touchedPids.clear();
  vi.clearAllMocks();
});

describe("process media", () => {
  it("maps process media keys to actionable filesystem paths", () => {
    const key = "var/media/1000/proc:abc/attachment";
    expect(processMediaPath(key)).toBe(`/${key}`);
    expect(processMediaPath("var/media/01000/proc:abc/attachment")).toBeNull();
    expect(processMediaPath("var/media/1000/proc:abc/nested/attachment")).toBeNull();
    expect(describeStoredProcessMedia({
      type: "document",
      mimeType: "application/pdf",
      key,
      filename: "brief.pdf",
    })).toBe(`Attached document "brief.pdf" [application/pdf]\nPath: /${key}`);
  });

  it("only restores persisted paths from the archived-media namespace", () => {
    const archivedKey = `home/alice/.gsv/media/archived-media:${"a".repeat(64)}`;
    const parsed = parseStoredProcessMedia(JSON.stringify([
      { type: "image", mimeType: "image/png", key: archivedKey, path: `/${archivedKey}` },
      { type: "document", mimeType: "text/plain", key: "etc/passwd", path: "/etc/passwd" },
      { type: "document", mimeType: "text/plain", key: "home/alice/./secret", path: "/home/alice/./secret" },
      { type: "document", mimeType: "text/plain", key: "home/alice\\secret", path: "/home/alice\\secret" },
    ]));

    expect(parsed[0]?.path).toBe(`/${archivedKey}`);
    expect(parsed.slice(1).map((item) => item.path)).toEqual([undefined, undefined, undefined]);
  });

  it("transcribes incoming audio through inference before storing metadata", async () => {
    const pid = pidForTest("transcribe");
    const accepted: Uint8Array[] = [];
    const execute = vi.fn<MediaExecutor>(async (_operation, body) => {
      accepted.push(new Uint8Array(await new Response(body).arrayBuffer()));
      return { kind: "transcription", result: { text: "voice note transcript", duration: 1.5, provider: "workers-ai", model: DEFAULT_AUDIO_TRANSCRIPTION_MODEL } };
    });

    const raw = await storeIncomingProcessMedia(
      env.STORAGE,
      0,
      pid,
      [
        await storedMedia(pid, {
          type: "audio",
          mimeType: "audio/ogg",
          filename: "voice.ogg",
        }),
      ],
      {
        execute,
        audioTranscriptionProvider: "workers-ai",
        audioTranscriptionModel: DEFAULT_AUDIO_TRANSCRIPTION_MODEL,
      },
    );

    const media = parseStoredProcessMedia(raw);
    expect(media).toHaveLength(1);
    expect(media[0].transcription).toBe("voice note transcript");
    expect(media[0].duration).toBe(1.5);
    expect(media[0].key).toBeTruthy();
    expect(media[0].path).toBe(`/${media[0].key}`);
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "transcription", input: expect.objectContaining({ model: DEFAULT_AUDIO_TRANSCRIPTION_MODEL, mode: "transcribe", vadFilter: true, maxInputBytes: 3 }) }),
      expect.any(ReadableStream), 30_000, undefined,
    );
    expect([...accepted[0]]).toEqual([1, 2, 3]);
  });

  it("keeps audio media when transcription fails", async () => {
    const pid = pidForTest("transcribe-fail");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const execute = vi.fn<MediaExecutor>(async (_operation, body) => {
      await body?.cancel();
      throw new Error("stt unavailable");
    });

    const raw = await storeIncomingProcessMedia(
      env.STORAGE,
      0,
      pid,
      [
        await storedMedia(pid, {
          type: "audio",
          mimeType: "audio/ogg",
          filename: "voice.ogg",
        }),
      ],
      {
        execute,
        audioTranscriptionProvider: "workers-ai",
        audioTranscriptionModel: DEFAULT_AUDIO_TRANSCRIPTION_MODEL,
      },
    );

    const media = parseStoredProcessMedia(raw);
    expect(media).toHaveLength(1);
    expect(media[0].type).toBe("audio");
    expect(media[0].transcription).toBeUndefined();
    expect(media[0].key).toBeTruthy();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("cancels in-flight audio transcription with its media run", async () => {
    const pid = pidForTest("transcribe-cancel");
    const controller = new AbortController();
    let bindingSignal: AbortSignal | undefined;
    const execute = vi.fn<MediaExecutor>(async (_operation, body, _timeout, signal) => {
      await body?.cancel();
      bindingSignal = signal;
      return new Promise<never>((_resolve, reject) => { signal?.addEventListener("abort", () => reject(signal.reason), { once: true }); });
    });
    const request = storeIncomingProcessMedia(
      env.STORAGE,
      0,
      pid,
      [await storedMedia(pid, { type: "audio", mimeType: "audio/ogg" })],
      {
        execute,
        signal: controller.signal,
        audioTranscriptionProvider: "workers-ai",
        audioTranscriptionModel: DEFAULT_AUDIO_TRANSCRIPTION_MODEL,
      },
    );
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());

    controller.abort(new Error("media run stopped"));

    await expect(request).rejects.toThrow("media run stopped");
    expect(bindingSignal).toBe(controller.signal);
  });

  it("does not retranscribe audio that already has a transcript", async () => {
    const pid = pidForTest("existing-transcript");
    const execute = vi.fn<MediaExecutor>();

    const raw = await storeIncomingProcessMedia(
      env.STORAGE,
      0,
      pid,
      [
        await storedMedia(pid, {
          type: "audio",
          mimeType: "audio/ogg",
          filename: "voice.ogg",
          transcription: "existing transcript",
        }),
      ],
      { execute },
    );

    const media = parseStoredProcessMedia(raw);
    expect(media[0].transcription).toBe("existing transcript");
    expect(execute).not.toHaveBeenCalled();
  });

  it("describes incoming images through inference caption requests", async () => {
    const pid = pidForTest("image-read");
    const execute = vi.fn<MediaExecutor>(async (_operation, body) => {
      await body?.cancel();
      return { kind: "image-read", result: { mode: "caption", text: "a screenshot of a settings page", model: DEFAULT_IMAGE_READING_MODEL, provider: "workers-ai" } };
    });

// SAFETY: test fixture is constructed with the asserted domain shape.

    const raw = await storeIncomingProcessMedia(
      env.STORAGE,
      0,
      pid,
      [
        await storedMedia(pid, {
          type: "image",
          mimeType: "image/png",
          filename: "settings.png",
        }),
      ],
      {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        execute,
        imageReadingMaxTokens: 128,
      },
    );

    const media = parseStoredProcessMedia(raw);
    expect(media).toHaveLength(1);
    expect(media[0].description).toBe("a screenshot of a settings page");
    expect(media[0].key).toBeTruthy();
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "image-read", input: expect.objectContaining({ mode: "caption", mimeType: "image/png", captionLength: "normal", maxTokens: 128, maxInputBytes: 3 }) }),
      expect.any(ReadableStream), 30_000, undefined,
    );
  });

  it("stores SVG images without sending them to the raster image reader", async () => {
    const pid = pidForTest("svg");
    const execute = vi.fn<MediaExecutor>();

// SAFETY: test fixture is constructed with the asserted domain shape.

    const raw = await storeIncomingProcessMedia(
      env.STORAGE,
      0,
      pid,
      [
        await storedMedia(pid, {
          type: "image",
          mimeType: "image/svg+xml",
          filename: "diagram.svg",
        }),
      ],
      // SAFETY: test fixture is constructed with the asserted domain shape.
      { execute },
    );

    const media = parseStoredProcessMedia(raw);
    expect(media).toEqual([
      expect.objectContaining({
        type: "image",
        mimeType: "image/svg+xml",
        filename: "diagram.svg",
      }),
    ]);
    expect(media[0].description).toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
  });

  it("keeps image media when image reading fails", async () => {
    const pid = pidForTest("image-read-fail");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const execute = vi.fn<MediaExecutor>(async (_operation, body) => {
      await body?.cancel();
      throw new Error("vision unavailable");
    });

// SAFETY: test fixture is constructed with the asserted domain shape.

    const raw = await storeIncomingProcessMedia(
      env.STORAGE,
      0,
      pid,
      [
        await storedMedia(pid, {
          type: "image",
          mimeType: "image/png",
          filename: "settings.png",
        }),
      ],
      // SAFETY: test fixture is constructed with the asserted domain shape.
      { execute },
    );

    const media = parseStoredProcessMedia(raw);
    expect(media).toHaveLength(1);
    expect(media[0].type).toBe("image");
    expect(media[0].description).toBeUndefined();
    expect(media[0].key).toBeTruthy();
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ kind: "image-read" }), expect.any(ReadableStream), 30_000, undefined);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
