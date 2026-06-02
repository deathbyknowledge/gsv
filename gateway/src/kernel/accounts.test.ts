import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KernelContext } from "./context";
import type { ConnectionIdentity, ProcessIdentity } from "@gsv/protocol/syscalls/system";
import { handleAccountCreate, handleAccountList } from "./agents";

type PasswdRow = { username: string; uid: number; gid: number; gecos: string; home: string; shell: string };
type GroupRow = { name: string; gid: number; members: string[] };

function createCtx() {
  const passwd: PasswdRow[] = [
    { username: "root", uid: 0, gid: 0, gecos: "root", home: "/root", shell: "/bin/init" },
    { username: "alice", uid: 1000, gid: 1000, gecos: "alice", home: "/home/alice", shell: "/bin/init" },
  ];
  const groups: GroupRow[] = [
    { name: "users", gid: 100, members: ["alice"] },
    { name: "alice", gid: 1000, members: [] },
  ];
  const shadow = new Map<string, string>([["root", "x"], ["alice", "x"]]);
  const personalAgents = new Map<number, number>();

  const auth = {
    getPasswdByUsername: vi.fn((username: string) => {
      const found = passwd.find((u) => u.username === username);
      return found ? { ...found } : null;
    }),
    getPasswdByUid: vi.fn((uid: number) => {
      const found = passwd.find((u) => u.uid === uid);
      return found ? { ...found } : null;
    }),
    nextUid: vi.fn(() => Math.max(999, ...passwd.map((u) => u.uid)) + 1),
    addUser: vi.fn((entry: PasswdRow) => {
      passwd.push({ ...entry, gecos: entry.gecos ?? entry.username, shell: entry.shell ?? "/bin/init" });
    }),
    setShadow: vi.fn((entry: { username: string; hash: string }) => {
      shadow.set(entry.username, entry.hash);
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
    resolveGids: vi.fn((username: string, primaryGid: number) => {
      const gids = new Set<number>([primaryGid]);
      for (const g of groups) if (g.members.includes(username)) gids.add(g.gid);
      return [...gids].sort((a, b) => a - b);
    }),
    getPersonalAgentUid: vi.fn((ownerUid: number) => personalAgents.get(ownerUid) ?? null),
    setPersonalAgent: vi.fn((ownerUid: number, agentUid: number) => {
      personalAgents.set(ownerUid, agentUid);
    }),
    isPersonalAgentUid: vi.fn((uid: number) => [...personalAgents.values()].includes(uid)),
    getPasswdEntries: vi.fn(() => passwd.map((u) => ({ ...u }))),
    getShadowByUsername: vi.fn((username: string) => {
      const hash = shadow.get(username);
      return hash === undefined ? null : { username, hash };
    }),
  };

  const storage = {
    head: vi.fn(async () => null),
    put: vi.fn(async () => {}),
  };

  function ctxFor(identity: ConnectionIdentity): KernelContext {
    return {
      auth: auth as unknown as KernelContext["auth"],
      env: { STORAGE: storage } as unknown as KernelContext["env"],
      identity,
    } as KernelContext;
  }

  return { ctxFor, auth, passwd, groups, shadow, personalAgents };
}

function userIdentity(uid: number, username: string, capabilities: string[]): ConnectionIdentity {
  const process: ProcessIdentity = {
    uid,
    gid: uid,
    gids: [uid, 100],
    username,
    home: `/home/${username}`,
    cwd: `/home/${username}`,
  };
  return { role: "user", process, capabilities };
}

describe("handleAccountCreate", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates an agent owned by the caller, locked and cross-membered", async () => {
    const { ctxFor, auth, groups, shadow } = createCtx();
    const ctx = ctxFor(userIdentity(1000, "alice", ["account.create"]));

    const result = await handleAccountCreate({ kind: "agent", username: "scout" }, ctx);

    expect(result.kind).toBe("agent");
    expect(result.account.username).toBe("scout");
    // User Private Group: gid = uid.
    expect(result.account.gid).toBe(result.account.uid);
    // Locked shadow (no login).
    expect(shadow.get("scout")).toBe("!");
    // Joined users for standard caps.
    expect(groups.find((g) => g.name === "users")?.members).toContain("scout");
    // Cross-membership: owner can act as agent (alice in scout's group) and
    // agent can act on owner's files (scout in alice's group).
    expect(groups.find((g) => g.name === "scout")?.members).toContain("alice");
    expect(groups.find((g) => g.name === "alice")?.members).toContain("scout");
    expect(auth.addUser).toHaveBeenCalledWith(
      expect.objectContaining({ username: "scout", shell: "/bin/init" }),
    );
  });

  it("rejects a duplicate or invalid username", async () => {
    const { ctxFor } = createCtx();
    const ctx = ctxFor(userIdentity(1000, "alice", ["account.create"]));

    await expect(handleAccountCreate({ kind: "agent", username: "alice" }, ctx)).rejects.toThrow(
      /unavailable/i,
    );
    await expect(handleAccountCreate({ kind: "agent", username: "Bad Name" }, ctx)).rejects.toThrow(
      /unavailable|invalid/i,
    );
  });

  it("requires root to create a human account", async () => {
    const { ctxFor } = createCtx();
    const ctx = ctxFor(userIdentity(1000, "alice", ["account.create"]));

    await expect(
      handleAccountCreate({ kind: "human", username: "bob", password: "password-123" }, ctx),
    ).rejects.toThrow(/root/i);
  });

  it("creates a human (root) with login and a personal agent", async () => {
    const { ctxFor, shadow, groups, personalAgents } = createCtx();
    const ctx = ctxFor(userIdentity(0, "root", ["*"]));

    const result = await handleAccountCreate(
      { kind: "human", username: "bob", password: "password-123" },
      ctx,
    );

    expect(result.kind).toBe("human");
    expect(result.account.username).toBe("bob");
    expect(result.account.gid).toBe(result.account.uid);
    // Human can log in (hashed, not locked).
    expect(shadow.get("bob")).toBeTruthy();
    expect(shadow.get("bob")).not.toBe("!");
    expect(groups.find((g) => g.name === "users")?.members).toContain("bob");
    // A 1:1 personal agent was provisioned and mapped to the human.
    expect(result.personalAgent).toBeTruthy();
    expect(personalAgents.get(result.account.uid)).toBe(result.personalAgent?.uid);
  });
});

describe("handleAccountList", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lists the caller's self and run-as-able agents, not other humans", async () => {
    const { ctxFor } = createCtx();
    // alice creates a custom agent she can run as.
    const aliceCtx = ctxFor(userIdentity(1000, "alice", ["account.create"]));
    await handleAccountCreate({ kind: "agent", username: "scout" }, aliceCtx);

    const result = handleAccountList({}, ctxFor(userIdentity(1000, "alice", ["account.list"])));
    const names = result.accounts.map((a) => a.username);

    expect(names).toContain("alice");
    expect(names).toContain("scout");
    // root is a system account and never a run-as target.
    expect(names).not.toContain("root");

    const self = result.accounts.find((a) => a.username === "alice");
    expect(self?.relation).toBe("self");
    const agent = result.accounts.find((a) => a.username === "scout");
    expect(agent?.relation).toBe("agent");
    expect(agent?.runnable).toBe(true);
    // "self" sorts first.
    expect(result.accounts[0].relation).toBe("self");
  });
});
