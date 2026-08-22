import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KernelContext } from "../context";

const {
  handleSysBootstrapMock,
  seedBuiltinSkillsToHomeMock,
  ensurePersonalControllerMock,
  getConversationByIdMock,
} = vi.hoisted(() => ({
  handleSysBootstrapMock: vi.fn(),
  seedBuiltinSkillsToHomeMock: vi.fn(),
  ensurePersonalControllerMock: vi.fn(),
  getConversationByIdMock: vi.fn(),
}));

vi.mock("../../shared/utils", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../shared/utils")>(),
  getConversationById: getConversationByIdMock,
}));

vi.mock("./bootstrap", () => ({
  handleSysBootstrap: handleSysBootstrapMock,
}));

vi.mock("./skills-seed", () => ({
  seedBuiltinSkillsToHome: seedBuiltinSkillsToHomeMock,
}));

vi.mock("../personal-controller", () => ({
  ensurePersonalController: ensurePersonalControllerMock,
}));

import { handleSysSetup, recoverCompletedSysSetup } from "./setup";

function createCtx(overrides?: {
  setupMode?: boolean;
  ripgit?: Fetcher;
  managedInference?: boolean;
}) {
  type PasswdRow = { username: string; uid: number; gid: number; gecos: string; home: string; shell: string };
  type GroupRow = { name: string; gid: number; members: string[] };

  const usersGroup: GroupRow = { name: "users", gid: 100, members: [] };
  const passwd: PasswdRow[] = [
    { username: "root", uid: 0, gid: 0, gecos: "root", home: "/root", shell: "/bin/init" },
  ];
  const groups: GroupRow[] = [usersGroup];
  const shadowRoot = { username: "root", hash: "!" };
  const personalAgents = new Map<number, number>();
  const configValues = new Map<string, string>();
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
    authenticate: vi.fn(async (username: string, password: string) => {
      const user = passwd.find((entry) => entry.username === username);
      return user && password === "password-123"
        ? {
          ok: true as const,
          identity: {
            uid: user.uid,
            gid: user.gid,
            gids: [user.gid],
            username: user.username,
            home: user.home,
          },
        }
        : { ok: false as const, error: "Authentication failed" };
    }),
    listTokens: vi.fn(() => []),
    revokeToken: vi.fn(() => true),
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

  const storage = {
    head: vi.fn(async () => null),
    put: vi.fn(async () => {}),
  };

  const ctx = {
    installationId: "singleton",
    auth: auth as unknown as KernelContext["auth"],
    caps: caps as unknown as KernelContext["caps"],
    config: config as unknown as KernelContext["config"],
    env: {
      STORAGE: storage,
      ...(overrides?.ripgit ? { RIPGIT: overrides.ripgit } : {}),
      ...(overrides?.managedInference ? { MANAGED_INFERENCE: {} } : {}),
    } as unknown as KernelContext["env"],
    conversations: {
      ensureHome: vi.fn((ownerUid: number, handlerPid: string) => ({
        id: `conv:home:${ownerUid}`,
        ownerUid,
        kind: "home",
        title: "Home",
        handlerPid,
        latestSequence: 0,
        createdAt: 1,
        updatedAt: 1,
      })),
    } as unknown as KernelContext["conversations"],
    serverVersion: "0.0.1-test",
  } as KernelContext;

  return { ctx, auth, config, storage, usersGroup, passwd, groups };
}

describe("handleSysSetup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handleSysBootstrapMock.mockResolvedValue({
      repo: "root/gsv-manual",
      remoteUrl: "https://github.com/deathbyknowledge/gsv-manual",
      ref: "main",
      head: "manual123",
      changed: true,
    });
    seedBuiltinSkillsToHomeMock.mockResolvedValue({ username: "root", copied: 0, skipped: 0 });
    ensurePersonalControllerMock.mockResolvedValue("proc:personal");
    getConversationByIdMock.mockReturnValue({ initialize: vi.fn(async () => undefined) });
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
    expect(ensurePersonalControllerMock).toHaveBeenCalledWith(1000, ctx, undefined);
  });

  it("uses GSV included inference as the managed first-boot default", async () => {
    const { ctx, config } = createCtx({ managedInference: true });

    const result = await handleSysSetup(
      {
        username: "alice",
        password: "password-123",
      },
      ctx,
    );

    expect(config.set).toHaveBeenCalledWith("config/ai/provider", "gsv");
    expect(config.set).toHaveBeenCalledWith("config/ai/model", "default");
    expect(config.set).toHaveBeenCalledWith("config/ai/fallback_model_profile", "");
    expect(result.server.features).toEqual(["ai.provider.gsv"]);
  });

  it("keeps standalone defaults implicit when setup has no AI selection", async () => {
    const { ctx, config } = createCtx();

    await handleSysSetup(
      {
        username: "alice",
        password: "password-123",
      },
      ctx,
    );

    expect(config.set).not.toHaveBeenCalledWith("config/ai/provider", expect.anything());
    expect(config.set).not.toHaveBeenCalledWith("config/ai/model", expect.anything());
    expect(config.set).not.toHaveBeenCalledWith("config/ai/fallback_model_profile", expect.anything());
  });

  it("normalizes an explicit GSV provider without accepting a model or credential", async () => {
    const { ctx, config } = createCtx({ managedInference: true });

    await handleSysSetup(
      {
        username: "alice",
        password: "password-123",
        ai: {
          provider: "gsv",
        },
      },
      ctx,
    );

    expect(config.set).toHaveBeenCalledWith("config/ai/provider", "gsv");
    expect(config.set).toHaveBeenCalledWith("config/ai/model", "default");
    expect(config.set).not.toHaveBeenCalledWith("config/ai/api_key", expect.anything());
  });

  it("preserves an explicit bring-your-own provider on managed setup", async () => {
    const { ctx, config } = createCtx({ managedInference: true });

    await handleSysSetup(
      {
        username: "alice",
        password: "password-123",
        ai: {
          provider: "openrouter",
          model: "openai/gpt-5-mini",
          apiKey: "provider-key",
        },
      },
      ctx,
    );

    expect(config.set).toHaveBeenCalledWith("config/ai/provider", "openrouter");
    expect(config.set).toHaveBeenCalledWith("config/ai/model", "openai/gpt-5-mini");
    expect(config.set).toHaveBeenCalledWith("config/ai/api_key", "provider-key");
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
    const { ctx } = createCtx({ ripgit });

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
    expect(seedBuiltinSkillsToHomeMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ username: "root", home: "/root" }),
    );
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

  it("recovers a completed setup only for the matching credentials", async () => {
    const { ctx } = createCtx();
    await handleSysSetup({
      username: "alice",
      password: "password-123",
    }, ctx);

    await expect(recoverCompletedSysSetup({
      username: "alice",
      password: "password-123",
    }, ctx)).resolves.toMatchObject({
      user: { username: "alice" },
      server: { version: "0.0.1-test" },
    });
    await expect(recoverCompletedSysSetup({
      username: "alice",
      password: "wrong-password",
    }, ctx)).rejects.toThrow("credentials do not match");
  });
});
