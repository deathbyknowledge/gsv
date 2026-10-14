import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { exceptionDiagnostics, sanitizeExceptionDiagnostics } from "../dist/telemetry.js";

describe("exception diagnostics", () => {
  it("keeps actionable provider fields without serializing request or response data", () => {
    const error = Object.assign(new Error("Rate limit exceeded"), {
      name: "APIError", code: "rate_limit_exceeded", status: 429, request_id: "req_example",
      request: { prompt: "private prompt", headers: { Authorization: "Bearer private-key" } },
      response: { body: "private response" },
    });
    const diagnostic = exceptionDiagnostics(error);
    assert.equal(diagnostic.exceptionName, "APIError");
    assert.equal(diagnostic.exceptionMessage, "Rate limit exceeded");
    assert.equal(diagnostic.errorCode, "rate_limit_exceeded");
    assert.equal(diagnostic.providerStatusCode, 429);
    assert.equal(diagnostic.providerRequestId, "req_example");
    assert.match(diagnostic.exceptionStack, /at /);
    assert.ok(!JSON.stringify(diagnostic).includes("private"));
  });

  it("scrubs common credentials, signed URLs, email addresses and user paths", () => {
    const diagnostic = exceptionDiagnostics(new Error(
      "Fetch failed https://alice:private-password@api.example.test/v1?api_key=private-query#private-fragment "
      + "Bearer private-bearer access_token=private-token apiKey=private-key chat_id=private-chat user@example.test /home/alice/private-file",
    ));
    const text = JSON.stringify(diagnostic);
    assert.match(text, /Fetch failed/);
    assert.match(text, /api.example.test\/v1/);
    for (const secret of ["alice", "private-password", "private-query", "private-fragment", "private-bearer", "private-token", "private-key", "private-chat", "user@example.test", "private-file"]) {
      assert.ok(!text.includes(secret), secret);
    }
    assert.deepEqual(sanitizeExceptionDiagnostics(diagnostic), diagnostic);
  });

  it("selects the message from SDK JSON and excludes repeated payloads in the stack", () => {
    const diagnostic = exceptionDiagnostics(new Error('400 {"error":{"message":"Invalid model"},"request":{"messages":["private prompt"]}}'));
    assert.equal(diagnostic.exceptionMessage, "400 Invalid model");
    assert.ok(!JSON.stringify(diagnostic).includes("private prompt"));
    assert.ok(!JSON.stringify(diagnostic).includes("messages"));
  });

  it("bounds the selected fields and stops at one cause", () => {
    const error = Object.assign(new Error("x".repeat(10_000)), {
      cause: Object.assign(new Error("socket closed"), { cause: new Error("deeper private content") }),
      code: "c".repeat(1000), requestId: "r".repeat(1000),
    });
    const diagnostic = exceptionDiagnostics(error);
    assert.equal(diagnostic.exceptionMessage.length, 2048);
    assert.ok(diagnostic.exceptionStack.length <= 8192);
    assert.equal(diagnostic.errorCode.length, 128);
    assert.equal(diagnostic.providerRequestId.length, 256);
    assert.equal(diagnostic.exceptionCause, "socket closed");
    assert.deepEqual(exceptionDiagnostics({ request: "private", response: "private" }), {});
    assert.deepEqual(exceptionDiagnostics(null), {});
  });
});
