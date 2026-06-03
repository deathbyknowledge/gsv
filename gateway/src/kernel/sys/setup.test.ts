import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KernelContext } from "../context";
import type { InstalledPackageRecord } from "../packages";
import { handleSysSetup } from "./setup";

function createCtx(overrides?: { setupMode?: boolean; packages?: InstalledPackageRecord[] }) {
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
    auth: auth as unknown as KernelContext["auth"],
    caps: caps as unknown as KernelContext["caps"],
    config: config as unknown as KernelContext["config"],
    env: { STORAGE: storage } as unknown as KernelContext["env"],
    packages: overrides?.packages
      ? { list: vi.fn(() => overrides.packages ?? []) } as unknown as KernelContext["packages"]
      : undefined,
  } as KernelContext;

  return { ctx, auth, config, storage, usersGroup, passwd, groups };
}

describe("handleSysSetup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
        gecos: "mira",
        home: "/home/mira",
      }),
    );
    expect(auth.setPersonalAgent).toHaveBeenCalledWith(1000, 1001);
  });

  it("grants the first user access to enabled package profile agents", async () => {
    const packageRecord = {
      packageId: "builtin:wiki@1",
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
