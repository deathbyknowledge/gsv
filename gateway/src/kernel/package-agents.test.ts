import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KernelContext } from "./context";
import type { InstalledPackageRecord } from "./packages";
import {
  ensurePackageAgent,
  packageAgentAccessGroup,
  packageAgentUsername,
  resolvePackageAgentRunAs,
  revokePackageAgentAccess,
} from "./package-agents";

type PasswdRow = { username: string; uid: number; gid: number; gecos: string; home: string; shell: string };
type GroupRow = { name: string; gid: number; members: string[] };

function createCtx() {
  const passwd: PasswdRow[] = [
    { username: "root", uid: 0, gid: 0, gecos: "root", home: "/root", shell: "/bin/init" },
    { username: "alice", uid: 1000, gid: 1000, gecos: "alice", home: "/home/alice", shell: "/bin/init" },
    { username: "bob", uid: 1001, gid: 1001, gecos: "bob", home: "/home/bob", shell: "/bin/init" },
  ];
  const groups: GroupRow[] = [
    { name: "users", gid: 100, members: ["alice", "bob"] },
    { name: "alice", gid: 1000, members: [] },
    { name: "bob", gid: 1001, members: [] },
  ];
  const shadow = new Map<string, string>([["root", "x"], ["alice", "x"], ["bob", "x"]]);
  const config = new Map<string, string>();
  const capsTable: { gid: number; capability: string }[] = [];

  const maxId = () => Math.max(0, ...passwd.map((u) => u.uid), ...groups.map((g) => g.gid));

  const auth = {
    getPasswdByUsername: vi.fn((username: string) => passwd.find((u) => u.username === username) ?? null),
    getPasswdByUid: vi.fn((uid: number) => passwd.find((u) => u.uid === uid) ?? null),
    nextUid: vi.fn(() => Math.max(999, maxId()) + 1),
    nextGid: vi.fn(() => Math.max(99, maxId()) + 1),
    addUser: vi.fn((entry: PasswdRow) => {
      passwd.push({ ...entry, gecos: entry.gecos ?? entry.username, shell: entry.shell ?? "/bin/init" });
    }),
    setShadow: vi.fn((entry: { username: string; hash: string }) => shadow.set(entry.username, entry.hash)),
    getGroupByName: vi.fn((name: string) => {
      const g = groups.find((x) => x.name === name);
      return g ? { ...g, members: [...g.members] } : null;
    }),
    getGroupByGid: vi.fn((gid: number) => {
      const g = groups.find((x) => x.gid === gid);
      return g ? { ...g, members: [...g.members] } : null;
    }),
    addGroup: vi.fn((entry: GroupRow) => groups.push({ ...entry, members: [...entry.members] })),
    updateGroupMembers: vi.fn((name: string, members: string[]) => {
      const g = groups.find((x) => x.name === name);
      if (g) g.members = members;
      return true;
    }),
    resolveGids: vi.fn((username: string, primaryGid: number) => {
      const gids = new Set<number>([primaryGid]);
      for (const g of groups) if (g.members.includes(username)) gids.add(g.gid);
      return [...gids].sort((a, b) => a - b);
    }),
    setPersonalAgent: vi.fn(),
  };

  const caps = {
    grant: vi.fn((gid: number, capability: string) => {
      capsTable.push({ gid, capability });
      return { ok: true };
    }),
    resolve: vi.fn((gids: number[]) =>
      [...new Set(capsTable.filter((c) => gids.includes(c.gid)).map((c) => c.capability))],
    ),
  };

  const ctx = {
    auth: auth as unknown as KernelContext["auth"],
    caps: caps as unknown as KernelContext["caps"],
    config: {
      set: vi.fn((key: string, value: string) => config.set(key, value)),
      get: vi.fn((key: string) => config.get(key) ?? null),
    } as unknown as KernelContext["config"],
    // STORAGE stub satisfies home layout; no RIPGIT so context seeding no-ops.
    env: { STORAGE: { head: vi.fn(async () => null), put: vi.fn(async () => {}) } } as unknown as KernelContext["env"],
    identity: { role: "user", process: { uid: 1000, gid: 1000, gids: [1000, 100], username: "alice", home: "/home/alice", cwd: "/home/alice" }, capabilities: ["*"] },
  } as unknown as KernelContext;

  return { ctx, auth, groups, passwd, shadow, config, capsTable, caps };
}

function record(profiles: InstalledPackageRecord["manifest"]["profiles"]): InstalledPackageRecord {
  return {
    packageId: "builtin:wiki@1",
    scope: { kind: "global" },
    manifest: { name: "wiki", profiles } as InstalledPackageRecord["manifest"],
  } as InstalledPackageRecord;
}

const BUILDER = {
  name: "builder",
  displayName: "Wiki Builder",
  contextFiles: [{ name: "00-role.md", text: "You build the wiki." }],
  approvalPolicy: '{"rules":[]}',
  capabilities: ["repo.write", "fs.read"],
};

describe("ensurePackageAgent", () => {
  beforeEach(() => vi.clearAllMocks());

  it("provisions a locked, least-privilege agent with caps on its own gid", async () => {
    const { ctx, groups, shadow, caps, config } = createCtx();
    const identity = await ensurePackageAgent(ctx, record([BUILDER]), BUILDER, 1000);

    const username = packageAgentUsername("wiki", "builder");
    expect(identity.username).toBe(username);
    // Locked (no login) and gid = uid (UPG).
    expect(shadow.get(username)).toBe("!");
    expect(identity.gid).toBe(identity.uid);
    // Least privilege: NOT a member of users(100).
    expect(groups.find((g) => g.name === "users")?.members).not.toContain(username);
    // Declared caps live on the agent's own gid.
    expect(caps.grant).toHaveBeenCalledWith(identity.gid, "repo.write");
    expect(caps.grant).toHaveBeenCalledWith(identity.gid, "fs.read");
    // Approval policy stored per-account.
    expect(config.get(`users/${identity.uid}/ai/tools/approval`)).toBe('{"rules":[]}');
  });

  it("grants run-as via the access group without leaking caps to the human", async () => {
    const { ctx, groups, caps } = createCtx();
    const identity = await ensurePackageAgent(ctx, record([BUILDER]), BUILDER, 1000);

    const accessGroup = packageAgentAccessGroup(identity.username);
    // The enabling human joins the access group...
    expect(groups.find((g) => g.name === accessGroup)?.members).toContain("alice");
    // ...which carries NO capabilities, and is NOT the cap gid.
    const accessGid = groups.find((g) => g.name === accessGroup)!.gid;
    expect(accessGid).not.toBe(identity.gid);
    expect(caps.resolve([accessGid])).toEqual([]);
    // The human's own gids never include the agent's cap gid, so caps don't leak.
    const aliceGids = ctx.auth.resolveGids("alice", 1000);
    expect(aliceGids).not.toContain(identity.gid);
  });

  it("is idempotent across enabling humans (one shared account)", async () => {
    const { ctx, passwd, groups } = createCtx();
    const first = await ensurePackageAgent(ctx, record([BUILDER]), BUILDER, 1000);
    const before = passwd.length;
    const second = await ensurePackageAgent(ctx, record([BUILDER]), BUILDER, 1001);

    expect(second.uid).toBe(first.uid);
    expect(passwd.length).toBe(before); // no second account
    const accessGroup = packageAgentAccessGroup(first.username);
    expect(groups.find((g) => g.name === accessGroup)?.members).toEqual(["alice", "bob"]);
  });
});

describe("resolvePackageAgentRunAs", () => {
  beforeEach(() => vi.clearAllMocks());

  it("authorizes a human in the access group and rejects others", async () => {
    const { ctx } = createCtx();
    const agent = await ensurePackageAgent(ctx, record([BUILDER]), BUILDER, 1000);

    const ok = resolvePackageAgentRunAs(ctx, "wiki#builder", 1000, false);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.identity.uid).toBe(agent.uid);

    // bob never enabled the package -> not in the access group.
    const denied = resolvePackageAgentRunAs(ctx, "wiki#builder", 1001, false);
    expect(denied.ok).toBe(false);

    // root bypasses.
    expect(resolvePackageAgentRunAs(ctx, "wiki#builder", 1001, true).ok).toBe(true);
  });

  it("fails when the package agent is not provisioned", () => {
    const { ctx } = createCtx();
    const res = resolvePackageAgentRunAs(ctx, "wiki#builder", 1000, false);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/not provisioned/);
  });
});

describe("revokePackageAgentAccess", () => {
  beforeEach(() => vi.clearAllMocks());

  it("removes the human from the access group on disable", async () => {
    const { ctx, groups } = createCtx();
    await ensurePackageAgent(ctx, record([BUILDER]), BUILDER, 1000);
    revokePackageAgentAccess(ctx, record([BUILDER]), 1000);

    const accessGroup = packageAgentAccessGroup(packageAgentUsername("wiki", "builder"));
    expect(groups.find((g) => g.name === accessGroup)?.members).not.toContain("alice");
  });
});
