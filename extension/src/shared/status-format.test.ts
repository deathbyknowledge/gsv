import { describe, expect, it } from "vitest";
import { browserTargetHeadline, browserTargetTone, liveAccessCount } from "./status-format";
import type { ExtensionUiState } from "./ui-state";

describe("browser target status", () => {
  it("shows in-flight requests as work even without a capture or debugger tab", () => {
    const state = {
      activeRequests: [{ label: "tabs open", detail: "https://example.test/" }],
      connection: { state: "connected" },
      sensitive: { networkCaptures: 0, mediaRecordings: 0, debuggerTabs: [] },
    } as unknown as ExtensionUiState;

    expect(liveAccessCount(state)).toBe(1);
    expect(browserTargetHeadline(state)).toBe("Agent using this browser");
    expect(browserTargetTone(state)).toBe("active");

    state.connection.reconnectSuppressed = true;
    expect(browserTargetHeadline(state)).toBe("Browser activity remains");
  });
});
