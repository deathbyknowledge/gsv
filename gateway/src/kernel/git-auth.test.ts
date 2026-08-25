import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it, vi } from "vitest";
import { hashPassword, makeShadowEntry } from "../auth/shadow";
import {
  ACCOUNT_USERNAME_MAX_CHARACTERS,
  LOGIN_CREDENTIAL_MAX_CHARACTERS,
} from "../auth/login";
import { AUTHENTICATION_FAILED_MESSAGE, AuthStore } from "./auth-store";
import { Kernel } from "./do";
import type { UserKernelLifecycle, UserKernelRecord } from "./user-kernels";
import { UserKernelRegistry } from "./user-kernels";
import { SHIP_KERNEL_NAME } from "../shared/kernel-names";

type SeedGitUser = {
  username: string;
  uid: number;
  lifecycle: UserKernelLifecycle;
  password: string;
};

async function seedGitUsers(
  kernel: DurableObjectStub<Kernel>,
  users: SeedGitUser[],
): Promise<Record<string, string>> {
  return runInDurableObject(kernel, async (_instance: Kernel, state) => {
    const auth = new AuthStore(state.storage.sql);
    await auth.bootstrap();
    const tokens: Record<string, string> = {};

    for (const user of users) {
      if (!auth.getPasswdByUsername(user.username)) {
        auth.addUser({
          username: user.username,
          uid: user.uid,
          gid: 100,
          gecos: user.username,
          home: `/home/${user.username}`,
          shell: "/bin/init",
        }, "human");
      }
      const passwordHash = await hashPassword(user.password);
      if (auth.getShadowByUsername(user.username)) {
        auth.setPassword(user.username, passwordHash);
      } else {
        auth.setShadow(makeShadowEntry(user.username, passwordHash));
      }
      tokens[user.username] = (await auth.issueToken({
        uid: user.uid,
        kind: "user",
      })).token;

      const placements = new UserKernelRegistry(state.storage.sql);
      placements.reserve(user.username, user.uid);
      if (user.lifecycle === "active") {
        placements.markActive(user.username);
      } else {
        state.storage.sql.exec(
          "UPDATE user_kernels SET lifecycle = 'provisioning' WHERE username = ?",
          user.username,
        );
      }
    }

    return tokens;
  });
}

function placement(
  lifecycle: UserKernelLifecycle = "active",
  uid = 1000,
): UserKernelRecord {
  return {
    username: "alice",
    uid,
    lifecycle,
    createdAt: 1,
    updatedAt: 1,
  };
}

function authenticatedIdentity(uid = 1000) {
  return {
    ok: true as const,
    identity: {
      uid,
      gid: 100,
      gids: [100],
      username: "alice",
      home: "/home/alice",
    },
    credential: { kind: "password" as const },
  };
}

function makeGitAuthorizationHarness(input: {
  getPlacement?: () => UserKernelRecord | null;
  authenticate?: () => Promise<ReturnType<typeof authenticatedIdentity> | {
    ok: false;
    error: string;
  }>;
  publicRead?: boolean;
} = {}) {
  const current = placement();
  const kernel = Object.create(Kernel.prototype) as any;
  Object.defineProperty(kernel, "name", { value: SHIP_KERNEL_NAME });
  kernel.transitioningUserKernels = new Set<string>();
  kernel.activeMasterUserOperations = new Map();
  kernel.userKernels = {
    get: vi.fn(input.getPlacement ?? (() => current)),
  };
  const authenticatePasswordOrToken = vi.fn(
    input.authenticate ?? (async () => authenticatedIdentity()),
  );
  kernel.auth = { authenticatePasswordOrToken };
  kernel.caps = { resolve: vi.fn(() => ["repo.read"]) };
  kernel.config = {
    get: vi.fn((key: string) => (
      input.publicRead && key === "repos/alice/notes/visibility"
        ? "public"
        : null
    )),
  };
  kernel.buildKernelContext = vi.fn(({ identity }) => ({
    identity,
    callerOwnerUid: identity.process.uid,
    auth: kernel.auth,
    config: kernel.config,
    packages: { list: vi.fn(() => []) },
  }));
  return { kernel, authenticatePasswordOrToken };
}

describe("Git HTTP authentication", () => {
  it("admits valid active account placements", async () => {
    const kernel = await getAgentByName(env.KERNEL, SHIP_KERNEL_NAME);
    const tokens = await seedGitUsers(kernel, [
      {
        username: "alice",
        uid: 1000,
        lifecycle: "active",
        password: "alice-password",
      },
      {
        username: "bob",
        uid: 1001,
        lifecycle: "active",
        password: "bob-password",
      },
    ]);

    await expect(kernel.authorizeGitHttp({
      owner: "alice",
      repo: "private-repo",
      write: true,
      username: "alice",
      credential: "alice-password",
    })).resolves.toMatchObject({ ok: true, username: "alice", uid: 1000 });
    await expect(kernel.authorizeGitHttp({
      owner: "bob",
      repo: "private-repo",
      write: true,
      username: "bob",
      credential: tokens.bob,
    })).resolves.toMatchObject({ ok: true, username: "bob", uid: 1001 });
  });

  it("accepts passwords and tokens while hiding account and credential state", async () => {
    const kernel = await getAgentByName(env.KERNEL, SHIP_KERNEL_NAME);
    const token = (await seedGitUsers(kernel, [{
      username: "root",
      uid: 0,
      lifecycle: "active",
      password: "correct-password",
    }])).root;
    const request = {
      owner: "root",
      repo: "private-repo",
      write: true,
    };

    await expect(kernel.authorizeGitHttp({
      ...request,
      username: "root",
      credential: "correct-password",
    })).resolves.toMatchObject({ ok: true, username: "root", uid: 0 });
    await expect(kernel.authorizeGitHttp({
      ...request,
      username: "root",
      credential: token,
    })).resolves.toMatchObject({ ok: true, username: "root", uid: 0 });

    const wrong = await kernel.authorizeGitHttp({
      ...request,
      username: "root",
      credential: "wrong-credential",
    });
    const unknown = await kernel.authorizeGitHttp({
      ...request,
      username: "unknown-user",
      credential: "wrong-credential",
    });
    expect(wrong).toEqual({
      ok: false,
      status: 401,
      message: AUTHENTICATION_FAILED_MESSAGE,
    });
    expect(unknown).toEqual(wrong);

    const deriveBits = vi.spyOn(crypto.subtle, "deriveBits");
    const padded = await kernel.authorizeGitHttp({
      ...request,
      trustedSourceAddress: "203.0.113.8",
      username: "root",
      credential: " correct-password ",
    });
    const oversized = await kernel.authorizeGitHttp({
      ...request,
      trustedSourceAddress: "203.0.113.8",
      username: "root",
      credential: "x".repeat(LOGIN_CREDENTIAL_MAX_CHARACTERS + 1),
    });
    const oversizedUsername = await kernel.authorizeGitHttp({
      ...request,
      trustedSourceAddress: "203.0.113.8",
      username: "a".repeat(ACCOUNT_USERNAME_MAX_CHARACTERS + 1),
      credential: "wrong-credential",
    });
    expect(padded).toEqual(wrong);
    expect(oversized).toEqual(wrong);
    expect(oversizedUsername).toEqual(wrong);
    expect(deriveBits).toHaveBeenCalledTimes(3);
    deriveBits.mockRestore();
  });

  it("generically denies valid passwords and tokens for provisioning users", async () => {
    const kernel = await getAgentByName(env.KERNEL, SHIP_KERNEL_NAME);
    const tokens = await seedGitUsers(kernel, [
      {
        username: "alice",
        uid: 1000,
        lifecycle: "provisioning",
        password: "alice-password",
      },
      {
        username: "bob",
        uid: 1001,
        lifecycle: "provisioning",
        password: "bob-password",
      },
    ]);
    const deriveBits = vi.spyOn(crypto.subtle, "deriveBits");
    const denied = {
      ok: false,
      status: 401,
      message: AUTHENTICATION_FAILED_MESSAGE,
    };

    for (const [username, credentials] of [
      ["alice", ["alice-password", tokens.alice]],
      ["bob", ["bob-password", tokens.bob]],
    ] as const) {
      for (const credential of credentials) {
        await expect(kernel.authorizeGitHttp({
          owner: username,
          repo: "private-repo",
          write: true,
          username,
          credential,
        })).resolves.toEqual(denied);
      }
    }

    expect(deriveBits).toHaveBeenCalledTimes(4);
    deriveBits.mockRestore();
  });

  it("rejects uid, lifecycle, and missing-placement snapshot mismatches", async () => {
    const initial = placement("active", 1000);
    const cases = [
      {
        name: "credential uid",
        authenticate: async () => authenticatedIdentity(1001),
        current: initial,
      },
      {
        name: "placement lifecycle",
        authenticate: async () => authenticatedIdentity(),
        current: placement("provisioning", 1000),
      },
      {
        name: "missing current placement",
        authenticate: async () => authenticatedIdentity(),
        current: null,
      },
    ] as const;

    for (const mismatch of cases) {
      let read = 0;
      const { kernel } = makeGitAuthorizationHarness({
        authenticate: mismatch.authenticate,
        getPlacement: () => (read++ === 0 ? initial : mismatch.current),
      });

      await expect(kernel.authorizeGitHttp({
        owner: "alice",
        repo: "notes",
        write: true,
        username: "alice",
        credential: "valid-credential",
      }), mismatch.name).resolves.toEqual({
        ok: false,
        status: 401,
        message: AUTHENTICATION_FAILED_MESSAGE,
      });
      expect(kernel.caps.resolve, mismatch.name).not.toHaveBeenCalled();
    }
  });

  it("blocks transitioning users only after performing credential verification", async () => {
    const { kernel, authenticatePasswordOrToken } = makeGitAuthorizationHarness();
    kernel.transitioningUserKernels.add("alice");

    await expect(kernel.authorizeGitHttp({
      owner: "alice",
      repo: "notes",
      write: true,
      username: "alice",
      credential: "valid-credential",
    })).resolves.toEqual({
      ok: false,
      status: 401,
      message: AUTHENTICATION_FAILED_MESSAGE,
    });

    expect(authenticatePasswordOrToken).toHaveBeenCalledOnce();
    expect(kernel.caps.resolve).not.toHaveBeenCalled();
  });

  it("falls back to anonymous access for public reads after credential denial", async () => {
    const suspended = placement("provisioning", 1000);
    const { kernel, authenticatePasswordOrToken } = makeGitAuthorizationHarness({
      publicRead: true,
      getPlacement: () => suspended,
    });

    await expect(kernel.authorizeGitHttp({
      owner: "alice",
      repo: "notes",
      write: false,
      username: "alice",
      credential: "still-valid-credential",
    })).resolves.toEqual({
      ok: true,
      username: null,
      uid: -1,
      capabilities: [],
    });
    expect(authenticatePasswordOrToken).toHaveBeenCalledOnce();

    await expect(kernel.authorizeGitHttp({
      owner: "alice",
      repo: "notes",
      write: false,
    })).resolves.toEqual({
      ok: true,
      username: null,
      uid: -1,
      capabilities: [],
    });
    await expect(kernel.authorizeGitHttp({
      owner: "alice",
      repo: "notes",
      write: true,
    })).resolves.toEqual({
      ok: false,
      status: 401,
      message: "Authentication required",
    });
  });

  it("rejects agent passwords and historical user tokens", async () => {
    const kernel = await getAgentByName(env.KERNEL, SHIP_KERNEL_NAME);
    const token = await runInDurableObject(kernel, async (_instance: Kernel, state) => {
      const auth = new AuthStore(state.storage.sql);
      await auth.bootstrap();
      auth.addUser({
        username: "scout",
        uid: 2000,
        gid: 2000,
        gecos: "Scout",
        home: "/home/scout",
        shell: "/bin/init",
      }, "agent");
      auth.setShadow(makeShadowEntry(
        "scout",
        await hashPassword("misconfigured-agent-password"),
      ));
      return (await auth.issueToken({ uid: 2000, kind: "user" })).token;
    });
    const request = {
      owner: "scout",
      repo: "private-repo",
      write: true,
      username: "scout",
    };

    await expect(kernel.authorizeGitHttp({
      ...request,
      credential: "misconfigured-agent-password",
    })).resolves.toEqual({
      ok: false,
      status: 401,
      message: AUTHENTICATION_FAILED_MESSAGE,
    });
    await expect(kernel.authorizeGitHttp({
      ...request,
      credential: token,
    })).resolves.toEqual({
      ok: false,
      status: 401,
      message: AUTHENTICATION_FAILED_MESSAGE,
    });
  });
});
