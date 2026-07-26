import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandContext } from "just-bash";
import {
  bodyFromBytes,
  bodyFromText,
  bodyToBytes,
  type ProcessIdentity,
} from "@humansandmachines/gsv/protocol";
import type { GsvFs } from "../../../fs/gsv-fs";
import type { KernelContext } from "../../../kernel/context";
import type { FsDeviceTransport } from "../fs";

const ai = vi.hoisted(() => ({
  imageGenerate: vi.fn(),
  imageRead: vi.fn(),
  speechCreate: vi.fn(),
  transcriptionCreate: vi.fn(),
}));

vi.mock("../../../kernel/ai", () => ({
  handleAiImageGenerate: ai.imageGenerate,
  handleAiImageRead: ai.imageRead,
  handleAiSpeechCreate: ai.speechCreate,
  handleAiTranscriptionCreate: ai.transcriptionCreate,
}));

import { buildMediaCommands } from "./media";

const IDENTITY: ProcessIdentity = {
  uid: 1000,
  gid: 1000,
  gids: [1000],
  username: "sam",
  home: "/home/sam",
  cwd: "/home/sam",
};

const CTX = {
  identity: {
    role: "user",
    process: IDENTITY,
    capabilities: ["*"],
  },
} as KernelContext;

beforeEach(() => {
  for (const mock of Object.values(ai)) {
    mock.mockReset();
  }
});

describe("native media streams", () => {
  it("uses only matching stored media MIME types", async () => {
    ai.imageRead.mockResolvedValue({
      data: {
        mode: "caption",
        text: "image",
        caption: "image",
        captionLength: "normal",
        provider: "workers-ai",
        model: "moondream",
      },
    });
    ai.transcriptionCreate.mockResolvedValue({ text: "audio" });

    await run("img2txt", ["picture.png"], makeFs({
      openFile: vi.fn(async () => opened(new Uint8Array([1]), "application/octet-stream")),
    }));
    await run("stt", ["recording.mp3"], makeFs({
      openFile: vi.fn(async () => opened(new Uint8Array([2]), "audio/wav")),
    }));

    expect(ai.imageRead.mock.calls[0][0].image.mimeType).toBe("image/png");
    expect(ai.transcriptionCreate.mock.calls[0][0].audio.mimeType).toBe("audio/wav");
  });

  it.each([
    ["img2txt", "imageRead", "picture.png"],
    ["stt", "transcriptionCreate", "recording.mp3"],
  ] as const)("cancels %s input when the consumer rejects", async (command, handler, path) => {
    let cancelled = false;
    ai[handler].mockRejectedValue(new Error("rejected"));
    const body = cancellableBody(new Uint8Array([1]), () => {
      cancelled = true;
    });
    const fs = makeFs({
      openFile: vi.fn(async () => ({
        ...opened(new Uint8Array(), "application/octet-stream"),
        body: body.stream,
        size: body.length,
        totalSize: body.length,
      })),
    });

    const result = await run(command, [path], fs);

    expect(result.exitCode).toBe(1);
    expect(cancelled).toBe(true);
  });

  it("streams generated image and speech with their actual MIME types", async () => {
    ai.imageGenerate.mockResolvedValue({
      data: {
        image: { mimeType: "image/jpeg", size: 4 },
        provider: "workers-ai",
        model: "image-model",
      },
      body: bodyFromBytes(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])),
    });
    ai.speechCreate.mockResolvedValue({
      data: {
        audio: { mimeType: "audio/wav", size: 4 },
        provider: "workers-ai",
        model: "speech-model",
      },
      body: bodyFromBytes(new Uint8Array([0x52, 0x49, 0x46, 0x46])),
    });
    const writes: Array<{ path: string; mimeType?: string; bytes: Uint8Array }> = [];
    const fs = makeFs({
      writeFileStream: vi.fn(async (path, stream, options) => {
        writes.push({
          path,
          mimeType: options.contentType,
          bytes: await bodyToBytes({ stream, length: options.expectedSize }),
        });
        return { size: options.expectedSize, streamed: true };
      }),
    });

    await run("txt2img", ["-o", "picture.png", "green", "square"], fs);
    await run("tts", ["-o", "speech.mp3", "hello"], fs);

    expect(writes).toEqual([
      {
        path: "/home/sam/picture.png",
        mimeType: "image/jpeg",
        bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]),
      },
      {
        path: "/home/sam/speech.mp3",
        mimeType: "audio/wav",
        bytes: new Uint8Array([0x52, 0x49, 0x46, 0x46]),
      },
    ]);
  });

  it.each([
    ["txt2img", "imageGenerate", "picture.png"],
    ["tts", "speechCreate", "speech.mp3"],
  ] as const)("cancels %s output when the write fails", async (command, handler, path) => {
    let cancelled = false;
    const body = cancellableBody(new Uint8Array([1]), () => {
      cancelled = true;
    });
    const media = command === "txt2img"
      ? { image: { mimeType: "image/jpeg", size: body.length } }
      : { audio: { mimeType: "audio/wav", size: body.length } };
    ai[handler].mockResolvedValue({
      data: { ...media, provider: "workers-ai", model: "model" },
      body,
    });
    const fs = makeFs({
      writeFileStream: vi.fn(async () => {
        throw new Error("write failed");
      }),
    });

    const result = await run(command, ["-o", path, "input"], fs);

    expect(result.exitCode).toBe(1);
    expect(cancelled).toBe(true);
  });
});

describe("img2txt", () => {
  it("uses a normal caption as the default mode", async () => {
    ai.imageRead.mockResolvedValue({
      data: captionResult("a terminal"),
    });

    const result = await run("img2txt", ["picture.png"], imageFs());

    expect(result.stdout).toBe("a terminal\n");
    expect(ai.imageRead.mock.calls[0][0]).toEqual({
      image: {
        mimeType: "image/png",
        filename: "picture.png",
      },
      mode: "caption",
    });
  });

  it("passes agent prompts, reasoning, and structured query options", async () => {
    ai.imageRead.mockResolvedValue({
      data: {
        mode: "query",
        text: "{\"count\":2}",
        answer: "{\"count\":2}",
        responseFormat: "json",
        structured: { count: 2 },
        provider: "workers-ai",
        model: "moondream",
      },
    });
    const schema = "{\"type\":\"object\",\"required\":[\"count\"]}";

    const result = await run("img2txt", [
      "query",
      "--prompt",
      "Count the buttons",
      "--reasoning",
      "--response-format",
      "json",
      "--schema",
      schema,
      "--max-tokens",
      "500",
      "--temperature",
      "0",
      "--top-p",
      "0.8",
      "--json",
      "picture.png",
    ], imageFs());

    expect(ai.imageRead.mock.calls[0][0]).toEqual({
      image: {
        mimeType: "image/png",
        filename: "picture.png",
      },
      mode: "query",
      prompt: "Count the buttons",
      reasoning: true,
      responseFormat: "json",
      schema: { type: "object", required: ["count"] },
      maxTokens: 500,
      temperature: 0,
      topP: 0.8,
    });
    expect(JSON.parse(result.stdout)).toEqual(expect.objectContaining({
      mode: "query",
      structured: { count: 2 },
    }));
  });

  it("exposes OCR with an optional caller prompt", async () => {
    ai.imageRead.mockResolvedValue({
      data: {
        mode: "ocr",
        text: "Invoice\nTotal: $20",
        answer: "Invoice\nTotal: $20",
        responseFormat: "text",
        provider: "workers-ai",
        model: "moondream",
      },
    });

    const result = await run("img2txt", [
      "ocr",
      "--prompt",
      "Read only the invoice total",
      "scan.png",
    ], imageFs());

    expect(result.stdout).toBe("Invoice\nTotal: $20\n");
    expect(ai.imageRead.mock.calls[0][0]).toEqual(expect.objectContaining({
      mode: "ocr",
      prompt: "Read only the invoice total",
    }));
  });

  it.each([
    ["point", "points", [{ x: 0.25, y: 0.5 }]],
    ["detect", "objects", [{ xMin: 0.1, yMin: 0.2, xMax: 0.3, yMax: 0.4 }]],
  ] as const)("prints %s results as JSON", async (mode, resultKey, values) => {
    ai.imageRead.mockResolvedValue({
      data: {
        mode,
        [resultKey]: values,
        provider: "workers-ai",
        model: "moondream",
      },
    });

    const result = await run("img2txt", [
      mode,
      "--target",
      "submit button",
      "--max-objects",
      "10",
      "picture.png",
    ], imageFs());

    expect(ai.imageRead.mock.calls[0][0]).toEqual(expect.objectContaining({
      mode,
      target: "submit button",
      maxObjects: 10,
    }));
    expect(JSON.parse(result.stdout)).toEqual(expect.objectContaining({
      mode,
      [resultKey]: values,
    }));
  });

  it("consumes decoded streaming output", async () => {
    ai.imageRead.mockResolvedValue({
      data: {
        mode: "caption",
        streamed: true,
        contentType: "text/plain; charset=utf-8",
        provider: "workers-ai",
        model: "moondream",
      },
      body: bodyFromText("streamed caption"),
    });

    const result = await run("img2txt", [
      "caption",
      "--stream",
      "--length",
      "long",
      "picture.png",
    ], imageFs());

    expect(result.stdout).toBe("streamed caption\n");
    expect(ai.imageRead.mock.calls[0][0]).toEqual(expect.objectContaining({
      mode: "caption",
      captionLength: "long",
      stream: true,
    }));
  });

  it.each([
    ["laptop:/photos/picture.png", "laptop", "/photos/picture.png"],
    ["[browser:work]:/screenshots/picture.png", "browser:work", "/screenshots/picture.png"],
  ])("streams a target-qualified image without staging it", async (
    imagePath,
    target,
    targetPath,
  ) => {
    let imageBytes: Uint8Array | undefined;
    ai.imageRead.mockImplementation(async (_args, _ctx, body) => {
      imageBytes = await bodyToBytes(body);
      return { data: captionResult("a remote image") };
    });
    const fs = imageFs();
    const transport = remoteImageTransport(target, targetPath, new Uint8Array([4, 5, 6]));

    const result = await run(
      "img2txt",
      [imagePath],
      fs,
      targetContext([target]),
      transport,
    );

    expect(result).toEqual({ stdout: "a remote image\n", stderr: "", exitCode: 0 });
    expect(fs.openFile).not.toHaveBeenCalled();
    expect(imageBytes).toEqual(new Uint8Array([4, 5, 6]));
    expect(transport.requestDevice).toHaveBeenNthCalledWith(
      1,
      target,
      "fs.transfer.stat",
      { path: targetPath },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(transport.requestDevice).toHaveBeenNthCalledWith(
      2,
      target,
      "fs.transfer.send",
      { path: targetPath },
      expect.objectContaining({ ttlMs: 120_000, signal: expect.any(AbortSignal) }),
    );
    expect(ai.imageRead.mock.calls[0][0].image).toEqual({
      mimeType: "image/png",
      filename: "picture.png",
    });
  });

  it("rejects inaccessible target-qualified images before transfer", async () => {
    const ctx = targetContext(["laptop"]);
    ctx.devices.canAccess = vi.fn(() => false);
    const transport = remoteImageTransport(
      "laptop",
      "/photos/picture.png",
      new Uint8Array([1]),
    );

    const result = await run(
      "img2txt",
      ["laptop:/photos/picture.png"],
      imageFs(),
      ctx,
      transport,
    );

    expect(result.stderr).toContain("Access denied to device: laptop");
    expect(transport.requestDevice).not.toHaveBeenCalled();
    expect(ai.imageRead).not.toHaveBeenCalled();
  });

  it("requires filesystem transfer support for target-qualified images", async () => {
    const result = await run(
      "img2txt",
      ["laptop:/photos/picture.png"],
      imageFs(),
      targetContext(["laptop"]),
    );

    expect(result.stderr).toContain(
      "Reading a non-gsv source requires device transfer support",
    );
    expect(ai.imageRead).not.toHaveBeenCalled();
  });

  it("cancels a target image stream when inference rejects it", async () => {
    let cancelled = false;
    ai.imageRead.mockRejectedValue(new Error("rejected"));
    const transport = remoteImageTransport(
      "laptop",
      "/photos/picture.png",
      new Uint8Array([1]),
      () => {
        cancelled = true;
      },
    );

    const result = await run(
      "img2txt",
      ["laptop:/photos/picture.png"],
      imageFs(),
      targetContext(["laptop"]),
      transport,
    );

    expect(result.exitCode).toBe(1);
    expect(cancelled).toBe(true);
  });

  it("rejects missing mode inputs and incompatible streaming output", async () => {
    const missingPrompt = await run("img2txt", ["query", "picture.png"], imageFs());
    const missingTarget = await run("img2txt", ["detect", "picture.png"], imageFs());
    const streamJson = await run("img2txt", [
      "caption",
      "--stream",
      "--json",
      "picture.png",
    ], imageFs());

    expect(missingPrompt.stderr).toContain("--prompt is required");
    expect(missingTarget.stderr).toContain("--target is required");
    expect(streamJson.stderr).toContain("--stream cannot be combined with --json");
    expect(ai.imageRead).not.toHaveBeenCalled();
  });
});

function makeFs(overrides: Partial<GsvFs>): GsvFs {
  return {
    resolvePath(base: string, path: string) {
      return path.startsWith("/") ? path : `${base}/${path}`;
    },
    ...overrides,
  } as unknown as GsvFs;
}

function imageFs(): GsvFs {
  return makeFs({
    openFile: vi.fn(async () => opened(new Uint8Array([1, 2, 3]), "image/png")),
  });
}

function captionResult(text: string) {
  return {
    mode: "caption" as const,
    text,
    caption: text,
    captionLength: "normal" as const,
    provider: "workers-ai",
    model: "moondream",
  };
}

function opened(bytes: Uint8Array, contentType?: string) {
  const body = bodyFromBytes(bytes);
  return {
    body: body.stream,
    size: bytes.byteLength,
    totalSize: bytes.byteLength,
    mtime: new Date(0),
    status: 200 as const,
    contentType,
  };
}

function cancellableBody(bytes: Uint8Array, cancel: () => void) {
  return {
    length: bytes.byteLength,
    stream: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
      },
      cancel,
    }),
  };
}

async function run(
  name: string,
  args: string[],
  fs: GsvFs,
  ctx: KernelContext = CTX,
  transport?: FsDeviceTransport,
) {
  const command = buildMediaCommands(fs, ctx, transport).find((candidate) => (
    candidate.name === name
  ))!;
  return command.execute(args, {
    fs,
    cwd: IDENTITY.cwd,
    env: new Map(),
    stdin: "",
    signal: new AbortController().signal,
  } as CommandContext);
}

function targetContext(targets: string[]): KernelContext {
  return {
    ...CTX,
    devices: {
      canAccess: vi.fn(() => true),
      canHandle: vi.fn(() => true),
      listForUser: vi.fn(() => targets.map((device_id) => ({ device_id }))),
    },
  } as unknown as KernelContext;
}

function remoteImageTransport(
  target: string,
  path: string,
  bytes: Uint8Array,
  cancel?: () => void,
): FsDeviceTransport & { requestDevice: ReturnType<typeof vi.fn> } {
  const requestDevice = vi.fn(async (deviceId: string, call: string, args: unknown) => {
    expect(deviceId).toBe(target);
    expect(args).toEqual({ path });
    if (call === "fs.transfer.stat") {
      return {
        type: "res" as const,
        id: "stat",
        ok: true as const,
        data: {
          ok: true,
          path,
          size: bytes.byteLength,
          isFile: true,
          isDirectory: false,
          contentType: "image/png",
        },
      };
    }
    if (call === "fs.transfer.send") {
      const body = cancel
        ? cancellableBody(bytes, cancel)
        : bodyFromBytes(bytes);
      return {
        type: "res" as const,
        id: "send",
        ok: true as const,
        data: { ok: true, path, size: bytes.byteLength, contentType: "image/png" },
        body,
      };
    }
    throw new Error(`unexpected device call: ${call}`);
  });
  return { requestDevice };
}
