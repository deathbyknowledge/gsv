import { describe, expect, it } from "vitest";
import {
  decodeWireFrameJson,
  decodeWireResponse,
  InvalidWireFrameError,
} from "./decode-wire-frame";

describe("decodeWireFrameJson", () => {
  it.each([
    ["fs.write", { path: "/notes.txt", content: "hello" }],
    ["fs.edit", { path: "/notes.txt", oldString: "hello", newString: "hi" }],
    ["fs.delete", { path: "/notes.txt" }],
    ["fs.search", { query: "hello", path: "/" }],
    ["fs.transfer.stat", { path: "/notes.txt" }],
    ["fs.transfer.receive", { path: "/notes.txt", contentType: "text/plain" }],
  ])("accepts a string target for %s without relaxing argument validation", (call, args) => {
    const frame = { type: "req", id: "targeted-filesystem", call, args };
    for (const target of [undefined, "gsv", "cloud-computer"]) {
      const targeted = { ...frame, args: { ...args, target } };
      expect(decodeWireFrameJson(JSON.stringify(targeted))).toEqual(JSON.parse(JSON.stringify(targeted)));
    }
    for (const invalid of [{ ...args, target: 42 }, { ...args, target: "cloud-computer", unexpected: true }]) {
      expect(() => decodeWireFrameJson(JSON.stringify({ ...frame, args: invalid })))
        .toThrow(InvalidWireFrameError);
    }
  });

  it("accepts ordinary contextual text and rejects withdrawn action metadata", () => {
    const frame = {
      type: "req", id: "plain-request", call: "conversation.send",
      args: { conversationId: "ship", text: "Help me create a routine, only on Mondays.", selectedTarget: "gsv", idempotencyKey: "plain-request" },
    };
    expect(decodeWireFrameJson(JSON.stringify(frame))).toEqual(frame);
    expect(() => decodeWireFrameJson(JSON.stringify({
      ...frame, args: { ...frame.args, action: { kind: "routine.create" } },
    }))).toThrow(InvalidWireFrameError);
  });

  it.each([
    "account.passkey.register.begin",
    "account.passkey.register.finish",
    "account.passkey.authenticate.begin",
    "account.passkey.authenticate.finish",
    "account.passkey.list",
    "account.passkey.revoke",
  ])("rejects the retired passkey syscall %s before dispatch", (call) => {
    expect(() => decodeWireFrameJson(JSON.stringify({ type: "req", id: "retired-passkey", call, args: {} })))
      .toThrow(InvalidWireFrameError);
  });

  it.each([{}, { targets: [] }])("preserves unavailable versus empty target catalogs over the wire: %j", (targets) => {
    const response = {
      type: "res" as const,
      id: "context-targets",
      ok: true as const,
      data: { ...targets, mcpServers: [], system: { timezone: "UTC" }, skillIndexMode: "off" },
    };
    expect(decodeWireResponse("ai.context", response)).toEqual(response);
  });

  it.each(["person", "model", "both"])("accepts a registered target watch for audience %s", (audience) => {
    const frame = {
      type: "req", id: "target-watch", call: "signal.watch",
      args: { signal: "target.status", targetId: "laptop", audience, key: "connection", once: false },
    };
    expect(decodeWireFrameJson(JSON.stringify(frame))).toEqual(frame);
  });

  it.each([
    { signal: "proc.run.finished", processId: "old-process" },
    { signal: "target.status" },
    { signal: "proc.run.finished", targetId: "laptop" },
    { signal: "target.status", targetId: "laptop", processId: "old-process" },
  ])("rejects unregistered or retired signal-watch sources", (args) => {
    expect(() => decodeWireFrameJson(JSON.stringify({
      type: "req", id: "old-watch", call: "signal.watch", args,
    }))).toThrow(InvalidWireFrameError);
  });

  it("decodes a syscall request with its call-specific argument contract", () => {
    expect(decodeWireFrameJson(JSON.stringify({
      type: "req",
      id: "request-1",
      call: "fs.read",
      args: { path: "/notes.txt", limit: 50 },
    }))).toEqual({
      type: "req",
      id: "request-1",
      call: "fs.read",
      args: { path: "/notes.txt", limit: 50 },
    });
  });

  it.each([
    {
      type: "req",
      id: "request-1",
      call: "fs.read",
      args: { path: 42 },
    },
    {
      type: "req",
      id: "request-1",
      call: "unknown.call",
      args: {},
    },
    {
      type: "req",
      id: "request-1",
      call: "fs.read",
      args: { path: "/notes.txt" },
      unexpected: true,
    },
    {
      type: "sig",
      signal: "peer.ping",
      body: { streamId: 1 },
    },
  ])("rejects values outside the wire contract", (frame) => {
    expect(() => decodeWireFrameJson(JSON.stringify(frame))).toThrow(InvalidWireFrameError);
  });

  it("decodes response errors and generic JSON signals", () => {
    expect(decodeWireFrameJson(JSON.stringify({
      type: "res",
      id: "request-1",
      ok: false,
      error: {
        code: 409,
        message: "Conflict",
        details: { owner: "kernel", retryAfterMs: 100 },
      },
    }))).toMatchObject({ type: "res", ok: false });

    expect(decodeWireFrameJson(JSON.stringify({
      type: "sig",
      signal: "peer.ping",
      payload: { nonce: "nonce-1" },
      seq: 4,
    }))).toMatchObject({ type: "sig", signal: "peer.ping" });
  });

  it("distinguishes malformed JSON from a structurally invalid frame", () => {
    expect(() => decodeWireFrameJson("{"))
      .toThrowError(new InvalidWireFrameError("Malformed JSON"));
    expect(() => decodeWireFrameJson("null"))
      .toThrowError(new InvalidWireFrameError("Invalid frame"));
  });

  it("validates a successful response against its routed syscall", () => {
    const response = {
      type: "res" as const,
      id: "request-1",
      ok: true as const,
      data: {
        ok: true,
        path: "/notes.txt",
        kind: "text",
        contentType: "text/plain",
        size: 12,
      },
    };

    expect(decodeWireResponse("fs.read", response)).toEqual(response);
    expect(() => decodeWireResponse("fs.write", response))
      .toThrowError(new InvalidWireFrameError("Invalid fs.write response"));
  });

  it("accepts the public shell result and rejects host-only response fields", () => {
    const response = {
      type: "res" as const,
      id: "shell-1",
      ok: true as const,
      data: {
        status: "completed",
        output: "done\n",
        exitCode: 0,
        sessionId: "session-1",
        truncated: false,
        stdout: "done\n",
        stderr: "",
      },
    };

    expect(decodeWireResponse("shell.exec", response)).toEqual(response);
    expect(() => decodeWireResponse("shell.exec", {
      ...response,
      data: { ...response.data, cwd: "/workspace" },
    })).toThrowError(new InvalidWireFrameError("Invalid shell.exec response"));
  });

  it("retains a request id when call-specific arguments are invalid", () => {
    try {
      decodeWireFrameJson(JSON.stringify({
        type: "req",
        id: "request-invalid",
        call: "fs.read",
        args: { path: 42 },
      }));
      throw new Error("Expected decoding to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidWireFrameError);
      expect(error).toMatchObject({ frameId: "request-invalid" });
    }
  });
});
