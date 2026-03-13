import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KernelContext } from "./context";
import { handleSysSetup } from "./sys-setup";

function createCtx(overrides?: { setupMode?: boolean }) {
  const usersGroup = { name: "users", gid: 100, members: [] as string[] };
  const passwd: Array<{ username: string; uid: number }> = [{ username: "root", uid: 0 }];
  const shadowRoot = { username: "root", hash: "!" };

  const auth = {
    isSetupMode: vi.fn(() => overrides?.setupMode ?? true),
    getPasswdEntries: vi.fn(() => passwd.map((u) => ({
      username: u.username,
      uid: u.uid,
      gid: u.uid === 0 ? 0 : 100,
      gecos: u.username,
      home: u.uid === 0 ? "/root" : `/home/${u.username}`,
      shell: "/bin/init",
    }))),
    getPasswdByUsername: vi.fn((username: string) =>
      passwd.find((u) => u.username === username)
        ? {
            username,
            uid: 1000,
            gid: 100,
            gecos: username,
            home: `/home/${username}`,
            shell: "/bin/init",
          }
        : null),
    nextUid: vi.fn(() => 1000),
    addUser: vi.fn((entry: { username: string; uid: number }) => passwd.push({
      username: entry.username,
      uid: entry.uid,
    })),
    setShadow: vi.fn(),
    getGroupByName: vi.fn((name: string) => (name === "users" ? usersGroup : null)),
    updateGroupMembers: vi.fn((name: string, members: string[]) => {
      if (name === "users") usersGroup.members = members;
      return true;
    }),
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
    resolveGids: vi.fn(() => [100]),
    getShadowByUsername: vi.fn((username: string) => (username === "root" ? shadowRoot : null)),
  };

  const config = {
    set: vi.fn(),
  };

  const storage = {
    head: vi.fn(async () => null),
    put: vi.fn(async () => {}),
  };

  const ctx = {
    auth: auth as unknown as KernelContext["auth"],
    config: config as unknown as KernelContext["config"],
    env: { STORAGE: storage } as unknown as KernelContext["env"],
  } as KernelContext;

  return { ctx, auth, config, storage, usersGroup };
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
        gid: 100,
        home: "/home/alice",
      }),
    );
    expect(usersGroup.members).toContain("alice");
    expect(config.set).toHaveBeenCalledWith("config/ai/provider", "openrouter");
    expect(config.set).toHaveBeenCalledWith("config/ai/model", "qwen/qwen3.5-35b-a3b");
    expect(config.set).toHaveBeenCalledWith("config/ai/api_key", "or-key");
    expect(storage.put).toHaveBeenCalledWith(
      "home/alice/.dir",
      expect.any(ArrayBuffer),
      expect.any(Object),
    );
    expect(result.user.username).toBe("alice");
    expect(result.nodeToken?.allowedDeviceId).toBe("macbook");
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
