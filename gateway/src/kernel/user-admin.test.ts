import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionIdentity, ProcessIdentity } from "@humansandmachines/gsv/protocol";
import type { KernelContext } from "./context";
import { handleUserAdmin } from "./user-admin";

type PasswdRow = {
  username: string;
  uid: number;
  gid: number;
  gecos: string;
  home: string;
  shell: string;
};
type GroupRow = { name: string; gid: number; members: string[] };
type CapabilityRow = { gid: number; capability: string };

function createCtx() {
  const passwd: PasswdRow[] = [
    { username: "root", uid: 0, gid: 0, gecos: "root", home: "/root", shell: "/bin/init" },
    { username: "alice", uid: 1000, gid: 1000, gecos: "Alice", home: "/home/alice", shell: "/bin/init" },
    { username: "bob", uid: 1001, gid: 1001, gecos: "Bob", home: "/home/bob", shell: "/bin/init" },
    { username: "friday", uid: 2000, gid: 2000, gecos: "Friday", home: "/home/friday", shell: "/bin/init" },
  ];
  const groups: GroupRow[] = [
    { name: "root", gid: 0, members: ["root"] },
    { name: "users", gid: 100, members: ["alice", "bob", "friday"] },
    { name: "drivers", gid: 101, members: [] },
    { name: "alice", gid: 1000, members: ["friday"] },
    { name: "bob", gid: 1001, members: [] },
    { name: "friday", gid: 2000, members: ["alice"] },
  ];
  const capabilities: CapabilityRow[] = [
    { gid: 0, capability: "*" },
    { gid: 100, capability: "fs.read" },
    { gid: 101, capability: "fs.*" },
    { gid: 1000, capability: "user.admin" },
    { gid: 1001, capability: "shell.exec" },
  ];
  const shadow = new Map([
    ["root", "root-hash"],
    ["alice", "alice-hash"],
    ["bob", "bob-hash"],
    ["friday", "!"],
  ]);

  const resolveGids = (username: string, primaryGid: number): number[] => {
    const gids = new Set([primaryGid]);
    for (const group of groups) {
      if (group.members.includes(username)) gids.add(group.gid);
    }
    return [...gids].sort((a, b) => a - b);
  };

  const auth = {
    getPasswdByUid: vi.fn((uid: number) => passwd.find((entry) => entry.uid === uid) ?? null),
    getPasswdByUsername: vi.fn(
      (username: string) => passwd.find((entry) => entry.username === username) ?? null,
    ),
    getGroupByName: vi.fn(
      (name: string) => groups.find((entry) => entry.name === name) ?? null,
    ),
    getShadowByUsername: vi.fn((username: string) => {
      const hash = shadow.get(username);
      return hash === undefined ? null : { username, hash };
    }),
    getGroupEntries: vi.fn(() => groups.map((group) => ({
      ...group,
      members: [...group.members],
    }))),
    updateGroupMembers: vi.fn((name: string, members: string[]) => {
      const group = groups.find((entry) => entry.name === name);
      if (!group) return false;
      group.members = [...members];
      return true;
    }),
    resolveGids: vi.fn(resolveGids),
    nextUid: vi.fn(),
    addUser: vi.fn(),
    setShadow: vi.fn(),
  };
  const caps = {
    list: vi.fn((gid?: number) => capabilities
      .filter((entry) => gid === undefined || entry.gid === gid)
      .map((entry) => ({ ...entry }))),
    resolve: vi.fn((gids: number[]) => [...new Set(
      capabilities
        .filter((entry) => gids.includes(entry.gid))
        .map((entry) => entry.capability),
    )]),
    grant: vi.fn((gid: number, capability: string) => {
      if (capability === "*" && gid !== 0) {
        return { ok: false, error: "The unrestricted capability is reserved for root" };
      }
      if (!capabilities.some((entry) => entry.gid === gid && entry.capability === capability)) {
        capabilities.push({ gid, capability });
      }
      return { ok: true };
    }),
    revoke: vi.fn((gid: number, capability: string) => {
      const index = capabilities.findIndex(
        (entry) => entry.gid === gid && entry.capability === capability,
      );
      if (index >= 0) capabilities.splice(index, 1);
      return { ok: true };
    }),
  };

  function transactionSync<T>(closure: () => T): T {
    const groupSnapshot = groups.map((group) => ({ ...group, members: [...group.members] }));
    const capabilitySnapshot = capabilities.map((entry) => ({ ...entry }));
    try {
      return closure();
    } catch (error) {
      groups.splice(0, groups.length, ...groupSnapshot);
      capabilities.splice(0, capabilities.length, ...capabilitySnapshot);
      throw error;
    }
  }

  function ctxFor(username: string, advertisedCapabilities?: string[]): KernelContext {
    const account = passwd.find((entry) => entry.username === username)!;
    const gids = resolveGids(account.username, account.gid);
    const process: ProcessIdentity = {
      uid: account.uid,
      gid: account.gid,
      gids,
      username: account.username,
      home: account.home,
      cwd: account.home,
    };
    const identity: ConnectionIdentity = {
      role: "user",
      process,
      capabilities: advertisedCapabilities ?? caps.resolve(gids),
    };
    return {
      identity,
      auth: auth as unknown as KernelContext["auth"],
      caps: caps as unknown as KernelContext["caps"],
      transactionSync,
    } as KernelContext;
  }

  return { ctxFor, auth, caps, groups, capabilities };
}

describe("handleUserAdmin", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows direct grants separately from effective group capabilities", async () => {
    const { ctxFor } = createCtx();

    const result = await handleUserAdmin(
      { action: "permissions", username: "bob" },
      ctxFor("alice"),
    );

    expect(result).toEqual({
      action: "permissions",
      user: { username: "bob", uid: 1001, gid: 1001 },
      groups: [
        { name: "bob", gid: 1001, primary: true },
        { name: "users", gid: 100, primary: false },
      ],
      directCapabilities: ["shell.exec"],
      effectiveCapabilities: ["fs.read", "shell.exec"],
      changed: false,
    });
  });

  it("applies one prevalidated capability and membership patch", async () => {
    const { ctxFor, groups } = createCtx();

    const result = await handleUserAdmin({
      action: "permissions",
      username: "bob",
      grant: ["net.fetch"],
      revoke: ["shell.exec"],
      addGroups: ["drivers"],
      removeGroups: ["users"],
    }, ctxFor("alice"));

    expect(result.action).toBe("permissions");
    if (result.action !== "permissions") throw new Error("unexpected result");
    expect(result.changed).toBe(true);
    expect(result.directCapabilities).toEqual(["net.fetch"]);
    expect(result.effectiveCapabilities).toEqual(["fs.*", "net.fetch"]);
    expect(groups.find((group) => group.name === "users")?.members).not.toContain("bob");
    expect(groups.find((group) => group.name === "drivers")?.members).toContain("bob");
  });

  it("denies a regular user before any mutation", async () => {
    const { ctxFor, auth, caps } = createCtx();

    await expect(handleUserAdmin({
      action: "permissions",
      username: "alice",
      grant: ["net.fetch"],
      addGroups: ["drivers"],
    }, ctxFor("bob"))).rejects.toThrow("Permission denied");

    expect(caps.grant).not.toHaveBeenCalled();
    expect(caps.revoke).not.toHaveBeenCalled();
    expect(auth.updateGroupMembers).not.toHaveBeenCalled();
  });

  it("does not let a personal agent inherit human administration", async () => {
    const { ctxFor, caps } = createCtx();
    const friday = ctxFor("friday", ["user.admin"]);

    await expect(handleUserAdmin(
      { action: "permissions", username: "bob", grant: ["net.fetch"] },
      friday,
    )).rejects.toThrow("Permission denied");
    expect(caps.grant).not.toHaveBeenCalled();
  });

  it.each([
    [{ grant: ["not valid!"] }, "Invalid capability format"],
    [{ grant: ["*"] }, "reserved for root"],
    [{ grant: ["net.fetch"], revoke: ["net.fetch"] }, "both add and remove capability"],
    [{ addGroups: ["drivers"], removeGroups: ["drivers"] }, "both add and remove group"],
    [{ addGroups: ["missing"] }, "Unknown group"],
    [{ addGroups: ["root"] }, "root group membership is immutable"],
    [{ removeGroups: ["bob"] }, "primary group membership is immutable"],
  ])("rejects an invalid patch without mutation", async (patch, message) => {
    const { ctxFor, auth, caps } = createCtx();

    await expect(handleUserAdmin({
      action: "permissions",
      username: "bob",
      ...patch,
    }, ctxFor("alice"))).rejects.toThrow(message);

    expect(caps.grant).not.toHaveBeenCalled();
    expect(caps.revoke).not.toHaveBeenCalled();
    expect(auth.updateGroupMembers).not.toHaveBeenCalled();
  });

  it("keeps root permissions immutable", async () => {
    const { ctxFor, auth, caps } = createCtx();

    await expect(handleUserAdmin({
      action: "permissions",
      username: "root",
      revoke: ["*"],
    }, ctxFor("alice"))).rejects.toThrow("root permissions are immutable");

    expect(caps.revoke).not.toHaveBeenCalled();
    expect(auth.updateGroupMembers).not.toHaveBeenCalled();
  });

  it("allows an administrator to revoke a corrupt non-root wildcard", async () => {
    const { ctxFor, capabilities } = createCtx();
    capabilities.push({ gid: 1001, capability: "*" });

    const result = await handleUserAdmin({
      action: "permissions",
      username: "bob",
      revoke: ["*"],
    }, ctxFor("alice"));

    expect(result.action).toBe("permissions");
    if (result.action !== "permissions") throw new Error("unexpected result");
    expect(result.directCapabilities).not.toContain("*");
    expect(result.changed).toBe(true);
  });

  it("rolls back the whole permission patch when a later write fails", async () => {
    const { ctxFor, auth, groups, capabilities } = createCtx();
    const originalGroups = structuredClone(groups);
    const originalCapabilities = structuredClone(capabilities);
    auth.updateGroupMembers.mockImplementationOnce(() => {
      throw new Error("injected group write failure");
    });

    await expect(handleUserAdmin({
      action: "permissions",
      username: "bob",
      grant: ["net.fetch"],
      addGroups: ["drivers"],
    }, ctxFor("alice"))).rejects.toThrow("injected group write failure");

    expect(groups).toEqual(originalGroups);
    expect(capabilities).toEqual(originalCapabilities);
  });

  it("rechecks delegated authority from durable state", async () => {
    const { ctxFor, capabilities, caps } = createCtx();
    const staleIdentity = ctxFor("alice", ["user.admin"]);
    capabilities.splice(
      capabilities.findIndex((entry) => entry.gid === 1000 && entry.capability === "user.admin"),
      1,
    );

    await expect(handleUserAdmin(
      { action: "permissions", username: "bob", grant: ["net.fetch"] },
      staleIdentity,
    )).rejects.toThrow("Permission denied");
    expect(caps.grant).not.toHaveBeenCalled();
  });

  it("checks authority before dispatching account creation", async () => {
    const { ctxFor, auth } = createCtx();

    await expect(handleUserAdmin({
      action: "create",
      username: "carol",
      password: "password-123",
    }, ctxFor("bob"))).rejects.toThrow("Permission denied");

    expect(auth.nextUid).not.toHaveBeenCalled();
    expect(auth.addUser).not.toHaveBeenCalled();
    expect(auth.setShadow).not.toHaveBeenCalled();
  });

  it("requires a password before creating a human account", async () => {
    const { ctxFor, auth } = createCtx();

    await expect(handleUserAdmin({
      action: "create",
      username: "carol",
    } as never, ctxFor("alice"))).rejects.toThrow("password must be at least 8 characters");

    expect(auth.nextUid).not.toHaveBeenCalled();
    expect(auth.addUser).not.toHaveBeenCalled();
    expect(auth.setShadow).not.toHaveBeenCalled();
  });
});
