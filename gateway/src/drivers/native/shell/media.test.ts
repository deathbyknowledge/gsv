import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandContext } from "just-bash";
import {
  bodyFromBytes,
  bodyToBytes,
  type ProcessIdentity,
} from "@humansandmachines/gsv/protocol";
import type { GsvFs } from "../../../fs/gsv-fs";
import type { KernelContext } from "../../../kernel/context";

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
    ai.imageRead.mockResolvedValue({ text: "image" });
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

function makeFs(overrides: Partial<GsvFs>): GsvFs {
  return {
    resolvePath(base: string, path: string) {
      return path.startsWith("/") ? path : `${base}/${path}`;
    },
    ...overrides,
  } as unknown as GsvFs;
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

async function run(name: string, args: string[], fs: GsvFs) {
  const command = buildMediaCommands(fs, CTX).find((candidate) => candidate.name === name)!;
  return command.execute(args, {
    fs,
    cwd: IDENTITY.cwd,
    env: new Map(),
    stdin: "",
  } as CommandContext);
}
