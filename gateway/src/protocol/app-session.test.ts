import { describe, expect, it } from "vitest";
import {
  buildAppRunnerName,
  buildRoutedAppSessionId,
  buildRoutedAppSessionSigningInput,
  parseRoutedAppSessionId,
} from "./app-session";

const ROUTE = {
  username: "alice",
  uid: 1000,
  expiresAt: 2_000_000_000_000,
  nonce: "4f57c735-a614-4e0f-a36a-e5c60b94db15",
};

describe("routed app session ids", () => {
  it("round-trips the target-verified user Kernel locator", () => {
    const sessionId = buildRoutedAppSessionId(ROUTE, "A".repeat(43));

    expect(sessionId).toBe(
      `gsv1b~alice~1000~2000000000000~${ROUTE.nonce}~${"A".repeat(43)}`,
    );
    expect(parseRoutedAppSessionId(sessionId)).toEqual({
      ...ROUTE,
      signature: "A".repeat(43),
      signingInput: buildRoutedAppSessionSigningInput(ROUTE),
    });
  });

  it("fits the largest canonical identity tuple well inside the route bound", () => {
    const sessionId = buildRoutedAppSessionId({
      ...ROUTE,
      username: `a${"b".repeat(31)}`,
      uid: Number.MAX_SAFE_INTEGER,
      expiresAt: Number.MAX_SAFE_INTEGER,
    }, "A".repeat(43));

    expect(sessionId.length).toBeLessThanOrEqual(256);
    expect(parseRoutedAppSessionId(sessionId)).not.toBeNull();
  });

  it("rejects aliases, old formats, malformed fields, and noncanonical signatures", () => {
    expect(parseRoutedAppSessionId(
      buildRoutedAppSessionId(ROUTE, "A".repeat(43)).replace("~alice~", "~Alice~"),
    )).toBeNull();
    expect(parseRoutedAppSessionId(
      `gsv1b~alice~1000~7~2000000000000~${ROUTE.nonce}~${"A".repeat(43)}`,
    )).toBeNull();
    expect(parseRoutedAppSessionId(
      "4f57c735-a614-4e0f-a36a-e5c60b94db15",
    )).toBeNull();
    expect(parseRoutedAppSessionId(
      `gsv1b~alice~1000~1~bad~${"A".repeat(43)}`,
    )).toBeNull();
    expect(() => buildRoutedAppSessionId(ROUTE, `${"A".repeat(42)}B`))
      .toThrow("Invalid routed app session signature");
    expect(parseRoutedAppSessionId("x".repeat(257))).toBeNull();
  });
});

describe("AppRunner object names", () => {
  it("uses the single actor-and-package object", () => {
    expect(buildAppRunnerName(2000, "pkg-chat"))
      .toBe("app:2000:pkg-chat");
    expect(buildAppRunnerName(2000, "global:chat"))
      .toBe("app:2000:global:chat");
    expect(buildAppRunnerName(2000, "import:alice/weather:."))
      .toBe("app:2000:import:alice/weather:.");
  });

  it("isolates actors and packages", () => {
    expect(buildAppRunnerName(2000, "pkg-chat"))
      .not.toBe(buildAppRunnerName(2001, "pkg-chat"));
    expect(buildAppRunnerName(2000, "pkg-chat"))
      .not.toBe(buildAppRunnerName(2000, "pkg-admin"));
  });

  it("rejects ambiguous object identities", () => {
    expect(() => buildAppRunnerName(-1, "pkg-chat")).toThrow();
    expect(() => buildAppRunnerName(2000, " ")).toThrow();
  });
});
