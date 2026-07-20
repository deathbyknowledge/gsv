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
    const state = buildRoutedOAuthState("alice", 7, FLOW_ID, OPAQUE_TOKEN);

    expect(parseRoutedOAuthState(state)).toEqual({
      username: "alice",
      generation: 7,
      flowId: FLOW_ID,
    });
    expect(parseRoutedOAuthState(state)).not.toHaveProperty("opaqueToken");
  });

  it("leaves a legacy opaque state unrouted", () => {
    expect(parseRoutedOAuthState(OPAQUE_TOKEN)).toBeNull();
  });

  it("rejects username and generation fields swapped into each other's position", () => {
    expect(
      parseRoutedOAuthState(`gsv1o~7~alice~${FLOW_ID}~${OPAQUE_TOKEN}`),
    ).toBeNull();
  });

  it("rejects non-canonical usernames and invalid generations", () => {
    expect(() => buildRoutedOAuthState("Alice", 7, FLOW_ID, OPAQUE_TOKEN)).toThrow(
      "Invalid routed OAuth state",
    );
    expect(() => buildRoutedOAuthState("alice", 0, FLOW_ID, OPAQUE_TOKEN)).toThrow(
      "Invalid routed OAuth state",
    );
    expect(
      parseRoutedOAuthState(`gsv1o~Alice~7~${FLOW_ID}~${OPAQUE_TOKEN}`),
    ).toBeNull();
  });
});

describe("MCP OAuth callback paths", () => {
  it("round-trips the active username and generation", () => {
    const path = buildUserMcpOAuthCallbackPath("alice", 7);

    expect(path).toBe("/oauth/callback/alice/7");
    expect(matchUserMcpOAuthCallbackPath(path)).toEqual({
      username: "alice",
      generation: 7,
    });
  });

  it("rejects swapped username and generation path segments", () => {
    expect(matchUserMcpOAuthCallbackPath("/oauth/callback/7/alice")).toBeNull();
  });
});
