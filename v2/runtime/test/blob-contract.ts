import { describe, expect, it } from "vitest";
import { PART_BYTES, type BlobStore } from "../src/blob/index.ts";

const encoder = new TextEncoder();

function utf8(text: string): ArrayBuffer {
  const encoded = encoder.encode(text);
  const bytes = new Uint8Array(encoded.byteLength);
  bytes.set(encoded);
  return bytes.buffer;
}

async function sha256(bytes: ArrayBuffer): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function text(stream: ReadableStream<Uint8Array> | null): Promise<string | null> {
  return stream ? new Response(stream).text() : null;
}

function filled(size: number, byte: number): ArrayBuffer {
  return new Uint8Array(size).fill(byte).buffer;
}

/** One contract, run against every backend. */
export function blobContract(name: string, open: () => BlobStore): void {
  describe(`blob store: ${name}`, () => {
    const prefix = `contract/${crypto.randomUUID()}/`;

    it("stores bytes with their hash and reads them back, whole or by range", async () => {
      const store = open();
      const bytes = utf8("hello, volumes");
      await store.put(`${prefix}a`, bytes, { sha256: await sha256(bytes) });
      expect(await store.head(`${prefix}a`)).toEqual({ size: 14, sha256: await sha256(bytes) });
      expect(await text(await store.get(`${prefix}a`))).toBe("hello, volumes");
      expect(await text(await store.get(`${prefix}a`, { offset: 7, length: 4 }))).toBe("volu");
      expect(await text(await store.get(`${prefix}a`, { offset: 7 }))).toBe("volumes");
    });

    it("streams a body in and refuses bytes that don't match their hash", async () => {
      const store = open();
      const body = new Response("streamed").body;
      if (!body) throw new Error("no body");
      await store.put(`${prefix}stream`, body);
      expect(await text(await store.get(`${prefix}stream`))).toBe("streamed");
      await expect(store.put(`${prefix}bad`, utf8("x"), { sha256: "0".repeat(64) })).rejects.toMatchObject({ code: "conflict" });
      expect(await store.head(`${prefix}bad`)).toBeNull();
    });

    it("answers null for missing keys", async () => {
      const store = open();
      expect(await store.get(`${prefix}missing`)).toBeNull();
      expect(await store.head(`${prefix}missing`)).toBeNull();
    });

    it("lists by prefix and deletes several keys", async () => {
      const store = open();
      for (const key of ["l/1", "l/2", "m/1"]) await store.put(`${prefix}${key}`, utf8(key));
      expect((await store.list(`${prefix}l/`)).keys.sort()).toEqual([`${prefix}l/1`, `${prefix}l/2`]);
      await store.delete([`${prefix}l/1`, `${prefix}l/2`, `${prefix}never-written`]);
      expect((await store.list(`${prefix}l/`)).keys).toEqual([]);
      expect(await store.head(`${prefix}m/1`)).not.toBeNull();
    });

    it("assembles a multipart upload resumed by id from another request", async () => {
      const store = open();
      const key = `${prefix}multi`;
      const upload = await store.multipart(key);
      const first = await upload.part(1, filled(5 * 1024 * 1024, 1));
      const second = await store.resume(key, upload.id).part(2, filled(3, 2));
      await store.resume(key, upload.id).complete([{ n: 2, etag: second.etag }, { n: 1, etag: first.etag }]);
      expect((await store.head(key))?.size).toBe(5 * 1024 * 1024 + 3);
      const tail = await store.get(key, { offset: 5 * 1024 * 1024 - 1 });
      expect([...new Uint8Array(await new Response(tail).arrayBuffer())]).toEqual([1, 2, 2, 2]);
    });

    it("aborts an upload and refuses a body over one part", async () => {
      const store = open();
      const upload = await store.multipart(`${prefix}aborted`);
      await upload.abort();
      expect(await store.head(`${prefix}aborted`)).toBeNull();
      await expect(store.put(`${prefix}huge`, filled(PART_BYTES + 1, 0))).rejects.toMatchObject({ code: "too_large" });
    });
  });
}
