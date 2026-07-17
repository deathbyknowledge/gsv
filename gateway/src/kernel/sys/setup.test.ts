import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KernelContext } from "../context";
import type { InstalledPackageRecord } from "../packages";

const {
  ensureDefaultConversationExecutorMock,
  handleSysBootstrapMock,
  seedRepoSkillsToHomeMock,
} = vi.hoisted(() => ({
  ensureDefaultConversationExecutorMock: vi.fn(),
  handleSysBootstrapMock: vi.fn(),
  seedRepoSkillsToHomeMock: vi.fn(),
}));

vi.mock("./bootstrap", () => ({
  handleSysBootstrap: handleSysBootstrapMock,
}));

vi.mock("./skills-seed", () => ({
  seedRepoSkillsToHome: seedRepoSkillsToHomeMock,
}));

vi.mock("../agents", async (importOriginal) => {
  const original = await importOriginal<typeof import("../agents")>();
  return {
    ...original,
    ensureDefaultConversationExecutor: ensureDefaultConversationExecutorMock,
  };
});

import { handleSysSetup } from "./setup";

function createCtx(overrides?: {
  setupMode?: boolean;
  packages?: InstalledPackageRecord[];
  ripgit?: Fetcher;
  setupTokenHash?: unknown;
  setupTokenExpiresAt?: unknown;
  managedSetupTokenPolicy?: KernelContext["managedSetupTokenPolicy"];
  requestSignal?: AbortSignal;
}) {
  type PasswdRow = { username: string; uid: number; gid: number; gecos: string; home: string; shell: string };
  type GroupRow = { name: string; gid: number; members: string[] };

  const usersGroup: GroupRow = { name: "users", gid: 100, members: [] };
  const passwd: PasswdRow[] = [
    { username: "root", uid: 0, gid: 0, gecos: "root", home: "/root", shell: "/bin/init" },
  ];
  const groups: GroupRow[] = [usersGroup];
  const shadows = new Map<string, { username: string; hash: string }>([
    ["root", { username: "root", hash: "!" }],
  ]);
  const personalAgents = new Map<number, number>();
  const configValues = new Map<string, string>();
  const capsTable: { gid: number; capability: string }[] = [];
  let recovery: {
    username: string;
    uid: number;
    gid: number;
    planFingerprint: string;
    createdAt: number;
  } | null = null;

  const maxId = () => Math.max(0, ...passwd.map((u) => u.uid), ...groups.map((g) => g.gid));

  const auth = {
    isSetupMode: vi.fn(() => (
      overrides?.setupMode ?? (recovery !== null || !passwd.some((entry) => entry.uid >= 1000))
    )),
    getPasswdEntries: vi.fn(() => passwd.map((u) => ({ ...u }))),
    getPasswdByUsername: vi.fn((username: string) => {
      const found = passwd.find((u) => u.username === username);
      return found ? { ...found } : null;
    }),
    getPasswdByUid: vi.fn((uid: number) => {
      const found = passwd.find((u) => u.uid === uid);
      return found ? { ...found } : null;
    }),
    nextUid: vi.fn(() => Math.max(999, ...passwd.map((u) => u.uid)) + 1),
    nextGid: vi.fn(() => Math.max(99, maxId()) + 1),
    addUser: vi.fn((entry: PasswdRow) => {
      passwd.push({
        username: entry.username,
        uid: entry.uid,
        gid: entry.gid,
        gecos: entry.gecos ?? entry.username,
        home: entry.home,
        shell: entry.shell ?? "/bin/init",
      });
    }),
    setShadow: vi.fn((entry: { username: string; hash: string }) => {
      shadows.set(entry.username, { username: entry.username, hash: entry.hash });
    }),
    getGroupByName: vi.fn((name: string) => {
      const found = groups.find((g) => g.name === name);
      return found ? { ...found, members: [...found.members] } : null;
    }),
    getGroupByGid: vi.fn((gid: number) => {
      const found = groups.find((g) => g.gid === gid);
      return found ? { ...found, members: [...found.members] } : null;
    }),
    addGroup: vi.fn((entry: GroupRow) => {
      groups.push({ name: entry.name, gid: entry.gid, members: [...entry.members] });
    }),
    updateGroupMembers: vi.fn((name: string, members: string[]) => {
      const group = groups.find((g) => g.name === name);
      if (group) group.members = members;
      return true;
    }),
    getPersonalAgentUid: vi.fn((ownerUid: number) => personalAgents.get(ownerUid) ?? null),
    setPersonalAgent: vi.fn((ownerUid: number, agentUid: number) => {
      personalAgents.set(ownerUid, agentUid);
    }),
    isPersonalAgentUid: vi.fn((uid: number) => [...personalAgents.values()].includes(uid)),
    setPasswordHash: vi.fn((username: string, hash: string) => {
      if (!shadows.has(username)) return false;
      shadows.set(username, { username, hash });
      return true;
    }),
    setPassword: vi.fn(async (username: string, hash: string) => {
      if (!shadows.has(username)) return false;
      shadows.set(username, { username, hash });
      return true;
    }),
    authenticate: vi.fn(async (username: string, password: string) => {
      const user = passwd.find((entry) => entry.username === username);
      const shadow = shadows.get(username);
      if (!user || !shadow) return { ok: false as const, error: "Authentication failed" };
      const { verify } = await import("../../auth/shadow");
      if (!await verify(password, shadow.hash)) {
        return { ok: false as const, error: "Authentication failed" };
      }
      return {
        ok: true as const,
        identity: {
          uid: user.uid,
          gid: user.gid,
          gids: [user.gid],
          username: user.username,
          home: user.home,
        },
      };
    }),
    prepareToken: vi.fn(async () => ({
      issued: {
        tokenId: "tok-1",
        token: "gsv_node_abc",
        tokenPrefix: "gsv_node_abc",
        uid: 1000,
        kind: "node" as const,
        label: "node:macbook",
        allowedRole: "driver" as const,
        allowedDeviceId: "macbook",
        createdAt: 1_700_000_000_000,
        expiresAt: null,
      },
      tokenHash: "token-hash",
    })),
    persistPreparedToken: vi.fn((prepared: { issued: object }) => prepared.issued),
    resolveGids: vi.fn((_username: string, primaryGid: number) => [primaryGid]),
    getShadowByUsername: vi.fn((username: string) => shadows.get(username) ?? null),
  };

  const setupRecovery = {
    current: vi.fn(() => recovery ? { ...recovery } : null),
    start: vi.fn((record: NonNullable<typeof recovery>, commit: () => void) => {
      const passwdBefore = structuredClone(passwd);
      const groupsBefore = structuredClone(groups);
      const shadowsBefore = structuredClone([...shadows]);
      try {
        commit();
        recovery = { ...record };
      } catch (error) {
        passwd.splice(0, passwd.length, ...passwdBefore);
        groups.splice(0, groups.length, ...groupsBefore);
        shadows.clear();
        for (const [name, entry] of shadowsBefore) shadows.set(name, entry);
        throw error;
      }
    }),
    finish: vi.fn((record: NonNullable<typeof recovery>, commit: () => unknown) => {
      if (!recovery || recovery.planFingerprint !== record.planFingerprint) {
        throw new Error("Setup recovery state changed before completion");
      }
      const result = commit();
      recovery = null;
      return result;
    }),
  };

  const config = {
    get: vi.fn((key: string) => configValues.get(key) ?? null),
    set: vi.fn((key: string, value: string) => {
      configValues.set(key, value);
    }),
    delete: vi.fn((key: string) => configValues.delete(key)),
  };

  const caps = {
    grant: vi.fn((gid: number, capability: string) => {
      capsTable.push({ gid, capability });
      return { ok: true };
    }),
    revoke: vi.fn((gid: number, capability: string) => {
      for (let i = capsTable.length - 1; i >= 0; i -= 1) {
        if (capsTable[i].gid === gid && capsTable[i].capability === capability) {
          capsTable.splice(i, 1);
        }
      }
      return { ok: true };
    }),
    list: vi.fn((gid?: number) =>
      capsTable.filter((entry) => gid === undefined || entry.gid === gid),
    ),
    resolve: vi.fn((gids: number[]) =>
      [...new Set(capsTable.filter((entry) => gids.includes(entry.gid)).map((entry) => entry.capability))],
    ),
  };

  const storage = {
    head: vi.fn(async () => null),
    put: vi.fn(async () => {}),
  };

  const ctx = {
    auth: auth as unknown as KernelContext["auth"],
    caps: caps as unknown as KernelContext["caps"],
    config: config as unknown as KernelContext["config"],
    env: {
      STORAGE: storage,
      ...(overrides?.ripgit ? { RIPGIT: overrides.ripgit } : {}),
      ...(overrides && "setupTokenHash" in overrides
        ? {
            GSV_SETUP_TOKEN_HASH: overrides.setupTokenHash,
            GSV_SETUP_TOKEN_EXPIRES_AT: overrides.setupTokenExpiresAt ?? "2000000000000",
          }
        : {}),
    } as unknown as KernelContext["env"],
    packages: {
      list: vi.fn(() => overrides?.packages ?? []),
    } as unknown as KernelContext["packages"],
    serverVersion: "0.0.1-test",
    managedSetupTokenPolicy: overrides?.managedSetupTokenPolicy,
    requestSignal: overrides?.requestSignal,
    setupRecovery: setupRecovery as unknown as KernelContext["setupRecovery"],
  } as KernelContext;

  return {
    ctx,
    auth,
    config,
    storage,
    usersGroup,
    passwd,
    groups,
    setupRecovery,
    recovery: () => recovery ? { ...recovery } : null,
    shadows,
  };
}

describe("handleSysSetup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handleSysBootstrapMock.mockResolvedValue({
      repo: "root/gsv",
      remoteUrl: "https://github.com/deathbyknowledge/gsv",
      ref: "main",
      head: "abc123",
      changed: true,
      manual: {
        repo: "root/gsv-manual",
        remoteUrl: "https://github.com/deathbyknowledge/gsv-manual",
        ref: "main",
        head: "manual123",
        changed: true,
      },
    });
    seedRepoSkillsToHomeMock.mockResolvedValue({ username: "root", copied: 0, skipped: 0 });
    ensureDefaultConversationExecutorMock.mockResolvedValue("proc-default");
  });

  it("creates first user, ai config, and node token", async () => {
    const { ctx, auth, config, storage, usersGroup } = createCtx();

    const result = await handleSysSetup(
      {
        username: "alice",
        password: "password-123",
        ai: {
          provider: "openrouter",
          model: "qwen/qwen3.5-35b-a3b",
          apiKey: "or-key",
        },
        timezone: "Europe/Amsterdam",
        node: {
          deviceId: "macbook",
        },
      },
      ctx,
    );

    expect(auth.addUser).toHaveBeenCalledWith(
      expect.objectContaining({
        username: "alice",
        uid: 1000,
        gid: 1000,
        home: "/home/alice",
      }),
    );
    expect(usersGroup.members).toContain("alice");
    expect(config.set).toHaveBeenCalledWith("config/ai/provider", "openrouter");
    expect(config.set).toHaveBeenCalledWith("config/ai/model", "qwen/qwen3.5-35b-a3b");
    expect(config.set).toHaveBeenCalledWith("config/ai/api_key", "or-key");
    expect(config.set).toHaveBeenCalledWith("config/server/timezone", "Europe/Amsterdam");
    expect(storage.put).toHaveBeenCalledWith(
      "home/alice/.dir",
      expect.any(ArrayBuffer),
      expect.any(Object),
    );
    expect(result.user.username).toBe("alice");
    expect(result.server).toEqual({ version: "0.0.1-test", release: "dev" });
    expect(result.nodeToken?.allowedDeviceId).toBe("macbook");
  });

  it("provisions the requested personal agent username", async () => {
    const { ctx, auth } = createCtx();

    await handleSysSetup(
      {
        username: "alice",
        password: "password-123",
        agentName: "mira",
      },
      ctx,
    );

    expect(auth.addUser).toHaveBeenCalledWith(
      expect.objectContaining({
        username: "mira",
        uid: 1001,
        gid: 1001,
        gecos: "Mira",
        home: "/home/mira",
      }),
    );
    expect(auth.setPersonalAgent).toHaveBeenCalledWith(1000, 1001);
  });

  it("grants the first user access to enabled package profile agents", async () => {
    const packageRecord = {
      packageId: "import:root/wiki:.",
      scope: { kind: "global" },
      enabled: true,
      manifest: {
        name: "wiki",
        profiles: [{
          name: "builder",
          displayName: "Wiki Builder",
          contextFiles: [],
          capabilities: ["fs.read"],
        }],
      },
    } as InstalledPackageRecord;
    const { ctx, passwd, groups } = createCtx({ packages: [packageRecord] });

    await handleSysSetup(
      {
        username: "alice",
        password: "password-123",
        agentName: "mira",
      },
      ctx,
    );

    expect(passwd.find((entry) => entry.username === "wiki-builder")).toEqual(
      expect.objectContaining({ uid: 1002, gid: 1002 }),
    );
    expect(new Set(passwd.map((entry) => entry.uid)).size).toBe(passwd.length);
    expect(groups.find((group) => group.name === "wiki-builder-run")?.members).toEqual(["alice"]);
  });

  it("seeds shipped skills into root home after first setup bootstrap", async () => {
    const ripgit = {
      fetch: vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/apply")) {
          return new Response(JSON.stringify({ ok: true, head: "home123" }), {
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("missing", { status: 404 });
      }),
    } as Fetcher;
    const { ctx } = createCtx({ ripgit, packages: [] });

    await handleSysSetup(
      {
        username: "alice",
        password: "password-123",
      },
      ctx,
    );

    expect(handleSysBootstrapMock).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({
        identity: expect.objectContaining({
          process: expect.objectContaining({ username: "alice" }),
        }),
      }),
    );
    expect(seedRepoSkillsToHomeMock).toHaveBeenCalledWith(
      expect.any(Object),
      { owner: "root", repo: "gsv", branch: "abc123" },
      expect.objectContaining({ username: "root", home: "/root" }),
    );
  });

  it("rejects when setup mode is already completed", async () => {
    const { ctx } = createCtx({ setupMode: false });

    await expect(handleSysSetup(
      {
        username: "alice",
        password: "password-123",
      },
      ctx,
    )).rejects.toThrow("System already initialized");
  });

  it("authorizes managed setup before mutating system state", async () => {
    const token = "managed-setup-token";
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
    );
    const setupTokenHash = Array.from(
      digest,
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    const { ctx, auth } = createCtx({ setupTokenHash });
    const args = {
      username: "alice",
      password: "password-123",
    };

    await expect(handleSysSetup(args, ctx)).rejects.toMatchObject({
      status: 403,
      message: "Setup authorization failed",
    });
    await expect(handleSysSetup({ ...args, setupToken: "wrong-token" }, ctx)).rejects.toMatchObject({
      status: 403,
      message: "Setup authorization failed",
    });
    expect(auth.addUser).not.toHaveBeenCalled();
    expect(handleSysBootstrapMock).not.toHaveBeenCalled();

    await expect(handleSysSetup({ ...args, setupToken: token }, ctx)).resolves.toMatchObject({
      user: { username: "alice" },
    });
  });

  it("uses the runtime-owned setup policy before legacy deployment secrets", async () => {
    const token = "A".repeat(43);
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
    );
    const hash = Array.from(
      digest,
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    const { ctx } = createCtx({
      setupTokenHash: "invalid-legacy-secret",
      managedSetupTokenPolicy: {
        version: 2,
        hash,
        expiresAt: 2_000_000_000_000,
      },
    });

    await expect(handleSysSetup({
      username: "alice",
      password: "password-123",
      setupToken: token,
    }, ctx)).resolves.toMatchObject({ user: { username: "alice" } });
  });

  it("rejects an expired managed setup token before mutating system state", async () => {
    const token = "expired-managed-setup-token";
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
    );
    const setupTokenHash = Array.from(
      digest,
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    const { ctx, auth } = createCtx({
      setupTokenHash,
      setupTokenExpiresAt: "1",
    });

    await expect(handleSysSetup({
      username: "alice",
      password: "password-123",
      setupToken: token,
    }, ctx)).rejects.toMatchObject({
      status: 403,
      message: "Setup authorization failed",
    });
    expect(auth.addUser).not.toHaveBeenCalled();
    expect(handleSysBootstrapMock).not.toHaveBeenCalled();
  });

  it("rejects credential-bearing bootstrap URLs before bootstrap or persistence", async () => {
    const { ctx, auth, config } = createCtx({ ripgit: {} as Fetcher });

    await expect(handleSysSetup({
      username: "alice",
      password: "password-123",
      bootstrap: {
        remoteUrl: "https://bootstrap-user:super-secret@git.example.com/team/gsv.git",
      },
      ai: {
        provider: "openrouter",
        model: "test-model",
        apiKey: "ai-key",
      },
    }, ctx)).rejects.toThrow("Bootstrap repository URLs must not include credentials");

    expect(handleSysBootstrapMock).not.toHaveBeenCalled();
    expect(auth.addUser).not.toHaveBeenCalled();
    expect(config.set).not.toHaveBeenCalled();
  });

  it("fails before setup when the managed token hash is malformed", async () => {
    const { ctx, auth } = createCtx({ setupTokenHash: "invalid" });

    await expect(handleSysSetup({
      username: "alice",
      password: "password-123",
      setupToken: "managed-setup-token",
    }, ctx)).rejects.toMatchObject({
      status: 500,
      message: "GSV_SETUP_TOKEN_HASH must be a lowercase 64-character SHA-256 hex digest",
    });
    expect(auth.addUser).not.toHaveBeenCalled();
    expect(handleSysBootstrapMock).not.toHaveBeenCalled();
  });

  it("rolls back a failed auth commit and admits a clean retry", async () => {
    const { ctx, auth, passwd, recovery } = createCtx();
    auth.setPasswordHash.mockImplementationOnce(() => {
      throw new Error("injected auth commit failure");
    });
    const args = {
      username: "alice",
      password: "password-123",
    };

    await expect(handleSysSetup(args, ctx)).rejects.toThrow("injected auth commit failure");
    expect(passwd.some((entry) => entry.username === "alice")).toBe(false);
    expect(recovery()).toBeNull();

    await expect(handleSysSetup(args, ctx)).resolves.toMatchObject({
      user: { username: "alice", uid: 1000 },
    });
    expect(passwd.filter((entry) => entry.username === "alice")).toHaveLength(1);
  });

  it("retries idempotent provisioning after the auth commit", async () => {
    const { ctx, auth, passwd, recovery } = createCtx();
    ensureDefaultConversationExecutorMock.mockRejectedValueOnce(
      new Error("injected default conversation failure"),
    );
    const args = {
      username: "alice",
      password: "password-123",
      agentName: "mira",
    };

    await expect(handleSysSetup(args, ctx)).rejects.toThrow(
      "injected default conversation failure",
    );
    expect(recovery()).toMatchObject({ username: "alice", uid: 1000 });
    expect(auth.isSetupMode()).toBe(true);

    await expect(handleSysSetup(args, ctx)).resolves.toMatchObject({
      user: { username: "alice", uid: 1000 },
    });
    expect(recovery()).toBeNull();
    expect(ensureDefaultConversationExecutorMock).toHaveBeenCalledTimes(2);
    expect(passwd.filter((entry) => entry.username === "alice")).toHaveLength(1);
    expect(passwd.filter((entry) => entry.username === "mira")).toHaveLength(1);
  });

  it("requires the committed user password to resume setup", async () => {
    const { ctx, recovery } = createCtx();
    ensureDefaultConversationExecutorMock.mockRejectedValueOnce(new Error("injected failure"));
    const args = {
      username: "alice",
      password: "password-123",
    };
    await expect(handleSysSetup(args, ctx)).rejects.toThrow("injected failure");

    await expect(handleSysSetup({
      ...args,
      password: "wrong-password",
    }, ctx)).rejects.toThrow("Setup recovery authentication failed");
    expect(recovery()).toMatchObject({ username: "alice" });
  });

  it("matches secret-presence flags but never rewrites root credentials on retry", async () => {
    const { ctx, config, recovery, shadows } = createCtx();
    ensureDefaultConversationExecutorMock.mockRejectedValueOnce(new Error("injected failure"));
    const args = {
      username: "alice",
      password: "password-123",
      rootPassword: "first-root-password",
      ai: {
        provider: "openrouter",
        apiKey: "first-api-key",
      },
    };
    await expect(handleSysSetup(args, ctx)).rejects.toThrow("injected failure");
    const committedRootHash = shadows.get("root")?.hash;

    await expect(handleSysSetup({
      ...args,
      rootPassword: "different-root-password",
      ai: { ...args.ai, apiKey: undefined },
    }, ctx)).rejects.toThrow("Setup recovery request does not match");
    expect(recovery()).not.toBeNull();

    await expect(handleSysSetup({
      ...args,
      rootPassword: "different-root-password",
      ai: { ...args.ai, apiKey: "replacement-api-key" },
    }, ctx)).resolves.toMatchObject({ user: { username: "alice" } });
    expect(shadows.get("root")?.hash).toBe(committedRootHash);
    expect(config.set).toHaveBeenLastCalledWith("config/ai/api_key", "replacement-api-key");
  });

  it("resumes a managed setup after its bootstrap token expires", async () => {
    const token = "A".repeat(43);
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
    );
    const hash = Array.from(
      digest,
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    const { ctx } = createCtx({
      managedSetupTokenPolicy: {
        version: 1,
        hash,
        expiresAt: 2_000_000_000_000,
      },
    });
    ensureDefaultConversationExecutorMock.mockRejectedValueOnce(new Error("injected failure"));
    const args = {
      username: "alice",
      password: "password-123",
      setupToken: token,
    };
    await expect(handleSysSetup(args, ctx)).rejects.toThrow("injected failure");

    ctx.managedSetupTokenPolicy = { version: 1, hash, expiresAt: 1 };
    await expect(handleSysSetup({
      username: "alice",
      password: "password-123",
    }, ctx)).resolves.toMatchObject({ user: { username: "alice" } });
  });

  it("keeps setup recoverable when final node-token persistence fails", async () => {
    const { ctx, auth, recovery } = createCtx();
    auth.persistPreparedToken.mockImplementationOnce(() => {
      throw new Error("injected token commit failure");
    });
    const args = {
      username: "alice",
      password: "password-123",
      node: { deviceId: "macbook" },
    };

    await expect(handleSysSetup(args, ctx)).rejects.toThrow("injected token commit failure");
    expect(recovery()).not.toBeNull();

    await expect(handleSysSetup(args, ctx)).resolves.toMatchObject({
      nodeToken: {
        token: "gsv_node_abc",
        allowedDeviceId: "macbook",
      },
    });
    expect(auth.prepareToken).toHaveBeenCalledTimes(2);
    expect(recovery()).toBeNull();
  });

  it("does not continue setup after a managed fence aborts an external step", async () => {
    const controller = new AbortController();
    let releaseBootstrap!: (value: {
      repo: string;
      remoteUrl: string;
      ref: string;
      head: string;
      changed: boolean;
      manual: null;
    }) => void;
    handleSysBootstrapMock.mockImplementationOnce(() => new Promise((resolve) => {
      releaseBootstrap = resolve;
    }));
    const { ctx, auth, config, recovery } = createCtx({
      ripgit: {} as Fetcher,
      requestSignal: controller.signal,
    });

    const setup = handleSysSetup({
      username: "alice",
      password: "password-123",
    }, ctx);
    await vi.waitFor(() => expect(handleSysBootstrapMock).toHaveBeenCalledOnce());
    controller.abort(new Error("Tenant runtime is being updated"));
    releaseBootstrap({
      repo: "root/gsv",
      remoteUrl: "https://github.com/deathbyknowledge/gsv",
      ref: "main",
      head: "abc123",
      changed: true,
      manual: null,
    });

    await expect(setup).rejects.toThrow("Tenant runtime is being updated");
    expect(recovery()).toMatchObject({ username: "alice" });
    expect(config.set).not.toHaveBeenCalled();
    expect(auth.prepareToken).not.toHaveBeenCalled();
    expect(ensureDefaultConversationExecutorMock).not.toHaveBeenCalled();
  });

  it("allows a recovery retry to refresh an absolute node-token expiry", async () => {
    const { ctx, auth } = createCtx();
    ensureDefaultConversationExecutorMock.mockRejectedValueOnce(new Error("injected failure"));
    const firstExpiry = Date.now() + 60_000;
    const retryExpiry = firstExpiry + 60_000;
    const args = {
      username: "alice",
      password: "password-123",
      node: { deviceId: "macbook", expiresAt: firstExpiry },
    };
    await expect(handleSysSetup(args, ctx)).rejects.toThrow("injected failure");

    await expect(handleSysSetup({
      ...args,
      node: { ...args.node, expiresAt: retryExpiry },
    }, ctx)).resolves.toMatchObject({ nodeToken: { allowedDeviceId: "macbook" } });
    expect(auth.prepareToken).toHaveBeenLastCalledWith(
      expect.objectContaining({ expiresAt: retryExpiry }),
    );
  });

  it("keeps completed setup one-shot even if the success response is lost", async () => {
    const { ctx } = createCtx();
    const args = {
      username: "alice",
      password: "password-123",
      node: { deviceId: "macbook" },
    };
    await expect(handleSysSetup(args, ctx)).resolves.toMatchObject({
      nodeToken: { token: "gsv_node_abc" },
    });

    await expect(handleSysSetup(args, ctx)).rejects.toThrow("System already initialized");
  });

  it("requires a valid username and password", async () => {
    const { ctx } = createCtx();

    await expect(handleSysSetup(
      {
        username: "Bad Name",
        password: "short",
      },
      ctx,
    )).rejects.toThrow("username must match");
  });

  it("rejects a personal agent username that matches the first user", async () => {
    const { ctx, auth } = createCtx();

    await expect(handleSysSetup(
      {
        username: "alice",
        password: "password-123",
        agentName: "alice",
      },
      ctx,
    )).rejects.toThrow("agentName must be different from username");

    expect(auth.addUser).not.toHaveBeenCalled();
  });

  it("rejects an unavailable personal agent username", async () => {
    const { ctx, auth } = createCtx();

    await expect(handleSysSetup(
      {
        username: "alice",
        password: "password-123",
        agentName: "root",
      },
      ctx,
    )).rejects.toThrow("agentName is unavailable: root");

    expect(auth.addUser).not.toHaveBeenCalled();
  });

  it("rejects an invalid timezone", async () => {
    const { ctx } = createCtx();

    await expect(handleSysSetup(
      {
        username: "alice",
        password: "password-123",
        timezone: "Not/AZone",
      },
      ctx,
    )).rejects.toThrow("timezone must be a valid IANA timezone");
  });

  it("sets root password when provided", async () => {
    const { ctx, auth } = createCtx();

    await handleSysSetup(
      {
        username: "alice",
        password: "password-123",
        rootPassword: "root-password-123",
      },
      ctx,
    );

    expect(auth.setPasswordHash).toHaveBeenCalledWith("root", expect.any(String));
  });
});
