import { describe, expect, it } from "vitest";
import {
  buildAgentSessionKey,
  canonicalizeSessionKey,
  isMainSessionKey,
  parseSessionKey,
  resolveAgentIdFromSessionKey,
  resolveAgentMainSessionKey,
} from "./routing";

describe("session routing", () => {
  it("resolves canonical agent main session key", () => {
    expect(
      resolveAgentMainSessionKey({ agentId: "Ops", mainKey: "Primary" }),
    ).toBe("agent:ops:primary");
  });

  it("extracts agent id from session key", () => {
    expect(resolveAgentIdFromSessionKey("agent:work:main")).toBe("work");
    expect(resolveAgentIdFromSessionKey("main", "ops")).toBe("ops");
  });

  describe("parseSessionKey", () => {
    it("parses per-channel-peer DM keys", () => {
      expect(parseSessionKey("agent:main:whatsapp:dm:+12345")).toEqual({
        agentId: "main",
        channel: "whatsapp",
        peer: { kind: "dm", id: "+12345" },
      });
    });

    it("parses per-peer DM keys", () => {
      expect(parseSessionKey("agent:main:dm:+12345")).toEqual({
        agentId: "main",
        peer: { kind: "dm", id: "+12345" },
      });
    });

    it("parses per-account-channel-peer DM keys", () => {
      expect(parseSessionKey("agent:main:whatsapp:phone-1:dm:+12345")).toEqual({
        agentId: "main",
        channel: "whatsapp",
        accountId: "phone-1",
        peer: { kind: "dm", id: "+12345" },
      });
    });

    it("parses non-DM group keys", () => {
      expect(parseSessionKey("agent:main:whatsapp:group:my-group")).toEqual({
        agentId: "main",
        channel: "whatsapp",
        peer: { kind: "group", id: "my-group" },
      });
    });

    it("returns null for simple aliases and 3-part keys", () => {
      expect(parseSessionKey("main")).toBeNull();
      expect(parseSessionKey("agent:main:main")).toBeNull();
      expect(parseSessionKey("agent:ops:primary")).toBeNull();
    });
  });

  describe("buildAgentSessionKey", () => {
    it("maps DMs to canonical main when dmScope is main", () => {
      expect(
        buildAgentSessionKey({
          agentId: "main",
          channel: "whatsapp",
          accountId: "default",
          peer: { kind: "dm", id: "+12345" },
          dmScope: "main",
          mainKey: "main",
        }),
      ).toBe("agent:main:main");
    });

    it("supports per-account-channel-peer DM scope", () => {
      expect(
        buildAgentSessionKey({
          agentId: "main",
          channel: "whatsapp",
          accountId: "phone-1",
          peer: { kind: "dm", id: "+12345" },
          dmScope: "per-account-channel-peer",
          mainKey: "main",
        }),
      ).toBe("agent:main:whatsapp:phone-1:dm:+12345");
    });
  });

  describe("canonicalizeSessionKey", () => {
    it("canonicalizes simple aliases", () => {
      expect(
        canonicalizeSessionKey("main", { mainKey: "primary", defaultAgentId: "main" }),
      ).toBe("agent:main:primary");
    });

    it("canonicalizes 3-part main key aliases", () => {
      expect(
        canonicalizeSessionKey("agent:main:main", { mainKey: "primary" }),
      ).toBe("agent:main:primary");
    });

    it("collapses DM keys to main when dmScope is main", () => {
      expect(
        canonicalizeSessionKey("agent:main:cli:dm:main", {
          mainKey: "main",
          dmScope: "main",
        }),
      ).toBe("agent:main:main");

      expect(
        canonicalizeSessionKey("agent:main:whatsapp:dm:+12345", {
          mainKey: "main",
          dmScope: "main",
        }),
      ).toBe("agent:main:main");

      expect(
        canonicalizeSessionKey("agent:main:dm:+12345", {
          mainKey: "main",
          dmScope: "main",
        }),
      ).toBe("agent:main:main");
    });

    it("preserves DM keys when dmScope is not main", () => {
      expect(
        canonicalizeSessionKey("agent:main:whatsapp:dm:+12345", {
          mainKey: "main",
          dmScope: "per-channel-peer",
        }),
      ).toBe("agent:main:whatsapp:dm:+12345");
    });

    it("leaves non-agent keys unchanged", () => {
      expect(
        canonicalizeSessionKey("custom-key", { mainKey: "main" }),
      ).toBe("custom-key");
    });
  });

  describe("isMainSessionKey", () => {
    it("treats canonical main key as main", () => {
      expect(
        isMainSessionKey({
          sessionKey: "agent:main:primary",
          mainKey: "primary",
          dmScope: "main",
        }),
      ).toBe(true);
    });

    it("treats DM keys as main when dmScope is main", () => {
      expect(
        isMainSessionKey({
          sessionKey: "agent:main:whatsapp:dm:+12345",
          mainKey: "primary",
          dmScope: "main",
        }),
      ).toBe(true);

      expect(
        isMainSessionKey({
          sessionKey: "agent:main:cli:dm:main",
          mainKey: "main",
          dmScope: "main",
        }),
      ).toBe(true);
    });

    it("does not treat DM keys as main when dmScope scopes per peer", () => {
      expect(
        isMainSessionKey({
          sessionKey: "agent:main:whatsapp:dm:+12345",
          mainKey: "primary",
          dmScope: "per-channel-peer",
        }),
      ).toBe(false);
    });
  });
});
