import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it, vi } from "vitest";
import {
  AUTH_DUMMY_PASSWORD_HASH,
  AUTHENTICATION_FAILED_MESSAGE,
  AuthStore,
} from "./auth-store";
import { hashPassword, isLocked, makeShadowEntry, verify } from "../auth/shadow";
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
      }, "human");
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
      }, "human");
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
  it("returns only non-secret credential provenance on successful authentication", async () => {
    const kernel = await getAgentByName(env.KERNEL, crypto.randomUUID());

    await runInDurableObject(kernel, async (_instance: Kernel, state) => {
      const auth = new AuthStore(state.storage.sql);
      await auth.bootstrap();
      await auth.setPassword("root", await hashPassword("correct-password"));
      const expiresAt = Date.now() + 60_000;
      const issued = await auth.issueToken({ uid: 0, kind: "user", expiresAt });

      await expect(auth.authenticate(
        "root",
        "correct-password",
        UNAVAILABLE_LOGIN_SOURCE_SCOPE,
      )).resolves.toMatchObject({
        ok: true,
        credential: { kind: "password" },
      });
      await expect(auth.authenticateToken(
        "root",
        issued.token,
        UNAVAILABLE_LOGIN_SOURCE_SCOPE,
        { role: "user" },
      )).resolves.toMatchObject({
        ok: true,
        credential: {
          kind: "token",
          tokenId: issued.tokenId,
          expiresAt,
        },
      });
    });
  });

  it("rejects a password result when the authoritative hash changes during verification", async () => {
    const kernel = await getAgentByName(env.KERNEL, crypto.randomUUID());

    await runInDurableObject(kernel, async (_instance: Kernel, state) => {
      const auth = new AuthStore(state.storage.sql);
      await auth.bootstrap();
      const originalHash = await hashPassword("original-password");
      const replacementHash = await hashPassword("replacement-password");
      await auth.setPassword("root", originalHash);

      const realDeriveBits = crypto.subtle.deriveBits.bind(crypto.subtle);
      let entered!: () => void;
      const verificationEntered = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let release!: () => void;
      const verificationGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const deriveBits = vi.spyOn(crypto.subtle, "deriveBits").mockImplementation(async (
        ...args: Parameters<SubtleCrypto["deriveBits"]>
      ) => {
        entered();
        await verificationGate;
        return realDeriveBits(...args);
      });

      try {
        const pending = auth.authenticate(
          "root",
          "original-password",
          UNAVAILABLE_LOGIN_SOURCE_SCOPE,
        );
        await verificationEntered;
        auth.setShadow(makeShadowEntry("root", replacementHash));
        release();
        await expect(pending).resolves.toEqual(GENERIC_AUTH_FAILURE);
      } finally {
        release();
        deriveBits.mockRestore();
      }
    });
  });

  it("returns the current account identity after token hashing yields", async () => {
    const kernel = await getAgentByName(env.KERNEL, crypto.randomUUID());

    await runInDurableObject(kernel, async (_instance: Kernel, state) => {
      const auth = new AuthStore(state.storage.sql);
      await auth.bootstrap();
      const issued = await auth.issueToken({ uid: 0, kind: "user" });

      const realDigest = crypto.subtle.digest.bind(crypto.subtle);
      let digestCalls = 0;
      let entered!: () => void;
      const tokenHashEntered = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let release!: () => void;
      const tokenHashGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const digest = vi.spyOn(crypto.subtle, "digest").mockImplementation(async (
        ...args: Parameters<SubtleCrypto["digest"]>
      ) => {
        digestCalls += 1;
        if (digestCalls === 2) {
          entered();
          await tokenHashGate;
        }
        return realDigest(...args);
      });

      try {
        const pending = auth.authenticateToken(
          "root",
          issued.token,
          UNAVAILABLE_LOGIN_SOURCE_SCOPE,
          { role: "user" },
        );
        await tokenHashEntered;
        expect(auth.updateUser("root", { gid: 1234, home: "/root-current" })).toBe(true);
        release();
        await expect(pending).resolves.toMatchObject({
          ok: true,
          identity: {
            uid: 0,
            gid: 1234,
            home: "/root-current",
            gids: expect.arrayContaining([1234]),
          },
        });
      } finally {
        release();
        digest.mockRestore();
      }
    });
  });

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
      }, "human");
      auth.addUser({
        username: "locked-user",
        uid: 4001,
        gid: 4001,
        gecos: "",
        home: "/home/locked-user",
        shell: "/bin/init",
      }, "human");
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

  it("denies interactive password and historical user-token auth for agents", async () => {
    const kernel = await getAgentByName(env.KERNEL, crypto.randomUUID());

    await runInDurableObject(kernel, async (_instance: Kernel, state) => {
      const auth = new AuthStore(state.storage.sql);
      await auth.bootstrap();
      auth.addUser({
        username: "scout",
        uid: 1000,
        gid: 1000,
        gecos: "Scout",
        home: "/home/scout",
        shell: "/bin/init",
      }, "agent");
      auth.setShadow(makeShadowEntry(
        "scout",
        await hashPassword("misconfigured-agent-password"),
      ));
      // Emulate a user token minted before account-kind checks were enforced.
      const historical = await auth.issueToken({ uid: 1000, kind: "user" });
      const deriveBits = vi.spyOn(crypto.subtle, "deriveBits");

      await expect(auth.authenticate(
        "scout",
        "misconfigured-agent-password",
        UNAVAILABLE_LOGIN_SOURCE_SCOPE,
      )).resolves.toEqual(GENERIC_AUTH_FAILURE);
      expect(deriveBits).toHaveBeenCalledTimes(1);
      await expect(auth.authenticateToken(
        "scout",
        historical.token,
        UNAVAILABLE_LOGIN_SOURCE_SCOPE,
        { role: "user" },
      )).resolves.toEqual(GENERIC_AUTH_FAILURE);
      await expect(auth.authenticatePasswordOrToken(
        "scout",
        historical.token,
        UNAVAILABLE_LOGIN_SOURCE_SCOPE,
      )).resolves.toEqual(GENERIC_AUTH_FAILURE);
      deriveBits.mockRestore();
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

describe("AuthStore permanent account identities", () => {
  it("tombstones a removed username so neither its name nor uid can be reused", async () => {
    const kernel = await getAgentByName(env.KERNEL, crypto.randomUUID());

    await runInDurableObject(kernel, async (_instance: Kernel, state) => {
      const auth = new AuthStore(state.storage.sql);
      await auth.bootstrap();
      auth.addUser({
        username: "alice",
        uid: 1000,
        gid: 1000,
        gecos: "Alice",
        home: "/home/alice",
        shell: "/bin/init",
      }, "human");

      expect(auth.removeUser("alice")).toBe(true);
      expect(auth.getAccountIdentity("alice")).toMatchObject({
        username: "alice",
        uid: 1000,
        kind: "human",
        state: "retired",
      });
      expect(() => auth.addUser({
        username: "alice",
        uid: 1001,
        gid: 1001,
        gecos: "Alice 2",
        home: "/home/alice",
        shell: "/bin/init",
      }, "human")).toThrow(/permanent account identity conflicts/i);
      expect(() => auth.addUser({
        username: "bob",
        uid: 1000,
        gid: 1000,
        gecos: "Bob",
        home: "/home/bob",
        shell: "/bin/init",
      }, "human")).toThrow(/permanent account identity conflicts/i);
    });
  });

  it("rejects passwd imports that remap or remove an active identity", async () => {
    const kernel = await getAgentByName(env.KERNEL, crypto.randomUUID());

    await runInDurableObject(kernel, async (_instance: Kernel, state) => {
      const auth = new AuthStore(state.storage.sql);
      await auth.bootstrap();
      auth.addUser({
        username: "alice",
        uid: 1000,
        gid: 1000,
        gecos: "Alice",
        home: "/home/alice",
        shell: "/bin/init",
      }, "human");

      expect(() => auth.importPasswd(
        "root:x:0:0:root:/root:/bin/init\nalice:x:1001:1001:Alice:/home/alice:/bin/init\n",
      )).toThrow(/cannot remove or remap permanent identity alice/i);
      expect(() => auth.importPasswd(
        "root:x:0:0:root:/root:/bin/init\n",
      )).toThrow(/cannot remove or remap permanent identity alice/i);
      expect(() => auth.importPasswd(
        "root:x:0:0:root:/root:/bin/init\nalice:x:1000:1000:Alice:/home/alice:/bin/init\nmallory:x:1001:1001:Mallory:/home/mallory:/bin/init\n",
      )).toThrow(/cannot add or restore identity mallory/i);
      expect(auth.getPasswdByUsername("alice")).toMatchObject({ uid: 1000 });
      expect(auth.getPasswdByUsername("mallory")).toBeNull();
      expect(auth.getAccountIdentity("mallory")).toBeNull();
    });
  });

  it("rejects non-canonical names before reserving them", async () => {
    const kernel = await getAgentByName(env.KERNEL, crypto.randomUUID());

    await runInDurableObject(kernel, async (_instance: Kernel, state) => {
      const auth = new AuthStore(state.storage.sql);
      await auth.bootstrap();

      expect(() => auth.addUser({
        username: "Alice",
        uid: 1000,
        gid: 1000,
        gecos: "Alice",
        home: "/home/Alice",
        shell: "/bin/init",
      }, "human")).toThrow(/canonical account username/i);
      expect(auth.getAccountIdentity("Alice")).toBeNull();
      expect(auth.getPasswdByUsername("Alice")).toBeNull();
    });
  });
});

describe("AuthStore runtime directory projection", () => {
  it("materializes projected kinds while keeping inaccessible credentials locked", async () => {
    const kernel = await getAgentByName(env.KERNEL, crypto.randomUUID());

    await runInDurableObject(kernel, async (_instance: Kernel, state) => {
      const auth = new AuthStore(state.storage.sql);
      auth.replaceRuntimeDirectory({
        accounts: [
          {
            entry: {
              username: "root",
              uid: 0,
              gid: 0,
              gecos: "root",
              home: "/root",
              shell: "/bin/init",
            },
            kind: "system",
            locked: true,
          },
          {
            entry: {
              username: "alice",
              uid: 1000,
              gid: 1000,
              gecos: "alice",
              home: "/home/alice",
              shell: "/bin/init",
            },
            kind: "human",
            locked: false,
          },
          {
            entry: {
              username: "bob",
              uid: 1001,
              gid: 1001,
              gecos: "bob",
              home: "/home/bob",
              shell: "/bin/init",
            },
            kind: "human",
            locked: true,
          },
        ],
        groups: [
          { name: "root", gid: 0, members: [] },
          { name: "alice", gid: 1000, members: [] },
          { name: "bob", gid: 1001, members: [] },
        ],
        ownerUid: 1000,
        personalAgentUid: null,
      });

      expect(auth.getAccountIdentity("bob")).toMatchObject({ kind: "human" });
      expect(isLocked(auth.getShadowByUsername("root")!)).toBe(true);
      expect(isLocked(auth.getShadowByUsername("bob")!)).toBe(true);
      expect(isLocked(auth.getShadowByUsername("alice")!)).toBe(false);
    });
  });
});
