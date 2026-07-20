import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KernelContext } from "../context";
import type { InstalledPackageRecord } from "../packages";
import { createProvisioningR2BucketMock } from "../../test-support/mock-r2";

const { handleSysBootstrapMock, seedRepoSkillsToHomeMock } = vi.hoisted(() => ({
  handleSysBootstrapMock: vi.fn(),
  seedRepoSkillsToHomeMock: vi.fn(),
}));

vi.mock("./bootstrap", () => ({
  handleSysBootstrap: handleSysBootstrapMock,
}));

vi.mock("./skills-seed", () => ({
  seedRepoSkillsToHome: seedRepoSkillsToHomeMock,
}));

import { handleSysSetup } from "./setup";

function createCtx(overrides?: {
  setupMode?: boolean;
  packages?: InstalledPackageRecord[];
  ripgit?: Fetcher;
  configValues?: Map<string, string>;
}) {
  type PasswdRow = { username: string; uid: number; gid: number; gecos: string; home: string; shell: string };
  type GroupRow = { name: string; gid: number; members: string[] };

  const usersGroup: GroupRow = { name: "users", gid: 100, members: [] };
  const passwd: PasswdRow[] = [
    { username: "root", uid: 0, gid: 0, gecos: "root", home: "/root", shell: "/bin/init" },
  ];
  const accountKinds = new Map<string, "system" | "human" | "agent">([
    ["root", "system"],
  ]);
  const reservedAccountNames = new Set(passwd.map((entry) => entry.username));
  const groups: GroupRow[] = [usersGroup];
  const shadowRoot = { username: "root", hash: "!" };
  const personalAgents = new Map<number, number>();
  const configValues = overrides?.configValues ?? new Map<string, string>();
  const capsTable: { gid: number; capability: string }[] = [];

  const maxId = () => Math.max(0, ...passwd.map((u) => u.uid), ...groups.map((g) => g.gid));

  const auth = {
    isSetupMode: vi.fn(() => overrides?.setupMode ?? true),
    getPasswdEntries: vi.fn(() => passwd.map((u) => ({ ...u }))),
    getPasswdByUsername: vi.fn((username: string) => {
      const found = passwd.find((u) => u.username === username);
      return found ? { ...found } : null;
    }),
    getPasswdByUid: vi.fn((uid: number) => {
      const found = passwd.find((u) => u.uid === uid);
      return found ? { ...found } : null;
    }),
    getAccountIdentity: vi.fn((username: string) => {
      const found = passwd.find((entry) => entry.username === username);
      const kind = accountKinds.get(username);
      return found && kind
        ? { username, uid: found.uid, kind, state: "active" as const }
        : null;
    }),
    allocateUid: vi.fn(() => Math.max(999, ...passwd.map((u) => u.uid)) + 1),
    allocateGid: vi.fn(() => Math.max(99, maxId()) + 1),
    isAccountNameReserved: vi.fn((username: string) => reservedAccountNames.has(username)),
    addUser: vi.fn((entry: PasswdRow, kind: "system" | "human" | "agent") => {
      reservedAccountNames.add(entry.username);
      accountKinds.set(entry.username, kind);
      passwd.push({
        username: entry.username,
        uid: entry.uid,
        gid: entry.gid,
        gecos: entry.gecos ?? entry.username,
        home: entry.home,
        shell: entry.shell ?? "/bin/init",
      });
    }),
    setShadow: vi.fn(),
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
    setPassword: vi.fn(async () => true),
    issueToken: vi.fn(async () => ({
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
    })),
    listTokens: vi.fn(() => []),
    revokeToken: vi.fn(() => true),
    resolveGids: vi.fn((_username: string, primaryGid: number) => [primaryGid]),
    getShadowByUsername: vi.fn((username: string) => (username === "root" ? shadowRoot : null)),
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

  const storage = createProvisioningR2BucketMock();
  vi.spyOn(storage, "put");

  const ctx = {
    auth: auth as unknown as KernelContext["auth"],
    caps: caps as unknown as KernelContext["caps"],
    config: config as unknown as KernelContext["config"],
    env: {
      STORAGE: storage,
      ...(overrides?.ripgit ? { RIPGIT: overrides.ripgit } : {}),
    } as unknown as KernelContext["env"],
    packages: {
      list: vi.fn(() => overrides?.packages ?? []),
    } as unknown as KernelContext["packages"],
    serverVersion: "0.0.1-test",
  } as KernelContext;

  return { ctx, auth, config, configValues, storage, usersGroup, passwd, groups };
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
      "human",
    );
    expect(usersGroup.members).toContain("alice");
    expect(config.set).toHaveBeenCalledWith("users/1000/ai/provider", "openrouter");
    expect(config.set).toHaveBeenCalledWith("users/1000/ai/model", "qwen/qwen3.5-35b-a3b");
    expect(config.set).toHaveBeenCalledWith("users/1000/ai/api_key", "or-key");
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
      "agent",
    );
    expect(auth.setPersonalAgent).toHaveBeenCalledWith(1000, 1001);
  });

  it("grants the first user access to enabled package profile agents", async () => {
    const packageRecord = {
      packageId: "import:root/wiki:.",
      scope: { kind: "global" },
      enabled: true,
      reviewRequired: false,
      reviewedAt: null,
      installedAt: 1,
      updatedAt: 1,
      artifact: {
        hash: "sha256:test",
        mainModule: "index.ts",
        modulePaths: [],
      },
      manifest: {
        name: "wiki",
        description: "wiki",
        version: "1.0.0",
        runtime: "dynamic-worker",
        source: { repo: "root/wiki", ref: "main", subdir: "." },
        entrypoints: [],
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

    const aliceAccessGroup = groups.find((group) => (
      group.name.startsWith("pkg-") && group.name.endsWith("-run")
      && group.members.includes("alice")
    ));
    const packageAgent = passwd.find((entry) => (
      aliceAccessGroup?.name === `${entry.username}-run`
    ));
    expect(packageAgent).toEqual(expect.objectContaining({
      username: expect.stringMatching(/^pkg-[0-9a-f]{28}$/),
    }));
    expect(packageAgent?.gid).toBe(packageAgent?.uid);
    expect(new Set(passwd.map((entry) => entry.uid)).size).toBe(passwd.length);
    expect(aliceAccessGroup?.members).toEqual(["alice"]);
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

  it("durably excludes a concurrent setup before bootstrap starts twice", async () => {
    let releaseBootstrap!: () => void;
    const bootstrapPending = new Promise<void>((resolve) => {
      releaseBootstrap = resolve;
    });
    handleSysBootstrapMock.mockImplementationOnce(async () => {
      await bootstrapPending;
      return undefined;
    });

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
    const configValues = new Map<string, string>();
    const first = createCtx({ configValues, ripgit });
    const restarted = createCtx({ configValues, ripgit });

    const firstSetup = handleSysSetup(
      { username: "alice", password: "password-123" },
      first.ctx,
    );

    await expect(handleSysSetup(
      { username: "bob", password: "password-456" },
      restarted.ctx,
    )).rejects.toThrow("System setup is already in progress");
    expect(handleSysBootstrapMock).toHaveBeenCalledTimes(1);
    expect(restarted.auth.addUser).not.toHaveBeenCalled();

    releaseBootstrap();
    await firstSetup;

    expect(JSON.parse(configValues.get("internal/setup/commissioning") ?? "null")).toMatchObject({
      version: 2,
      status: "completed",
      mutationStarted: true,
      username: "alice",
      uid: 1000,
    });
  });

  it("retries the same commissioning request after a transient bootstrap failure", async () => {
    handleSysBootstrapMock.mockRejectedValueOnce(new Error("bootstrap failed"));
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
    const configValues = new Map<string, string>();
    const first = createCtx({ configValues, ripgit });

    await expect(handleSysSetup(
      { username: "alice", password: "password-123" },
      first.ctx,
    )).rejects.toThrow("bootstrap failed");

    const retryableState = JSON.parse(
      configValues.get("internal/setup/commissioning") ?? "null",
    );
    expect(retryableState).toMatchObject({
      version: 2,
      status: "retryable",
      mutationStarted: false,
      username: "alice",
    });
    expect(retryableState.requestHash).toMatch(/^\$pbkdf2-sha512\$/);
    expect(JSON.stringify(retryableState)).not.toContain("password-123");
    await expect(handleSysSetup(
      { username: "alice", password: "password-123" },
      first.ctx,
    )).resolves.toMatchObject({ user: { username: "alice" } });
    expect(handleSysBootstrapMock).toHaveBeenCalledTimes(2);
  });

  it("accepts a fresh node expiry on retry while binding the device options", async () => {
    const now = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    const originalExpiry = now + 60_000;
    const refreshedExpiry = now + 180_000;
    const { ctx, auth } = createCtx();
    const provision = vi.fn()
      .mockRejectedValueOnce(new Error("user Kernel unavailable"))
      .mockResolvedValue(undefined);
    const request = {
      username: "alice",
      password: "password-123",
      node: {
        deviceId: "macbook",
        label: "Alice's Mac",
        expiresAt: originalExpiry,
      },
    };

    try {
      await expect(handleSysSetup(request, ctx, {
        provisionUserKernels: provision,
      })).rejects.toThrow("user Kernel unavailable");
      expect(JSON.parse(
        ctx.config.get("internal/setup/commissioning") ?? "null",
      )).toMatchObject({ nodeExpiryLifetimeMs: 60_000 });

      // The first absolute deadline has elapsed. A normal CLI retry computes
      // a new timestamp from the same user-selected lifetime.
      nowSpy.mockReturnValue(now + 120_000);
      await expect(handleSysSetup({
        ...request,
        node: { ...request.node, label: "Different device", expiresAt: refreshedExpiry },
      }, ctx, {
        provisionUserKernels: provision,
      })).rejects.toThrow("does not match");
      await expect(handleSysSetup({
        ...request,
        node: { deviceId: request.node.deviceId, label: request.node.label },
      }, ctx, {
        provisionUserKernels: provision,
      })).rejects.toThrow("does not match");
      await expect(handleSysSetup({
        ...request,
        node: {
          ...request.node,
          expiresAt: now + 120_000 + (24 * 60 * 60 * 1000),
        },
      }, ctx, {
        provisionUserKernels: provision,
      })).rejects.toThrow("does not match");

      await expect(handleSysSetup({
        ...request,
        node: { ...request.node, expiresAt: refreshedExpiry },
      }, ctx, {
        provisionUserKernels: provision,
      })).resolves.toMatchObject({ user: { username: "alice", uid: 1000 } });

      expect(provision).toHaveBeenCalledTimes(2);
      expect(auth.issueToken).toHaveBeenNthCalledWith(1, expect.objectContaining({
        allowedDeviceId: "macbook",
        expiresAt: originalExpiry,
      }));
      expect(auth.issueToken).toHaveBeenNthCalledWith(2, expect.objectContaining({
        allowedDeviceId: "macbook",
        expiresAt: refreshedExpiry,
      }));
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("does not claim commissioning when its first durable write fails", async () => {
    const { ctx, config, configValues } = createCtx();
    const persist = (key: string, value: string) => {
      configValues.set(key, value);
    };
    config.set
      .mockImplementationOnce(() => {
        throw new Error("commissioning state write failed");
      })
      .mockImplementation(persist);

    await expect(handleSysSetup(
      { username: "alice", password: "password-123" },
      ctx,
    )).rejects.toThrow("commissioning state write failed");
    expect(ctx.auth.addUser).not.toHaveBeenCalled();
    expect(configValues.has("internal/setup/commissioning")).toBe(false);

    await expect(handleSysSetup(
      { username: "alice", password: "password-123" },
      ctx,
    )).resolves.toMatchObject({ user: { username: "alice" } });
  });

  it("resumes after identity mutation and rejects a different commissioning request", async () => {
    const { ctx, configValues, auth } = createCtx();
    const provision = vi.fn()
      .mockRejectedValueOnce(new Error("user Kernel unavailable"))
      .mockResolvedValue(undefined);
    const request = { username: "alice", password: "password-123" };

    await expect(handleSysSetup(request, ctx, {
      provisionUserKernels: provision,
    })).rejects.toThrow("user Kernel unavailable");

    expect(auth.addUser).toHaveBeenCalledTimes(2);
    expect(JSON.parse(configValues.get("internal/setup/commissioning") ?? "null")).toMatchObject({
      status: "retryable",
      mutationStarted: true,
      username: "alice",
      uid: 1000,
    });
    await expect(handleSysSetup(
      { username: "alice", password: "different-password" },
      ctx,
      { provisionUserKernels: provision },
    )).rejects.toThrow("does not match");
    await expect(handleSysSetup(request, ctx, {
      provisionUserKernels: provision,
    })).resolves.toMatchObject({ user: { username: "alice", uid: 1000 } });
    expect(auth.addUser).toHaveBeenCalledTimes(2);
    expect(provision).toHaveBeenCalledTimes(2);
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

    expect(auth.setPassword).toHaveBeenCalledWith("root", expect.any(String));
  });
});
