import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it, vi } from "vitest";
import type { Kernel } from "./do";
import { LoginAttemptStore, type LoginAttemptPolicy } from "./login-attempts";
import type { LoginSourceScope } from "./login-source";

const SOURCE_A = `source:20000:${"a".repeat(64)}` as LoginSourceScope;
const SOURCE_B = `source:20000:${"b".repeat(64)}` as LoginSourceScope;

const TEST_POLICY: LoginAttemptPolicy = {
  windowMs: 60_000,
  targetBlockMs: 120_000,
  targetLimit: 2,
  globalPasswordLimit: 2,
  globalTokenLimit: 3,
  globalBlockMs: 60_000,
};

describe("LoginAttemptStore", () => {
  it("shares a hashed target budget across credential kinds and username casing", async () => {
    const kernel = await getAgentByName(env.KERNEL, crypto.randomUUID());

    await runInDurableObject(kernel, async (_instance: Kernel, state) => {
      const store = new LoginAttemptStore(state.storage.sql, {
        ...TEST_POLICY,
        globalPasswordLimit: 10,
        globalTokenLimit: 10,
      });
      const now = 1_000_000;
      const first = await store.reserve(" Alice ", "password", SOURCE_A, now);
      expect(first.allowed).toBe(true);
      if (first.allowed) store.complete(first, false, now);

      const second = await store.reserve("ALICE", "token", SOURCE_A, now + 1);
      expect(second.allowed).toBe(true);
      if (second.allowed) store.complete(second, false, now + 1);

      const blocked = await store.reserve("alice", "password", SOURCE_A, now + 2);
      expect(blocked.allowed).toBe(false);
      if (!blocked.allowed) expect(blocked.retryAfterMs).toBeGreaterThan(0);
      expect((await store.reserve("alice", "password", SOURCE_B, now + 2)).allowed)
        .toBe(true);

      const scopes = state.storage.sql.exec<{ scope: string }>(
        "SELECT scope FROM auth_login_attempts ORDER BY scope",
      ).toArray().map((row) => row.scope);
      expect(scopes).toContain(`work:${SOURCE_A}:password`);
      expect(scopes).toContain(`work:${SOURCE_A}:token`);
      expect(scopes.some((scope) => (
        new RegExp(`^target:${SOURCE_A}:[a-f0-9]{64}$`).test(scope)
      ))).toBe(true);
      expect(scopes.join(" ").toLowerCase()).not.toContain("alice");
    });
  });

  it("maps malformed and oversized names to one fixed scope without hashing them", async () => {
    const kernel = await getAgentByName(env.KERNEL, crypto.randomUUID());

    await runInDurableObject(kernel, async (_instance: Kernel, state) => {
      const store = new LoginAttemptStore(state.storage.sql, {
        ...TEST_POLICY,
        targetLimit: 10,
        globalPasswordLimit: 10,
      });
      const digest = vi.spyOn(crypto.subtle, "digest");
      const oversized = "a".repeat(1_000_000);

      expect((await store.reserve(oversized, "password", SOURCE_A, 1_500_000)).allowed).toBe(true);
      expect((await store.reserve("not valid!", "password", SOURCE_A, 1_500_001)).allowed).toBe(true);
      expect(digest).not.toHaveBeenCalled();
      digest.mockRestore();

      const targetScopes = state.storage.sql.exec<{ scope: string }>(
        "SELECT scope FROM auth_login_attempts WHERE scope LIKE 'target:%'",
      ).toArray().map((row) => row.scope);
      expect(targetScopes).toEqual([`target:${SOURCE_A}:invalid`]);
    });
  });

  it("isolates target and work ceilings between source pseudonyms", async () => {
    const kernel = await getAgentByName(env.KERNEL, crypto.randomUUID());

    await runInDurableObject(kernel, async (_instance: Kernel, state) => {
      const store = new LoginAttemptStore(state.storage.sql, TEST_POLICY);
      const now = 2_000_000;
      expect((await store.reserve("alice", "password", SOURCE_A, now)).allowed).toBe(true);
      expect((await store.reserve("bob", "password", SOURCE_A, now + 1)).allowed).toBe(true);

      const denied = await store.reserve("charlie", "password", SOURCE_A, now + 2);
      expect(denied.allowed).toBe(false);
      if (!denied.allowed) expect(denied.retryAfterMs).toBeGreaterThan(0);

      const reloaded = new LoginAttemptStore(state.storage.sql, TEST_POLICY);
      expect((await reloaded.reserve("dana", "password", SOURCE_A, now + 3)).allowed).toBe(false);
      expect((await reloaded.reserve("dana", "password", SOURCE_B, now + 3)).allowed).toBe(true);
    });
  });

  it("removes a successful provisional target attempt without erasing failures", async () => {
    const kernel = await getAgentByName(env.KERNEL, crypto.randomUUID());

    await runInDurableObject(kernel, async (_instance: Kernel, state) => {
      const store = new LoginAttemptStore(state.storage.sql, {
        ...TEST_POLICY,
        globalTokenLimit: 10,
      });
      const now = 3_000_000;
      const failed = await store.reserve("alice", "token", SOURCE_A, now);
      expect(failed.allowed).toBe(true);
      if (failed.allowed) store.complete(failed, false, now);

      const succeeded = await store.reserve("alice", "token", SOURCE_A, now + 1);
      expect(succeeded.allowed).toBe(true);
      if (succeeded.allowed) store.complete(succeeded, true, now + 1);

      const next = await store.reserve("alice", "token", SOURCE_A, now + 2);
      expect(next.allowed).toBe(true);
      if (next.allowed) store.complete(next, false, now + 2);

      expect((await store.reserve("alice", "token", SOURCE_A, now + 3)).allowed).toBe(false);
      expect((await store.reserve("alice", "token", SOURCE_B, now + 3)).allowed).toBe(true);
    });
  });

  it("releases both provisional target and source-work reservations on success", async () => {
    const kernel = await getAgentByName(env.KERNEL, crypto.randomUUID());

    await runInDurableObject(kernel, async (_instance: Kernel, state) => {
      const store = new LoginAttemptStore(state.storage.sql, {
        ...TEST_POLICY,
        targetLimit: 1,
        globalTokenLimit: 1,
      });
      const now = 4_000_000;
      const succeeded = await store.reserve("alice", "token", SOURCE_A, now);
      expect(succeeded.allowed).toBe(true);
      if (succeeded.allowed) store.complete(succeeded, true, now);

      expect(state.storage.sql.exec<{ scope: string }>(
        "SELECT scope FROM auth_login_attempts",
      ).toArray()).toEqual([]);
      expect((await store.reserve("bob", "token", SOURCE_A, now + 1)).allowed).toBe(true);
    });
  });
});
