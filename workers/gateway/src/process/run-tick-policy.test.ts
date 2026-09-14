import { describe, expect, it } from "vitest";
import type { AiConfigResult } from "@humansandmachines/gsv/protocol";
import type { AssistantMessage } from "@humansandmachines/gsv/services/inference-context";
import {
  classifyAssistantTurn,
  nextAiConfigFallback,
} from "./run-tick-policy";
import { parseAttachPath } from "./run-control-command";

function assistant(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "test",
    provider: "test",
    model: "test",
    stopReason: "stop",
    timestamp: 1,
  };
}

function config(overrides: Partial<AiConfigResult> = {}): AiConfigResult {
  return {
    executor: { kind: "process", pid: "policy-test" },
    provider: "primary",
    model: "primary-model",
    apiKey: "primary-key",
    maxTokens: 1_000,
    contextWindowTokens: 32_000,
    contextWindowSource: "config",
    maxContextBytes: 32_768,
    generationTimeoutMs: 180_000,
    ...overrides,
  };
}

describe("run tick policy", () => {
  it("classifies assistant turns without overlapping continuation categories", () => {
    const runControl = {
      type: "toolCall" as const,
      id: "yield-call",
      name: "Shell",
      arguments: { input: "yield" },
    };
    const read = {
      type: "toolCall" as const,
      id: "read-call",
      name: "Read",
      arguments: { path: "/tmp/value" },
    };
    const forged = {
      type: "toolCall" as const,
      id: "forged-call",
      name: "RootAccess",
      arguments: {},
    };

    expect(classifyAssistantTurn(assistant([runControl]), ["Read"]).kind).toBe("run-control");
    expect(classifyAssistantTurn(assistant([runControl, read]), ["Read"]).kind).toBe(
      "invalid-run-control",
    );
    expect(classifyAssistantTurn(assistant([read, forged]), ["Read"]).kind).toBe("tools");
    expect(classifyAssistantTurn(assistant([forged]), ["Read"]).kind).toBe("unoffered-tools");
    expect(
      classifyAssistantTurn(assistant([{ type: "text", text: "done" }]), ["Read"]),
    ).toMatchObject({ kind: "terminal", text: "done" });
  });

  it("classifies Send tool calls as the same run control as the commands", () => {
    const send = (id: string, args: Record<string, string | boolean | number>) => ({
      type: "toolCall" as const,
      id,
      name: "Send",
      arguments: args,
    });
    const read = { type: "toolCall" as const, id: "read-call", name: "Read", arguments: { path: "/tmp/value" } };
    const parsedOf = (content: AssistantMessage["content"]) =>
      classifyAssistantTurn(assistant(content), ["Read", "Send"]).runControlCalls[0]?.parsed;

    expect(classifyAssistantTurn(assistant([send("s1", { text: "hello" })]), ["Read", "Send"]).kind).toBe(
      "run-control",
    );
    // where Send was not offered, as in a bounded IPC run, a fabricated call is unoffered like any other
    expect(classifyAssistantTurn(assistant([send("s0", { text: "hello" })]), ["Read"]).kind).toBe(
      "unoffered-tools",
    );
    expect(parsedOf([send("s1", { text: "hello" })])).toEqual({
      ok: true,
      command: { action: "message", text: "hello", finish: false },
    });
    expect(parsedOf([send("s2", { text: "bye", yield: true })])).toEqual({
      ok: true,
      command: { action: "message", text: "bye", finish: true },
    });
    // yield alone is a final message when media is staged and a bare yield otherwise; the runtime decides
    expect(parsedOf([send("s3", { yield: true })])).toEqual({
      ok: true,
      command: { action: "message", text: "", finish: true, emptyMeansYield: true },
    });
    // an empty send is a message with no text: the runtime decides whether staged media makes it one
    expect(parsedOf([send("s4", {})])).toEqual({ ok: true, command: { action: "message", text: "", finish: false } });
    expect(parsedOf([send("s5", { text: "x", extra: 1 })])).toMatchObject({ ok: false, action: "message" });
    expect(classifyAssistantTurn(assistant([send("s6", { text: "x" }), read]), ["Read", "Send"]).kind).toBe(
      "invalid-run-control",
    );
  });

  it("carries the files a Send names, trimmed and once each, and treats a send with files as a message", () => {
    const parsedOf = (content: AssistantMessage["content"]) =>
      classifyAssistantTurn(assistant(content), ["Send"]).runControlCalls[0]?.parsed;
    const withFiles = {
      type: "toolCall" as const,
      id: "s7",
      name: "Send",
      arguments: { text: "here", attach: [" laptop:/home/e/report.pdf", "/tmp/a.png", "", "/tmp/a.png"] },
    };
    expect(parsedOf([withFiles])).toEqual({
      ok: true,
      command: { action: "message", text: "here", finish: false, attach: ["laptop:/home/e/report.pdf", "/tmp/a.png"] },
    });
    const filesOnly = { type: "toolCall" as const, id: "s8", name: "Send", arguments: { yield: true, attach: ["/tmp/a.png"] } };
    expect(parsedOf([filesOnly])).toEqual({
      ok: true,
      command: { action: "message", text: "", finish: true, attach: ["/tmp/a.png"] },
    });
  });

  it("reads where an attached file lives the way cp does", () => {
    expect(parseAttachPath("/tmp/a.png")).toEqual({ target: "gsv", path: "/tmp/a.png" });
    expect(parseAttachPath("~/notes/a.md")).toEqual({ target: "gsv", path: "~/notes/a.md" });
    expect(parseAttachPath("laptop:/home/e/report.pdf")).toEqual({ target: "laptop", path: "/home/e/report.pdf" });
    expect(parseAttachPath("[desk]:C:\\Users\\e\\report.pdf")).toEqual({ target: "desk", path: "C:\\Users\\e\\report.pdf" });
    expect(parseAttachPath("[]:/tmp/a.png")).toEqual({ target: "gsv", path: "/tmp/a.png" });
  });

  it("skips duplicate fallback stacks without carrying fallback chains", () => {
    const primary = config({
      fallbacks: [
        {
          provider: "primary",
          model: "primary-model",
          apiKey: "primary-key",
          maxTokens: 2_000,
          contextWindowTokens: 64_000,
          contextWindowSource: "config",
          generationTimeoutMs: 90_000,
        },
        {
          provider: "backup",
          model: "backup-model",
          apiKey: "backup-key",
          maxTokens: 2_000,
          contextWindowTokens: 64_000,
          contextWindowSource: "config",
          generationTimeoutMs: 90_000,
        },
      ],
    });

    expect(nextAiConfigFallback(primary, primary, primary.fallbacks ?? [], 0)).toMatchObject({
      nextIndex: 2,
      config: {
        provider: "backup",
        model: "backup-model",
        apiKey: "backup-key",
      },
    });
    expect(
      nextAiConfigFallback(primary, primary, primary.fallbacks ?? [], 0)?.config,
    ).not.toHaveProperty("fallbacks");
  });
});
