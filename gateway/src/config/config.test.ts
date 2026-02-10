import { describe, it, expect } from "vitest";
import {
  normalizeE164,
  isAllowedSender,
  resolveLinkedIdentity,
} from "./parsing";
import { mergeConfig, type GsvConfig } from ".";
import { DEFAULT_CONFIG } from "./defaults";

describe("normalizeE164", () => {
  it("handles E.164 format with plus", () => {
    expect(normalizeE164("+31628552611")).toBe("+31628552611");
  });

  it("handles digits only (adds plus)", () => {
    expect(normalizeE164("31628552611")).toBe("+31628552611");
  });

  it("handles WhatsApp JID format", () => {
    expect(normalizeE164("31628552611@s.whatsapp.net")).toBe("+31628552611");
  });

  it("handles WhatsApp JID with device suffix", () => {
    expect(normalizeE164("31628552611:0@s.whatsapp.net")).toBe("+31628552611");
  });

  it("handles @c.us JID format", () => {
    expect(normalizeE164("31628552611@c.us")).toBe("+31628552611");
  });

  it("handles LID format (strips to digits)", () => {
    // LID JIDs like "55156188147823@lid" - we just extract the digits
    // Note: LID numbers aren't real phone numbers, but we normalize them anyway
    expect(normalizeE164("55156188147823@lid")).toBe("+55156188147823");
  });

  it("returns empty string for empty input", () => {
    expect(normalizeE164("")).toBe("");
  });

  it("strips non-digit characters", () => {
    expect(normalizeE164("+31 (6) 28-55-2611")).toBe("+31628552611");
  });
});

describe("isAllowedSender", () => {
  const baseConfig: GsvConfig = {
    ...DEFAULT_CONFIG,
    channels: {
      whatsapp: {
        dmPolicy: "allowlist",
        allowFrom: ["+31628552611"],
      },
    },
  };

  describe("allowlist policy", () => {
    it("allows sender in allowlist", () => {
      const result = isAllowedSender(baseConfig, "whatsapp", "+31628552611");
      expect(result.allowed).toBe(true);
    });

    it("blocks sender not in allowlist", () => {
      const result = isAllowedSender(baseConfig, "whatsapp", "+1234567890");
      expect(result.allowed).toBe(false);
      expect(result.needsPairing).toBeUndefined();
    });

    it("normalizes sender ID for comparison", () => {
      const result = isAllowedSender(
        baseConfig,
        "whatsapp",
        "31628552611@s.whatsapp.net",
      );
      expect(result.allowed).toBe(true);
    });

    it("allows wildcard", () => {
      const config: GsvConfig = {
        ...baseConfig,
        channels: {
          whatsapp: {
            dmPolicy: "allowlist",
            allowFrom: ["*"],
          },
        },
      };
      const result = isAllowedSender(config, "whatsapp", "+9999999999");
      expect(result.allowed).toBe(true);
    });
  });

  describe("pairing policy", () => {
    const pairingConfig: GsvConfig = {
      ...baseConfig,
      channels: {
        whatsapp: {
          dmPolicy: "pairing",
          allowFrom: ["+31628552611"],
        },
      },
    };

    it("allows sender in allowlist", () => {
      const result = isAllowedSender(pairingConfig, "whatsapp", "+31628552611");
      expect(result.allowed).toBe(true);
    });

    it("marks unknown sender as needing pairing", () => {
      const result = isAllowedSender(pairingConfig, "whatsapp", "+1234567890");
      expect(result.allowed).toBe(false);
      expect(result.needsPairing).toBe(true);
    });
  });

  describe("open policy", () => {
    const openConfig: GsvConfig = {
      ...baseConfig,
      channels: {
        whatsapp: {
          dmPolicy: "open",
          allowFrom: [],
        },
      },
    };

    it("allows any sender", () => {
      const result = isAllowedSender(openConfig, "whatsapp", "+9999999999");
      expect(result.allowed).toBe(true);
    });
  });

  describe("non-whatsapp channels", () => {
    it("allows all senders for non-whatsapp channels", () => {
      const result = isAllowedSender(baseConfig, "telegram", "+9999999999");
      expect(result.allowed).toBe(true);
    });
  });
});

describe("resolveLinkedIdentity", () => {
  const configWithLinks: GsvConfig = {
    ...DEFAULT_CONFIG,
    session: {
      identityLinks: {
        steve: ["+31628552611", "telegram:123456789", "whatsapp:+34675706329"],
        alice: ["+1555123456"],
      },
    },
  };

  it("returns null when no identity links configured", () => {
    const result = resolveLinkedIdentity(
      DEFAULT_CONFIG,
      "whatsapp",
      "+31628552611",
    );
    expect(result).toBeNull();
  });

  it("matches phone number without channel prefix", () => {
    const result = resolveLinkedIdentity(
      configWithLinks,
      "whatsapp",
      "+31628552611",
    );
    expect(result).toBe("steve");
  });

  it("matches phone number in WhatsApp JID format", () => {
    const result = resolveLinkedIdentity(
      configWithLinks,
      "whatsapp",
      "31628552611@s.whatsapp.net",
    );
    expect(result).toBe("steve");
  });

  it("matches channel-prefixed identity", () => {
    const result = resolveLinkedIdentity(
      configWithLinks,
      "telegram",
      "123456789",
    );
    expect(result).toBe("steve");
  });

  it("matches channel-prefixed identity with phone number", () => {
    // whatsapp:+34675706329 should only match whatsapp channel
    const result = resolveLinkedIdentity(
      configWithLinks,
      "whatsapp",
      "+34675706329",
    );
    expect(result).toBe("steve");
  });

  it("does not match channel-prefixed identity on wrong channel", () => {
    // telegram:123456789 should not match on whatsapp channel
    const result = resolveLinkedIdentity(
      configWithLinks,
      "whatsapp",
      "123456789",
    );
    expect(result).toBeNull();
  });

  it("returns null for unknown identity", () => {
    const result = resolveLinkedIdentity(
      configWithLinks,
      "whatsapp",
      "+9999999999",
    );
    expect(result).toBeNull();
  });

  it("matches different users", () => {
    const result = resolveLinkedIdentity(
      configWithLinks,
      "whatsapp",
      "+1555123456",
    );
    expect(result).toBe("alice");
  });

  it("is case-insensitive for channel names", () => {
    const result = resolveLinkedIdentity(
      configWithLinks,
      "TELEGRAM",
      "123456789",
    );
    expect(result).toBe("steve");
  });
});

describe("skills config", () => {
  it("has an empty skills entries map by default", () => {
    expect(DEFAULT_CONFIG.skills.entries).toEqual({});
  });

  it("merges skills.entries overrides", () => {
    const merged = mergeConfig(DEFAULT_CONFIG, {
      skills: {
        entries: {
          "search-skill": {
            enabled: false,
            requires: {
              hostRoles: ["execution"],
              capabilities: ["shell.exec"],
            },
          },
        },
      },
    });

    expect(merged.skills.entries["search-skill"]?.enabled).toBe(false);
    expect(merged.skills.entries["search-skill"]?.requires?.hostRoles).toEqual([
      "execution",
    ]);
    expect(
      merged.skills.entries["search-skill"]?.requires?.capabilities,
    ).toEqual(["shell.exec"]);
  });
});
