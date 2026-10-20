import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cancelInferenceRequest,
  decodeInferenceRequest,
  encodeInferenceRequest,
  MAX_INFERENCE_CONTEXT_BYTES,
} from "../dist/services/inference-body.js";

const metadata = {
  version: 1, installationId: "inst_body", logicalRequestId: "request-body",
  actor: { localUid: 1000 }, timeoutMs: 10_000, deadlineAt: 100_000,
};
function context(data = "AAECAwQF/w==") {
  return {
    ...metadata,
    systemPrompt: "Synthetic policy ☄️",
    messages: [
      { role: "user", content: "Read these images.\nPreserve paragraphs." },
      { role: "toolResult", toolCallId: "call-1", toolName: "Read", isError: false,
        content: [{ type: "text", text: "image fixture" },
          { type: "image", mimeType: "image/png", data },
          { type: "image", mimeType: "image/jpeg", data: "" }] },
    ],
    tools: [{ name: "Read", description: "Read", parameters: { type: "object" } }],
  };
}

test("inference transports binary images and restores exact ordered context", async () => {
  const input = context();
  const wire = encodeInferenceRequest(input);
  assert.equal(wire.messages, undefined);
  assert.equal(wire.systemPrompt, undefined);
  assert.equal(wire.tools, undefined);
  assert.equal(wire.installationId, input.installationId);
  const form = await new Response(wire.contextBody.stream, {
    headers: { "content-type": wire.contextBody.contentType },
  }).formData();
  assert.deepEqual(new Uint8Array(await form.get("image:1:1").arrayBuffer()), Uint8Array.of(0, 1, 2, 3, 4, 5, 255));
  assert.equal(JSON.parse(form.get("context")).messages[1].content[1].data, "");
  assert.deepEqual(await decodeInferenceRequest(encodeInferenceRequest(input)), input);
  assert.equal(input.messages[1].content[1].data, "AAECAwQF/w==");
});

test("a context above the RPC serialization limit round trips across both body hops", async () => {
  const image = Buffer.alloc(1_750_000, 0x5a).toString("base64");
  const input = {
    ...metadata,
    messages: Array.from({ length: 15 }, (_, index) => ({
      role: "user", content: [{ type: "text", text: `Image ${index}` },
        { type: "image", mimeType: "image/png", data: image }],
    })),
  };
  assert.ok(Buffer.byteLength(JSON.stringify(input)) > 32 * 1024 * 1024);
  const first = await decodeInferenceRequest(encodeInferenceRequest(input));
  const second = await decodeInferenceRequest(encodeInferenceRequest(first));
  assert.deepEqual(second.messages, input.messages);
  assert.equal(second.logicalRequestId, input.logicalRequestId);
});

test("inline callers remain supported during receiver-first rollout", async () => {
  const input = context();
  assert.equal(await decodeInferenceRequest(input), input);
});

test("body fields cannot override trusted request identity or limits", async () => {
  const form = new FormData();
  form.append("context", JSON.stringify({
    installationId: "inst_other", actor: { localUid: 0 }, deadlineAt: Number.MAX_SAFE_INTEGER,
    messages: [{ role: "user", content: "synthetic" }],
  }));
  const body = new Response(form);
  const decoded = await decodeInferenceRequest({
    ...metadata,
    contextBody: { contentType: body.headers.get("content-type"), stream: body.body },
  });
  assert.deepEqual(decoded.actor, metadata.actor);
  assert.equal(decoded.installationId, metadata.installationId);
  assert.equal(decoded.deadlineAt, metadata.deadlineAt);
});

test("cancellation during an unfinished upload cancels its source and rejects", async () => {
  let cancelled = false;
  const input = {
    ...metadata,
    contextBody: { contentType: "multipart/form-data; boundary=test", stream: new ReadableStream({
      type: "bytes", cancel() { cancelled = true; },
    }) },
  };
  const controller = new AbortController();
  const pending = decodeInferenceRequest(input, controller.signal);
  controller.abort(new Error("fixture cancellation"));
  await assert.rejects(pending, /fixture cancellation/);
  assert.equal(cancelled, true);
});

test("pre-read rejection releases an unconsumed request body", async () => {
  let cancelled = false;
  const input = { ...metadata, contextBody: {
    contentType: "text/plain",
    stream: new ReadableStream({ type: "bytes", cancel() { cancelled = true; } }),
  } };
  await assert.rejects(decodeInferenceRequest(input), /Invalid inference context body/);
  assert.equal(cancelled, true);
  cancelInferenceRequest(input);
});

test("invalid multipart headers release the original body without starting a read", async () => {
  for (const boundary of ["a\u0000b", "snow☃"]) {
    let cancelled = false;
    const stream = new ReadableStream({
      type: "bytes",
      cancel() { cancelled = true; },
    });
    await assert.rejects(decodeInferenceRequest({
      ...metadata, contextBody: { contentType: `multipart/form-data; boundary=${boundary}`, stream },
    }));
    assert.equal(cancelled, true);
    assert.equal(stream.locked, false);
  }
});

test("missing, duplicate or unexpected image parts are rejected", async () => {
  for (const variant of ["missing", "duplicate", "unexpected"]) {
    const original = encodeInferenceRequest(context());
    const form = await new Response(original.contextBody.stream, {
      headers: { "content-type": original.contextBody.contentType },
    }).formData();
    if (variant === "missing") form.delete("image:1:1");
    if (variant === "duplicate") form.append("image:1:1", new Blob(["duplicate"]), "image");
    if (variant === "unexpected") form.append("image:9:9", new Blob(["unexpected"]), "image");
    const response = new Response(form);
    await assert.rejects(decodeInferenceRequest({
      ...metadata, contextBody: { contentType: response.headers.get("content-type"), stream: response.body },
    }), /inference (image body|body part)/);
  }
});

test("the parser's byte limit cancels oversized multipart input", async () => {
  let cancelled = false;
  let bytes = 0;
  const input = { ...metadata, contextBody: {
    contentType: "multipart/form-data; boundary=test",
    stream: new ReadableStream({
      type: "bytes",
      start(controller) {
        controller.enqueue(new TextEncoder().encode('--test\r\nContent-Disposition: form-data; name="image"; filename="image"\r\n\r\n'));
      },
      pull(controller) {
        bytes += 64 * 1024;
        controller.enqueue(new Uint8Array(64 * 1024));
      },
      cancel() { cancelled = true; },
    }),
  } };
  await assert.rejects(decodeInferenceRequest(input), /byte limit/);
  assert.equal(cancelled, true);
  assert.ok(bytes <= MAX_INFERENCE_CONTEXT_BYTES + 64 * 1024);
});
