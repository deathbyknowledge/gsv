import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dispatchTargetChatProcess,
  normalizeTargetChatProcess,
  TARGET_CHAT_PROCESS_EVENT,
} from "./targetChatProcess";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("target chat process", () => {
  it("normalizes only an explicit process target", () => {
    expect(normalizeTargetChatProcess({ pid: " proc:review " })).toEqual({ pid: "proc:review" });
    expect(normalizeTargetChatProcess({})).toBeNull();
  });

  it("opens through a browser-local event without a routing write", () => {
    const dispatchEvent = vi.fn();
    class LocalCustomEvent {
      readonly detail: unknown;
      readonly type: string;

      constructor(type: string, init: { detail: unknown }) {
        this.type = type;
        this.detail = init.detail;
      }
    }
    vi.stubGlobal("window", { dispatchEvent });
    vi.stubGlobal("CustomEvent", LocalCustomEvent);

    dispatchTargetChatProcess({ pid: "proc:review" });

    expect(dispatchEvent).toHaveBeenCalledOnce();
    expect(dispatchEvent.mock.calls[0]?.[0]).toMatchObject({
      type: TARGET_CHAT_PROCESS_EVENT,
      detail: { pid: "proc:review" },
    });
  });
});
