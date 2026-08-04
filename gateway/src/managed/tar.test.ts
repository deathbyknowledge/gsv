import { describe, expect, it, vi } from "vitest";
import { createTarStream, tarJsonEntry, type TarEntry } from "./tar";

describe("managed export tar stream", () => {
  it("writes byte streams, JSON, empty files, and PAX paths without buffering", async () => {
    const longPath = `storage/objects/${"encoded-key-".repeat(30)}`;
    async function* entries(): AsyncGenerator<TarEntry> {
      yield tarJsonEntry("manifest.json", { version: 1 }, 1_800_000_000_000);
      yield {
        path: longPath,
        size: 5,
        body: new ReadableStream<Uint8Array>({
          type: "bytes",
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2]));
            controller.enqueue(new Uint8Array([3, 4, 5]));
            controller.close();
          },
        } as UnderlyingByteSource),
      };
      yield { path: "empty", size: 0, body: new Uint8Array() };
    }

    const bytes = new Uint8Array(
      await new Response(createTarStream(entries())).arrayBuffer(),
    );
    const archive = parseTar(bytes);
    expect(JSON.parse(new TextDecoder().decode(archive.get("manifest.json"))))
      .toEqual({ version: 1 });
    expect([...archive.get(longPath)!]).toEqual([1, 2, 3, 4, 5]);
    expect(archive.get("empty")).toEqual(new Uint8Array());
    expect(bytes.slice(-1_024)).toEqual(new Uint8Array(1_024));
  });

  it("cancels an entry body when the archive consumer disconnects", async () => {
    const cancel = vi.fn();
    let returned = false;
    async function* entries(): AsyncGenerator<TarEntry> {
      try {
        yield {
          path: "private.bin",
          size: 1,
          body: new ReadableStream<Uint8Array>({ cancel }),
        };
      } finally {
        returned = true;
      }
    }
    const reader = createTarStream(entries()).getReader();
    await expect(reader.read()).resolves.toMatchObject({ done: false });
    await reader.cancel("browser disconnected");

    expect(cancel).toHaveBeenCalledWith("tar archive cancelled");
    expect(returned).toBe(true);
  });

  it("interrupts a pending entry-body read when the consumer disconnects", async () => {
    const cancel = vi.fn();
    let markPullStarted!: () => void;
    let finishPull!: () => void;
    const pullStarted = new Promise<void>((resolve) => {
      markPullStarted = resolve;
    });
    async function* entries(): AsyncGenerator<TarEntry> {
      yield {
        path: "pending-private.bin",
        size: 1,
        body: new ReadableStream<Uint8Array>({
          pull() {
            markPullStarted();
            return new Promise<void>((resolve) => {
              finishPull = resolve;
            });
          },
          cancel(reason) {
            cancel(reason);
            finishPull();
          },
        }),
      };
    }
    const reader = createTarStream(entries()).getReader();
    await expect(reader.read()).resolves.toMatchObject({ done: false });
    const pendingRead = reader.read();
    await pullStarted;
    await reader.cancel("browser disconnected");

    await expect(pendingRead).resolves.toMatchObject({ done: true });
    expect(cancel).toHaveBeenCalledWith("tar archive cancelled");
  });
});

function parseTar(bytes: Uint8Array): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  let offset = 0;
  let paxPath: string | null = null;
  while (offset + 512 <= bytes.byteLength) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = headerText(header, 0, 100);
    const prefix = headerText(header, 345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    const size = Number.parseInt(headerText(header, 124, 12).trim() || "0", 8);
    const type = String.fromCharCode(header[156] ?? 0);
    const start = offset + 512;
    const body = bytes.slice(start, start + size);
    if (type === "x") {
      const text = new TextDecoder().decode(body);
      const match = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(text);
      paxPath = match?.[1] ?? null;
    } else {
      files.set(paxPath ?? path, body);
      paxPath = null;
    }
    offset = start + Math.ceil(size / 512) * 512;
  }
  return files;
}

function headerText(
  header: Uint8Array,
  offset: number,
  length: number,
): string {
  const field = header.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return new TextDecoder().decode(end === -1 ? field : field.subarray(0, end));
}
