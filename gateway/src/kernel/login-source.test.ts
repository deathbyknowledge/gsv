import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it, vi } from "vitest";
import { ConfigStore } from "./config";
import type { Kernel } from "./do";
import {
  deriveLoginSourceScope,
  UNAVAILABLE_LOGIN_SOURCE_SCOPE,
} from "./login-source";

describe("login source pseudonyms", () => {
  it("uses a stable ship secret and rotates pseudonyms at the UTC-day boundary", async () => {
    const kernel = await getAgentByName(env.KERNEL, crypto.randomUUID());

    await runInDurableObject(kernel, async (_instance: Kernel, state) => {
      const day = 20_000 * 24 * 60 * 60 * 1000;
      const firstConfig = new ConfigStore(state.storage.sql);
      const first = await deriveLoginSourceScope(firstConfig, "203.0.113.9", day);
      const sameDay = await deriveLoginSourceScope(
        new ConfigStore(state.storage.sql),
        "203.0.113.9",
        day + 1_000,
      );
      const nextDay = await deriveLoginSourceScope(
        new ConfigStore(state.storage.sql),
        "203.0.113.9",
        day + 24 * 60 * 60 * 1000,
      );
      const otherSource = await deriveLoginSourceScope(
        new ConfigStore(state.storage.sql),
        "203.0.113.10",
        day,
      );

      expect(first).toMatch(/^source:20000:[a-f0-9]{64}$/);
      expect(sameDay).toBe(first);
      expect(nextDay).toMatch(/^source:20001:[a-f0-9]{64}$/);
      expect(nextDay).not.toBe(first);
      expect(otherSource).not.toBe(first);

      const rows = state.storage.sql.exec<{ key: string; value: string }>(
        "SELECT key, value FROM config_kv WHERE key = 'internal/auth/login_source_secret'",
      ).toArray();
      expect(rows).toEqual([{
        key: "internal/auth/login_source_secret",
        value: expect.stringMatching(/^[a-f0-9]{64}$/),
      }]);
      expect(JSON.stringify(rows)).not.toContain("203.0.113.9");
    });
  });

  it("maps absent, malformed, and oversized headers to one fixed scope", async () => {
    const kernel = await getAgentByName(env.KERNEL, crypto.randomUUID());

    await runInDurableObject(kernel, async (_instance: Kernel, state) => {
      const config = new ConfigStore(state.storage.sql);
      const sign = vi.spyOn(crypto.subtle, "sign");

      await expect(deriveLoginSourceScope(config, undefined))
        .resolves.toBe(UNAVAILABLE_LOGIN_SOURCE_SCOPE);
      await expect(deriveLoginSourceScope(config, "not-an-ip"))
        .resolves.toBe(UNAVAILABLE_LOGIN_SOURCE_SCOPE);
      await expect(deriveLoginSourceScope(config, "1".repeat(65)))
        .resolves.toBe(UNAVAILABLE_LOGIN_SOURCE_SCOPE);
      await expect(deriveLoginSourceScope(config, "2001:db8::1"))
        .resolves.toMatch(/^source:\d+:[a-f0-9]{64}$/);

      expect(sign).toHaveBeenCalledTimes(1);
      sign.mockRestore();
    });
  });
});
