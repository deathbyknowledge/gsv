import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it, vi } from "vitest";
import {
  AUTH_DUMMY_PASSWORD_HASH,
  AUTHENTICATION_FAILED_MESSAGE,
  AuthStore,
} from "./auth-store";
import { hashPassword, makeShadowEntry, verify } from "../auth/shadow";
import { LOGIN_TARGET_ATTEMPT_LIMIT } from "./login-attempts";
import { LOGIN_CREDENTIAL_MAX_CHARACTERS } from "../auth/login";
import type { Kernel } from "./do";
import { UNAVAILABLE_LOGIN_SOURCE_SCOPE } from "./login-source";

const GENERIC_AUTH_FAILURE = {
  ok: false,
  error: AUTHENTICATION_FAILED_MESSAGE,
};

describe("AuthStore Unix id allocation", () => {
  it("never reuses reservations across users and groups", async () => {
    const kernel = await getAgentByName(env.KERNEL, crypto.randomUUID());

    await runInDurableObject(kernel, async (_instance: Kernel, state) => {
      const auth = new AuthStore(state.storage.sql);
      await auth.bootstrap();

      const userId = auth.allocateUid();
      expect(userId).toBe(1000);
      auth.addUser({
        username: "alice",
        uid: userId,
        gid: userId,
        gecos: "",
        home: "/home/alice",
        shell: "/bin/init",
      });
      auth.addGroup({ name: "alice", gid: userId, members: [] });

      const groupId = auth.allocateGid();
      expect(groupId).toBe(1001);
      auth.addGroup({ name: "temporary", gid: groupId, members: [] });
      expect(auth.removeGroup("temporary")).toBe(true);

      expect(auth.allocateUid()).toBe(1002);
    });
  });

  it("advances past ids introduced by root-authored account data", async () => {
    const kernel = await getAgentByName(env.KERNEL, crypto.randomUUID());

    await runInDurableObject(kernel, async (_instance: Kernel, state) => {
      const auth = new AuthStore(state.storage.sql);
      await auth.bootstrap();

      auth.addUser({
        username: "imported",
        uid: 7000,
        gid: 9000,
        gecos: "",
        home: "/home/imported",
        shell: "/bin/init",
      });
      expect(auth.removeUser("imported")).toBe(true);

      expect(auth.allocateGid()).toBe(9001);
    });
  });

  it("burns an allocated id even when no passwd or group row is created", async () => {
    const kernel = await getAgentByName(env.KERNEL, crypto.randomUUID());

    await runInDurableObject(kernel, async (_instance: Kernel, state) => {
      const auth = new AuthStore(state.storage.sql);
      await auth.bootstrap();

      expect(auth.allocateUid()).toBe(1000);
      expect(auth.allocateUid()).toBe(1001);
    });
  });
});

describe("AuthStore authentication boundary", () => {
  it("uses one password failure shape and PBKDF2 work for absent credential state", async () => {
    const kernel = await getAgentByName(env.KERNEL, crypto.randomUUID());

    await runInDurableObject(kernel, async (_instance: Kernel, state) => {
      const auth = new AuthStore(state.storage.sql);
      await auth.bootstrap();
      await auth.setPassword("root", await hashPassword("correct-password"));
      auth.addUser({
        username: "missing-shadow",
        uid: 4000,
        gid: 4000,
        gecos: "",
        home: "/home/missing-shadow",
        shell: "/bin/init",
      });
      auth.addUser({
        username: "locked-user",
        uid: 4001,
        gid: 4001,
        gecos: "",
        home: "/home/locked-user",
        shell: "/bin/init",
      });
      auth.setShadow(makeShadowEntry("locked-user", "!"));

      const deriveBits = vi.spyOn(crypto.subtle, "deriveBits");
      const wrong = await auth.authenticate("root", "wrong-password", UNAVAILABLE_LOGIN_SOURCE_SCOPE);
      const unknown = await auth.authenticate("unknown-user", "wrong-password", UNAVAILABLE_LOGIN_SOURCE_SCOPE);
      const missing = await auth.authenticate("missing-shadow", "wrong-password", UNAVAILABLE_LOGIN_SOURCE_SCOPE);
      const locked = await auth.authenticate("locked-user", "wrong-password", UNAVAILABLE_LOGIN_SOURCE_SCOPE);

      expect(wrong).toEqual(GENERIC_AUTH_FAILURE);
      expect(unknown).toEqual(GENERIC_AUTH_FAILURE);
      expect(missing).toEqual(GENERIC_AUTH_FAILURE);
      expect(locked).toEqual(GENERIC_AUTH_FAILURE);
      expect(deriveBits).toHaveBeenCalledTimes(4);
      deriveBits.mockRestore();

      // The fallback is a valid work-factor record, not a fast invalid-hash path.
      await expect(
        verify("any-password", AUTH_DUMMY_PASSWORD_HASH),
      ).resolves.toBe(false);
    });
  });

  it("uses one token failure shape for unknown, wrong, revoked, and role-bound tokens", async () => {
    const kernel = await getAgentByName(env.KERNEL, crypto.randomUUID());

    await runInDurableObject(kernel, async (_instance: Kernel, state) => {
      const auth = new AuthStore(state.storage.sql);
      await auth.bootstrap();
      const revoked = await auth.issueToken({ uid: 0, kind: "user" });
      const expired = await auth.issueToken({
        uid: 0,
        kind: "user",
        expiresAt: Date.now() - 1,
      });
      const driver = await auth.issueToken({
        uid: 0,
        kind: "node",
        allowedDeviceId: "laptop",
      });
      expect(auth.revokeToken(revoked.tokenId)).toBe(true);

      expect(await auth.authenticateToken("unknown-user", "wrong-token", UNAVAILABLE_LOGIN_SOURCE_SCOPE))
        .toEqual(GENERIC_AUTH_FAILURE);
      expect(await auth.authenticateToken("root", "wrong-token", UNAVAILABLE_LOGIN_SOURCE_SCOPE))
        .toEqual(GENERIC_AUTH_FAILURE);
      expect(await auth.authenticateToken("root", revoked.token, UNAVAILABLE_LOGIN_SOURCE_SCOPE, { role: "user" }))
        .toEqual(GENERIC_AUTH_FAILURE);
      expect(await auth.authenticateToken("root", expired.token, UNAVAILABLE_LOGIN_SOURCE_SCOPE, { role: "user" }))
        .toEqual(GENERIC_AUTH_FAILURE);
      expect(await auth.authenticateToken("root", driver.token, UNAVAILABLE_LOGIN_SOURCE_SCOPE, {
        role: "driver",
        deviceId: "other-device",
      })).toEqual(GENERIC_AUTH_FAILURE);
    });
  });

  it("canonicalizes bounded login names and bounds password and token work input", async () => {
    const kernel = await getAgentByName(env.KERNEL, crypto.randomUUID());

    await runInDurableObject(kernel, async (_instance: Kernel, state) => {
      const auth = new AuthStore(state.storage.sql);
      await auth.bootstrap();
      await auth.setPassword("root", await hashPassword("correct-password"));

      await expect(auth.authenticate(" ROOT ", "correct-password", UNAVAILABLE_LOGIN_SOURCE_SCOPE))
        .resolves.toMatchObject({ ok: true, identity: { username: "root" } });

      const deriveBits = vi.spyOn(crypto.subtle, "deriveBits");
      const oversized = "x".repeat(LOGIN_CREDENTIAL_MAX_CHARACTERS + 1);
      await expect(auth.authenticate("root", oversized, UNAVAILABLE_LOGIN_SOURCE_SCOPE))
        .resolves.toEqual(GENERIC_AUTH_FAILURE);
      const oversizedBytes = "€".repeat(700);
      expect(oversizedBytes.length).toBeLessThan(LOGIN_CREDENTIAL_MAX_CHARACTERS);
      await expect(auth.authenticate("root", oversizedBytes, UNAVAILABLE_LOGIN_SOURCE_SCOPE))
        .resolves.toEqual(GENERIC_AUTH_FAILURE);
      expect(deriveBits).toHaveBeenCalledTimes(2);
      deriveBits.mockRestore();

      const digest = vi.spyOn(crypto.subtle, "digest");
      await expect(auth.authenticateToken("root", oversized, UNAVAILABLE_LOGIN_SOURCE_SCOPE, { role: "user" }))
        .resolves.toEqual(GENERIC_AUTH_FAILURE);
      expect(digest).toHaveBeenCalledTimes(2);
      for (const call of digest.mock.calls) {
        const input = call[1] as ArrayBuffer | ArrayBufferView;
        expect(input.byteLength).toBeLessThan(256);
      }
      digest.mockRestore();
    });
  });

  it("does bounded dummy PBKDF2 work for oversized names and corrupt password records", async () => {
    const kernel = await getAgentByName(env.KERNEL, crypto.randomUUID());

    await runInDurableObject(kernel, async (_instance: Kernel, state) => {
      const auth = new AuthStore(state.storage.sql);
      await auth.bootstrap();
      const deriveBits = vi.spyOn(crypto.subtle, "deriveBits");

      await expect(auth.authenticate("a".repeat(1_000_000), "password", UNAVAILABLE_LOGIN_SOURCE_SCOPE))
        .resolves.toEqual(GENERIC_AUTH_FAILURE);
      expect(deriveBits).toHaveBeenCalledTimes(1);

      auth.setShadow(makeShadowEntry(
        "root",
        `$pbkdf2-sha512$999999999$${"A".repeat(24)}$${"A".repeat(88)}`,
      ));
      await expect(auth.authenticate("root", "password", UNAVAILABLE_LOGIN_SOURCE_SCOPE))
        .resolves.toEqual(GENERIC_AUTH_FAILURE);
      expect(deriveBits).toHaveBeenCalledTimes(2);
      deriveBits.mockRestore();
    });
  });

  it("persists a target lockout across AuthStore instances and keeps its error generic", async () => {
    const kernel = await getAgentByName(env.KERNEL, crypto.randomUUID());
    const validToken = await runInDurableObject(kernel, async (_instance: Kernel, state) => {
      const auth = new AuthStore(state.storage.sql);
      await auth.bootstrap();
      const issued = await auth.issueToken({ uid: 0, kind: "user" });

      const attempts = await Promise.all(
        Array.from(
          { length: LOGIN_TARGET_ATTEMPT_LIMIT + 2 },
          () => auth.authenticateToken("root", "wrong-token", UNAVAILABLE_LOGIN_SOURCE_SCOPE, { role: "user" }),
        ),
      );
      expect(attempts.every((attempt) => (
        !attempt.ok && attempt.error === AUTHENTICATION_FAILED_MESSAGE
      ))).toBe(true);
      expect(attempts.filter((attempt) => !attempt.ok && attempt.retryAfterMs).length).toBe(2);
      return issued.token;
    });

    await runInDurableObject(kernel, async (_instance: Kernel, state) => {
      const reloadedAuth = new AuthStore(state.storage.sql);
      const result = await reloadedAuth.authenticateToken(
        "root",
        validToken,
        UNAVAILABLE_LOGIN_SOURCE_SCOPE,
        { role: "user" },
      );
      expect(result).toMatchObject(GENERIC_AUTH_FAILURE);
      expect(result.ok ? undefined : result.retryAfterMs).toBeGreaterThan(0);
    });
  });

  it("accepts either Git password or user token under one limiter reservation", async () => {
    const kernel = await getAgentByName(env.KERNEL, crypto.randomUUID());

    await runInDurableObject(kernel, async (_instance: Kernel, state) => {
      const auth = new AuthStore(state.storage.sql);
      await auth.bootstrap();
      await auth.setPassword("root", await hashPassword("correct-password"));
      const issued = await auth.issueToken({ uid: 0, kind: "user" });

      await expect(
        auth.authenticatePasswordOrToken("root", "correct-password", UNAVAILABLE_LOGIN_SOURCE_SCOPE),
      ).resolves.toMatchObject({ ok: true, identity: { uid: 0 } });
      await expect(
        auth.authenticatePasswordOrToken("root", issued.token, UNAVAILABLE_LOGIN_SOURCE_SCOPE),
      ).resolves.toMatchObject({ ok: true, identity: { uid: 0 } });
      await expect(
        auth.authenticatePasswordOrToken("unknown-user", "wrong-credential", UNAVAILABLE_LOGIN_SOURCE_SCOPE),
      ).resolves.toEqual(GENERIC_AUTH_FAILURE);
    });
  });
});
