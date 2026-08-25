import { describe, expect, it } from "vitest";
import {
  buildRoutedOAuthState,
  buildUserMcpOAuthCallbackPath,
  matchUserMcpOAuthCallbackPath,
  parseRoutedOAuthState,
} from "./callback-routes";

const FLOW_ID = "01234567-89ab-4def-8123-456789abcdef";
const OPAQUE_TOKEN = "abcdefghijklmnopqrstuvwxyz_ABCDEF";

describe("OAuth callback route state", () => {
  it("round-trips an active user Kernel locator without exposing the opaque token", () => {
    const state = buildRoutedOAuthState("alice", FLOW_ID, OPAQUE_TOKEN);

    expect(parseRoutedOAuthState(state)).toEqual({
      username: "alice",
      flowId: FLOW_ID,
    });
    expect(parseRoutedOAuthState(state)).not.toHaveProperty("opaqueToken");
  });

  it("leaves an opaque state unrouted", () => {
    expect(parseRoutedOAuthState(OPAQUE_TOKEN)).toBeNull();
  });

  it("rejects fields in the wrong positions", () => {
    expect(
      parseRoutedOAuthState(`gsv1o~${FLOW_ID}~alice~${OPAQUE_TOKEN}`),
    ).toBeNull();
  });

  it("rejects non-canonical usernames", () => {
    expect(() => buildRoutedOAuthState("Alice", FLOW_ID, OPAQUE_TOKEN)).toThrow(
      "Invalid routed OAuth state",
    );
    expect(
      parseRoutedOAuthState(`gsv1o~Alice~${FLOW_ID}~${OPAQUE_TOKEN}`),
    ).toBeNull();
  });
});

describe("MCP OAuth callback paths", () => {
  it("round-trips the active username", () => {
    const path = buildUserMcpOAuthCallbackPath("alice");

    expect(path).toBe("/oauth/callback/alice");
    expect(matchUserMcpOAuthCallbackPath(path)).toEqual({
      username: "alice",
    });
  });

  it("rejects extra path segments", () => {
    expect(matchUserMcpOAuthCallbackPath("/oauth/callback/alice/extra")).toBeNull();
  });
});
