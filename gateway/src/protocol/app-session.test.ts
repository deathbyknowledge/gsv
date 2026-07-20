import { describe, expect, it } from "vitest";
import {
  buildAppDataRunnerName,
  buildAppRunnerName,
  buildRoutedAppSessionId,
  buildRoutedAppSessionSigningInput,
  isLegacyAppSessionId,
  isAppRunnerControlName,
  isAppRunnerDataName,
  parseRoutedAppSessionId,
} from "./app-session";

const ROUTE = {
  username: "alice",
  uid: 1000,
  generation: 7,
  expiresAt: 2_000_000_000_000,
  nonce: "4f57c735-a614-4e0f-a36a-e5c60b94db15",
  placementCertificate: "A".repeat(86),
};

describe("routed app session ids", () => {
  it("round-trips a canonical, bounded user Kernel locator", () => {
    const sessionId = buildRoutedAppSessionId(ROUTE, "A".repeat(43));

    expect(parseRoutedAppSessionId(sessionId)).toEqual({
      ...ROUTE,
      signature: "A".repeat(43),
      signingInput: buildRoutedAppSessionSigningInput(ROUTE),
    });
    expect(isLegacyAppSessionId(sessionId)).toBe(false);
  });

  it("fits the largest canonical identity tuple inside the 256-byte handle", () => {
    const sessionId = buildRoutedAppSessionId({
      ...ROUTE,
      username: `a${"b".repeat(31)}`,
      uid: Number.MAX_SAFE_INTEGER,
      generation: Number.MAX_SAFE_INTEGER,
    }, "A".repeat(43));

    expect(sessionId).toHaveLength(254);
    expect(parseRoutedAppSessionId(sessionId)).not.toBeNull();
  });

  it("rejects aliases, malformed fields, and oversized handles", () => {
    expect(parseRoutedAppSessionId(
      buildRoutedAppSessionId(ROUTE, "A".repeat(43)).replace("~alice~", "~Alice~"),
    )).toBeNull();
    expect(parseRoutedAppSessionId(
      `gsv1b~alice~1000~0~1~bad~${"A".repeat(86)}~${"A".repeat(43)}`,
    )).toBeNull();
    expect(parseRoutedAppSessionId(
      buildRoutedAppSessionId(ROUTE, "A".repeat(43))
        .replace(ROUTE.placementCertificate, `${"A".repeat(85)}B`),
    )).toBeNull();
    expect(() => buildRoutedAppSessionId(ROUTE, `${"A".repeat(42)}B`))
      .toThrow("Invalid routed app session signature");
    expect(() => buildRoutedAppSessionId({
      ...ROUTE,
      username: `a${"b".repeat(31)}`,
      uid: Number.MAX_SAFE_INTEGER,
      generation: Number.MAX_SAFE_INTEGER,
      expiresAt: Number.MAX_SAFE_INTEGER,
    }, "A".repeat(43))).toThrow("Routed app session id is too large");
    expect(parseRoutedAppSessionId("x".repeat(257))).toBeNull();
  });

  it("recognizes only canonical UUIDs as legacy session ids", () => {
    expect(isLegacyAppSessionId("4f57c735-a614-4e0f-a36a-e5c60b94db15")).toBe(true);
    expect(isLegacyAppSessionId("4F57C735-A614-4E0F-A36A-E5C60B94DB15")).toBe(false);
    expect(isLegacyAppSessionId("session-1")).toBe(false);
  });
});

describe("AppRunner control object names", () => {
  it("hard-cuts authority-bearing state to owner-scoped namespaces", () => {
    expect(buildAppRunnerName(1000, 2000, "pkg-chat"))
      .toBe("app-control-v3:1000:2000:pkg-chat");
    expect(buildAppRunnerName(1000, 2000, "global:chat"))
      .toBe("app-control-v3:1000:2000:global%3Achat");
    expect(buildAppDataRunnerName(1000, 2000, "pkg-chat"))
      .toBe("app-data-v2:1000:2000:pkg-chat");
    expect(buildAppRunnerName(1000, 2000, "pkg-chat")).not.toMatch(/^app:/);
    expect(isAppRunnerControlName(buildAppRunnerName(1000, 2000, "pkg-chat"))).toBe(true);
    expect(isAppRunnerDataName(buildAppDataRunnerName(1000, 2000, "pkg-chat"))).toBe(true);
    expect(isAppRunnerControlName("app:1000:pkg-chat")).toBe(false);
    expect(isAppRunnerControlName("app-control-v2:2000:pkg-chat")).toBe(false);
    expect(isAppRunnerDataName("app-data:2000:pkg-chat")).toBe(false);
  });

  it("isolates the same run-as actor and package across Kernel owners", () => {
    expect(buildAppRunnerName(1000, 0, "pkg-chat"))
      .not.toBe(buildAppRunnerName(1001, 0, "pkg-chat"));
    expect(buildAppDataRunnerName(1000, 0, "pkg-chat"))
      .not.toBe(buildAppDataRunnerName(1001, 0, "pkg-chat"));
    expect(buildAppRunnerName(1000, 2000, "pkg-chat"))
      .not.toBe(buildAppRunnerName(1000, 2001, "pkg-chat"));
  });

  it("rejects ambiguous control object authority", () => {
    expect(() => buildAppRunnerName(-1, 2000, "pkg-chat")).toThrow();
    expect(() => buildAppRunnerName(1000, -1, "pkg-chat")).toThrow();
    expect(() => buildAppRunnerName(1000, 2000, " ")).toThrow();
  });
});
