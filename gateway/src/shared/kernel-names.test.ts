import { describe, expect, it } from "vitest";
import {
  matchUserKernelWebSocketPath,
  userKernelName,
  userKernelUsername,
} from "./kernel-names";

describe("user Kernel names", () => {
  it("maps canonical public usernames directly to stable Durable Object names", () => {
    expect(userKernelName(" Alice ")).toBe("user:alice");
    expect(userKernelUsername("user:alice")).toBe("alice");
    expect(userKernelUsername("user:Alice")).toBeNull();
  });

  it("decodes a routed username exactly once", () => {
    expect(matchUserKernelWebSocketPath("/ws/Alice")).toBe("alice");
    expect(matchUserKernelWebSocketPath("/ws/%41lice")).toBe("alice");
    expect(matchUserKernelWebSocketPath("/ws/%2541lice")).toBeNull();
    expect(matchUserKernelWebSocketPath("/ws/alice%2Fadmin")).toBeNull();
  });

  it("rejects Unicode aliases and trailing path data", () => {
    expect(matchUserKernelWebSocketPath("/ws/%E2%84%AAate")).toBeNull();
    expect(matchUserKernelWebSocketPath("/ws/alice/")).toBeNull();
    expect(matchUserKernelWebSocketPath("/ws/")).toBeNull();
  });
});
