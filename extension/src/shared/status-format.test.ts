import { describe, expect, it } from "vitest";
import { browserTargetHeadline, browserTargetTone, liveAccessCount } from "./status-format";
import type { ExtensionUiState } from "./ui-state";

describe("browser target status", () => {
  it("shows in-flight requests as work even without a capture or debugger tab", () => {
    const state: ExtensionUiState = {
      config: { gatewayUrl: "", username: "", token: "", deviceId: "chrome", autoConnect: false },
      activeRequests: [{ label: "tabs open", detail: "https://example.test/" }],
      connection: { state: "connected", connectionId: null, message: null, reconnectSuppressed: false },
      targetId: "chrome",
      gatewayHost: "",
      activity: [],
      sensitive: { connected: true, networkCaptures: 0, mediaRecordings: 0, debuggerTabs: [], lastSensitiveAt: null },
      network: { captures: [] },
      media: { captureGrant: null },
      artifact: { screenshots: 0, networkSessions: 0, files: 0 },
      diagnostics: {
        lastConnectAttemptAt: null,
        lastConnectedAt: null,
        lastDisconnectedAt: null,
        lastSuccessfulConnectionId: null,
        lastConnectionErrorAt: null,
        lastConnectionError: null,
        lastErrorAt: null,
        lastError: null,
        activityCount: 0,
        artifactPathCount: 0,
        updatedAt: null,
      },
      updatedAt: "",
    };

    expect(liveAccessCount(state)).toBe(1);
    expect(browserTargetHeadline(state)).toBe("Agent using this browser");
    expect(browserTargetTone(state)).toBe("active");

    state.connection.reconnectSuppressed = true;
    expect(browserTargetHeadline(state)).toBe("Browser activity remains");
  });
});
