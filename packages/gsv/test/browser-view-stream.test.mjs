import assert from "node:assert/strict";
import test from "node:test";
import { encodeBrowserViewPacket, decodeBrowserViewStream, MAX_BROWSER_IMAGE_BYTES } from "../dist/protocol.js";

const metadata = { kind: "frame", sequence: 1, capturedAt: 123, tabId: 7, documentId: "document", width: 1280, height: 800 };
const state = { kind: "state", tabs: [{ id: 7, title: "Example", url: "https://example.com" }], activeTabId: 7 };
function body(chunks, cancel) { return { stream: new ReadableStream({ start(c) { for (const chunk of chunks) c.enqueue(chunk); c.close(); }, cancel }) }; }

test("browser records survive arbitrary binary chunk boundaries", async () => {
  const bytes = Buffer.concat([encodeBrowserViewPacket(state), encodeBrowserViewPacket(metadata, new Uint8Array([1, 2, 3]))]);
  for (const size of [1, 7, 13, bytes.length]) {
    const chunks = [];
    for (let i = 0; i < bytes.length; i += size) chunks.push(new Uint8Array(bytes.subarray(i, i + size)));
    assert.deepEqual(await Array.fromAsync(decodeBrowserViewStream(body(chunks))), [
      { metadata: state, image: new Uint8Array() }, { metadata, image: new Uint8Array([1, 2, 3]) },
    ]);
  }
});

test("rejects truncated, oversized and invalid records before rendering", async () => {
  const bytes = encodeBrowserViewPacket(metadata, new Uint8Array([1, 2, 3]));
  for (const length of [1, 7, bytes.length - 1]) await assert.rejects(Array.fromAsync(decodeBrowserViewStream(body([bytes.slice(0, length)]))), /inside a frame/);
  const prefix = bytes.slice(0, 8);
  new DataView(prefix.buffer).setUint32(4, MAX_BROWSER_IMAGE_BYTES + 1, true);
  await assert.rejects(Array.fromAsync(decodeBrowserViewStream(body([prefix]))), /size limit/);
  const invalid = encodeBrowserViewPacket({ ...metadata, tabId: -1 }, new Uint8Array([1]));
  await assert.rejects(Array.fromAsync(decodeBrowserViewStream(body([invalid]))));
});

test("aborting a waiting viewer cancels its open body", async () => {
  let cancelled = 0;
  const stream = { stream: new ReadableStream({ cancel() { cancelled++; } }) };
  const abort = new AbortController();
  const reading = Array.fromAsync(decodeBrowserViewStream(stream, abort.signal));
  abort.abort(new Error("viewer closed"));
  await assert.rejects(reading, /viewer closed/);
  assert.equal(cancelled, 1);
});
