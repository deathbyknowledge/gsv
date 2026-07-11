import { describe, expect, it } from "vitest";
import {
  isPresenceRunSignal,
  runIdFromSignalPayload,
  signalPayloadAborted,
  signalPayloadError,
  signalPayloadStreamTextDelta,
  signalPayloadStreamToolLabel,
  signalPayloadText,
  signalPayloadToolLabel,
} from "./signals";

describe("presence signal helpers", () => {
  it("extracts stable run payload fields", () => {
    expect(runIdFromSignalPayload({ runId: "run-1" })).toBe("run-1");
    expect(runIdFromSignalPayload({ runId: "" })).toBeNull();
    expect(signalPayloadText({ text: "  hello  " })).toBe("hello");
    expect(signalPayloadText({ text: "   " })).toBeNull();
    expect(signalPayloadError({ error: " failed " })).toBe("failed");
    expect(signalPayloadError({ error: "" })).toBeNull();
    expect(signalPayloadAborted({ aborted: true })).toBe(true);
  });

  it("recognizes presence run signals", () => {
    expect(isPresenceRunSignal("proc.run.stream")).toBe(true);
    expect(isPresenceRunSignal("chat.complete")).toBe(false);
    expect(isPresenceRunSignal("notification.created")).toBe(false);
  });

  it("extracts tool labels from direct and streamed tool payloads", () => {
    expect(signalPayloadToolLabel({ name: "fs.read" })).toBe("fs.read");
    expect(signalPayloadToolLabel({ syscall: "pkg.list" })).toBe("pkg.list");
    expect(signalPayloadStreamToolLabel({
      event: {
        type: "toolcall_start",
        toolCall: { name: "proc.spawn" },
      },
    })).toBe("proc.spawn");
    expect(signalPayloadStreamToolLabel({
      event: {
        type: "toolcall_delta",
        contentIndex: 0,
        partial: {
          content: [{ type: "toolCall", syscall: "fs.copy" }],
        },
      },
    })).toBe("fs.copy");
  });

  it("extracts text deltas from run stream events", () => {
    expect(signalPayloadStreamTextDelta({
      event: { type: "text_delta", delta: "hello" },
    })).toBe("hello");
    expect(signalPayloadStreamTextDelta({
      event: { type: "text_delta", delta: "" },
    })).toBeNull();
  });
});
