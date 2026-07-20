import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KernelContext } from "./context";
import type { InstalledPackageRecord, PackageInstallScope } from "./packages";
import {
  ensurePackageAgent,
  findPackageAgentAccount,
  packageAgentAccessGroup,
  packageAgentRuntimeIdentity,
  reconcilePackageAgentEntitlements,
  resolvePackageAgentRunAs,
} from "./package-agents";
import { createProvisioningR2BucketMock } from "../test-support/mock-r2";

type PasswdRow = {
  username: string;
  uid: number;
  gid: number;
  gecos: string;
  home: string;
  shell: string;
};
type GroupRow = { name: string; gid: number; members: string[] };

const BUILDER = {
  name: "builder",
  displayName: "Wiki Builder",
  contextFiles: [{ name: "00-role.md", text: "You build the wiki." }],
  approvalPolicy: '{"rules":[]}',
  capabilities: ["repo.write", "fs.read"],
};

function record(
  scope: PackageInstallScope = { kind: "global" },
  profiles: InstalledPackageRecord["manifest"]["profiles"] = [BUILDER],
): InstalledPackageRecord {
  return {
    packageId: "import:root/wiki:.",
    scope,
    enabled: true,
    reviewRequired: false,
    reviewedAt: null,
    installedAt: 1,
    updatedAt: 1,
    artifact: { hash: "sha256:test", mainModule: "index.ts", modulePaths: [] },
    manifest: {
      name: "wiki",
      description: "wiki",
      version: "1.0.0",
      runtime: "dynamic-worker",
      source: { repo: "root/wiki", ref: "main", subdir: "." },
      entrypoints: [],
      profiles,
    },
  };
}

function createCtx() {
  const passwd: PasswdRow[] = [
    { username: "root", uid: 0, gid: 0, gecos: "root", home: "/root", shell: "/bin/init" },
    { username: "alice", uid: 1000, gid: 1000, gecos: "Alice", home: "/home/alice", shell: "/bin/init" },
    { username: "bob", uid: 1001, gid: 1001, gecos: "Bob", home: "/home/bob", shell: "/bin/init" },
  ];
  const accountKinds = new Map<string, "system" | "human" | "agent">([
    ["root", "system"],
    ["alice", "human"],
    ["bob", "human"],
  ]);
  const reserved = new Set(passwd.map((entry) => entry.username));
  const groups: GroupRow[] = [
    { name: "users", gid: 100, members: ["alice", "bob"] },
    { name: "alice", gid: 1000, members: [] },
    { name: "bob", gid: 1001, members: [] },
  ];
  const shadow = new Map<string, string>([["root", "x"], ["alice", "x"], ["bob", "x"]]);
  const config = new Map<string, string>();
  const capsTable: { gid: number; capability: string }[] = [];
  const packageRecords: InstalledPackageRecord[] = [];
  const maxId = () => Math.max(0, ...passwd.map((entry) => entry.uid), ...groups.map((entry) => entry.gid));

  const auth = {
    isAccountNameReserved: vi.fn((username: string) => reserved.has(username)),
    getPasswdEntries: vi.fn(() => passwd.map((entry) => ({ ...entry }))),
    getPasswdByUsername: vi.fn((username: string) => passwd.find((entry) => entry.username === username) ?? null),
    getPasswdByUid: vi.fn((uid: number) => passwd.find((entry) => entry.uid === uid) ?? null),
    getAccountIdentity: vi.fn((username: string) => {
      const entry = passwd.find((candidate) => candidate.username === username);
      const kind = accountKinds.get(username);
      return entry && kind
        ? { username, uid: entry.uid, kind, state: "active" as const }
        : null;
    }),
    allocateUid: vi.fn(() => Math.max(999, maxId()) + 1),
    allocateGid: vi.fn(() => Math.max(99, maxId()) + 1),
    addUser: vi.fn((entry: PasswdRow, kind: "system" | "human" | "agent") => {
      passwd.push({ ...entry, gecos: entry.gecos ?? entry.username, shell: entry.shell ?? "/bin/init" });
      accountKinds.set(entry.username, kind);
      reserved.add(entry.username);
    }),
    setShadow: vi.fn((entry: { username: string; hash: string }) => shadow.set(entry.username, entry.hash)),
    getGroupByName: vi.fn((name: string) => {
      const group = groups.find((entry) => entry.name === name);
      return group ? { ...group, members: [...group.members] } : null;
    }),
    getGroupByGid: vi.fn((gid: number) => {
      const group = groups.find((entry) => entry.gid === gid);
      return group ? { ...group, members: [...group.members] } : null;
    }),
    addGroup: vi.fn((entry: GroupRow) => groups.push({ ...entry, members: [...entry.members] })),
    updateGroupMembers: vi.fn((name: string, members: string[]) => {
      const group = groups.find((entry) => entry.name === name);
      if (group) group.members = [...members];
      return Boolean(group);
    }),
    resolveGids: vi.fn((username: string, primaryGid: number) => {
      const gids = new Set([primaryGid]);
      for (const group of groups) if (group.members.includes(username)) gids.add(group.gid);
      return [...gids].sort((left, right) => left - right);
    }),
    setPersonalAgent: vi.fn(),
    getPersonalAgentUid: vi.fn(() => null),
  };
  const caps = {
    grant: vi.fn((gid: number, capability: string) => {
      if (!capsTable.some((row) => row.gid === gid && row.capability === capability)) {
        capsTable.push({ gid, capability });
      }
      return { ok: true };
    }),
    revoke: vi.fn((gid: number, capability: string) => {
      const index = capsTable.findIndex((row) => row.gid === gid && row.capability === capability);
      if (index >= 0) capsTable.splice(index, 1);
      return { ok: index >= 0 };
    }),
    list: vi.fn((gid?: number) => capsTable.filter((row) => gid === undefined || row.gid === gid)),
    resolve: vi.fn((gids: number[]) => [...new Set(
      capsTable.filter((row) => gids.includes(row.gid)).map((row) => row.capability),
    )]),
  };
  const packages = {
    list: vi.fn((options?: { scopes?: PackageInstallScope[] }) => {
      if (!options?.scopes) return packageRecords;
      const keys = new Set(options.scopes.map(scopeString));
      return packageRecords.filter((entry) => keys.has(scopeString(entry.scope)));
    }),
    resolve: vi.fn((packageId: string, scopes: PackageInstallScope[]) => {
      for (const scope of scopes) {
        const found = packageRecords.find((entry) => (
          entry.packageId === packageId && scopeString(entry.scope) === scopeString(scope)
        ));
        if (found) return found;
      }
      return null;
    }),
  };
  const storage = createProvisioningR2BucketMock();
  const ctx = {
    auth,
    caps,
    config: {
      get: vi.fn((key: string) => config.get(key) ?? null),
      set: vi.fn((key: string, value: string) => config.set(key, value)),
      delete: vi.fn((key: string) => config.delete(key)),
    },
    packages,
    env: { STORAGE: storage },
    identity: {
      role: "user",
      process: {
        uid: 1000,
        gid: 1000,
        gids: [100, 1000],
        username: "alice",
        home: "/home/alice",
        cwd: "/home/alice",
      },
      capabilities: ["*"],
    },
  } as unknown as KernelContext;

  return { ctx, passwd, accountKinds, reserved, groups, shadow, config, capsTable, packageRecords, storage };
}

function scopeString(scope: PackageInstallScope): string {
  return scope.kind === "global" ? "global" : `user:${scope.uid}`;
}

describe("scope-specific package agents", () => {
  beforeEach(() => vi.clearAllMocks());

  it("allocates a locked opaque principal with profile authority and display metadata", async () => {
    const { ctx, shadow, capsTable, packageRecords } = createCtx();
    const pkg = record({ kind: "user", uid: 1000 });
    packageRecords.push(pkg);

    const identity = await ensurePackageAgent(ctx, pkg, BUILDER, 1000);

    expect(identity.username).toMatch(/^pkg-[0-9a-f]{28}$/);
    expect(identity.username).toHaveLength(32);
    expect(shadow.get(identity.username)).toBe("!");
    expect(ctx.auth.getPasswdByUid(identity.uid)?.gecos).toBe("Wiki Builder");
    expect(capsTable.filter((row) => row.gid === identity.gid).map((row) => row.capability).sort())
      .toEqual(["fs.read", "repo.write"]);
    expect(ctx.config.get(`users/${identity.uid}/pkg/scope`)).toBe("user:1000");
  });

  it("never aliases package-agent identity across humans or install scopes", async () => {
    const { ctx, groups, packageRecords } = createCtx();
    const global = record({ kind: "global" });
    const personal = record({ kind: "user", uid: 1000 });
    packageRecords.push(global, personal);

    await reconcilePackageAgentEntitlements(ctx);
    const globalAlice = findPackageAgentAccount(ctx, global, BUILDER, 1000)!;
    const globalBob = findPackageAgentAccount(ctx, global, BUILDER, 1001)!;
    const personalAgent = findPackageAgentAccount(ctx, personal, BUILDER, 1000)!;

    expect(new Set([globalAlice.uid, globalBob.uid, personalAgent.uid]).size).toBe(3);
    expect(new Set([globalAlice.username, globalBob.username, personalAgent.username]).size).toBe(3);
    expect(new Set([globalAlice.home, globalBob.home, personalAgent.home]).size).toBe(3);
    expect(groups.find((group) => group.name === packageAgentAccessGroup(globalAlice.username))?.members)
      .toEqual(["alice"]);
    expect(groups.find((group) => group.name === packageAgentAccessGroup(globalBob.username))?.members)
      .toEqual(["bob"]);
    expect(groups.find((group) => group.name === packageAgentAccessGroup(personalAgent.username))?.members)
      .toEqual(["alice"]);
  });

  it("provisions and resolves a distinct global package agent for root", async () => {
    const { ctx, groups, packageRecords } = createCtx();
    const pkg = record({ kind: "global" });
    packageRecords.push(pkg);

    await reconcilePackageAgentEntitlements(ctx);
    const rootAgent = findPackageAgentAccount(ctx, pkg, BUILDER, 0)!;
    const aliceAgent = findPackageAgentAccount(ctx, pkg, BUILDER, 1000)!;

    expect(rootAgent.uid).not.toBe(aliceAgent.uid);
    expect(rootAgent.home).not.toBe(aliceAgent.home);
    expect(groups.find((group) => group.name === packageAgentAccessGroup(rootAgent.username))?.members)
      .toEqual(["root"]);
    expect(resolvePackageAgentRunAs(ctx, `${pkg.packageId}#builder`, 0, true)).toMatchObject({
      ok: true,
      identity: { uid: rootAgent.uid, username: rootAgent.username },
    });
  });

  it("classifies any partial package stamp as invalid", () => {
    const { ctx } = createCtx();
    ctx.config.set("users/1234/pkg/scope", "global");

    expect(packageAgentRuntimeIdentity(ctx, 1234)).toEqual({ kind: "invalid" });
  });

  it("adds a newly activated human to every active global package entitlement", async () => {
    const { ctx, passwd, accountKinds, reserved, groups, packageRecords } = createCtx();
    const pkg = record({ kind: "global" });
    packageRecords.push(pkg);
    await reconcilePackageAgentEntitlements(ctx);
    const aliceAgent = findPackageAgentAccount(ctx, pkg, BUILDER, 1000)!;

    const carolUid = Math.max(...passwd.map((entry) => entry.uid)) + 1;
    passwd.push({
      username: "carol",
      uid: carolUid,
      gid: carolUid,
      gecos: "Carol",
      home: "/home/carol",
      shell: "/bin/init",
    });
    accountKinds.set("carol", "human");
    reserved.add("carol");
    groups.push({ name: "carol", gid: carolUid, members: [] });
    await reconcilePackageAgentEntitlements(ctx);

    const carolAgent = findPackageAgentAccount(ctx, pkg, BUILDER, carolUid)!;
    expect(carolAgent.uid).not.toBe(aliceAgent.uid);
    expect(carolAgent.home).not.toBe(aliceAgent.home);
    expect(groups.find((group) => group.name === packageAgentAccessGroup(aliceAgent.username))?.members)
      .toEqual(["alice"]);
    expect(groups.find((group) => group.name === packageAgentAccessGroup(carolAgent.username))?.members)
      .toEqual(["carol"]);
  });

  it("revokes access, capabilities, approval, and run-as when a package is disabled", async () => {
    const { ctx, groups, capsTable, config, packageRecords } = createCtx();
    const pkg = record({ kind: "user", uid: 1000 });
    packageRecords.push(pkg);
    await reconcilePackageAgentEntitlements(ctx);
    const agent = findPackageAgentAccount(ctx, pkg, BUILDER, 1000)!;

    packageRecords[0] = { ...pkg, enabled: false };
    await reconcilePackageAgentEntitlements(ctx);

    expect(groups.find((group) => group.name === packageAgentAccessGroup(agent.username))?.members).toEqual([]);
    expect(capsTable.filter((row) => row.gid === agent.gid)).toEqual([]);
    expect(config.has(`users/${agent.uid}/ai/tools/approval`)).toBe(false);
    expect(resolvePackageAgentRunAs(ctx, `${pkg.packageId}#builder`, 1000, false).ok).toBe(false);
  });

  it("deactivates a removed profile and provisions a distinct identity for its replacement", async () => {
    const { ctx, groups, capsTable, packageRecords } = createCtx();
    const pkg = record({ kind: "user", uid: 1000 });
    packageRecords.push(pkg);
    await reconcilePackageAgentEntitlements(ctx);
    const previous = findPackageAgentAccount(ctx, pkg, BUILDER, 1000)!;
    const replacement = { ...BUILDER, name: "editor", capabilities: ["fs.write"] };
    const updated = record({ kind: "user", uid: 1000 }, [replacement]);
    packageRecords[0] = updated;

    await reconcilePackageAgentEntitlements(ctx);
    const next = findPackageAgentAccount(ctx, updated, replacement, 1000)!;

    expect(next.uid).not.toBe(previous.uid);
    expect(groups.find((group) => group.name === packageAgentAccessGroup(previous.username))?.members).toEqual([]);
    expect(capsTable.filter((row) => row.gid === previous.gid)).toEqual([]);
    expect(capsTable.filter((row) => row.gid === next.gid).map((row) => row.capability)).toEqual(["fs.write"]);
  });

  it("reconciles security surface updates in place only within the same exact scope tuple", async () => {
    const { ctx, capsTable, config, packageRecords } = createCtx();
    const pkg = record({ kind: "user", uid: 1000 });
    packageRecords.push(pkg);
    await reconcilePackageAgentEntitlements(ctx);
    const before = findPackageAgentAccount(ctx, pkg, BUILDER, 1000)!;
    const updatedProfile = {
      ...BUILDER,
      approvalPolicy: undefined,
      capabilities: ["fs.write"],
      contextFiles: [{ name: "00-role.md", text: "You edit the wiki." }],
    };
    const updated = record({ kind: "user", uid: 1000 }, [updatedProfile]);
    packageRecords[0] = updated;

    await reconcilePackageAgentEntitlements(ctx);
    const after = findPackageAgentAccount(ctx, updated, updatedProfile, 1000)!;

    expect(after.uid).toBe(before.uid);
    expect(capsTable.filter((row) => row.gid === after.gid).map((row) => row.capability)).toEqual(["fs.write"]);
    expect(config.has(`users/${after.uid}/ai/tools/approval`)).toBe(false);
  });

  it("requires an enabled, reviewed record and current access membership at run-as time", async () => {
    const { ctx, groups, packageRecords } = createCtx();
    const pkg = { ...record({ kind: "user", uid: 1000 }), reviewRequired: true, reviewedAt: 1 };
    packageRecords.push(pkg);
    await reconcilePackageAgentEntitlements(ctx);
    expect(resolvePackageAgentRunAs(ctx, `${pkg.packageId}#builder`, 1000, false).ok).toBe(true);

    const agent = findPackageAgentAccount(ctx, pkg, BUILDER, 1000)!;
    ctx.auth.updateGroupMembers(packageAgentAccessGroup(agent.username), []);
    expect(resolvePackageAgentRunAs(ctx, `${pkg.packageId}#builder`, 1000, false).ok).toBe(false);

    groups.find((group) => group.name === packageAgentAccessGroup(agent.username))!.members = ["alice"];
    packageRecords[0] = { ...pkg, reviewedAt: null };
    expect(resolvePackageAgentRunAs(ctx, `${pkg.packageId}#builder`, 1000, false).ok).toBe(false);
  });

  it("rejects wildcard package-agent authority before reserving an account", async () => {
    const { ctx, passwd } = createCtx();
    const privileged = { ...BUILDER, capabilities: ["*"] };
    const pkg = record({ kind: "user", uid: 1000 }, [privileged]);

    await expect(ensurePackageAgent(ctx, pkg, privileged)).rejects.toThrow("Wildcard capability is reserved for root");
    expect(passwd.some((entry) => entry.username.startsWith("pkg-"))).toBe(false);
  });

  it("recovers the same reserved principal after home seeding fails", async () => {
    const { ctx, passwd, packageRecords, storage } = createCtx();
    const pkg = record({ kind: "user", uid: 1000 });
    packageRecords.push(pkg);
    const originalPut = storage.put.bind(storage);
    let failOnce = true;
    storage.put = vi.fn(async (...args: Parameters<typeof storage.put>) => {
      if (failOnce) {
        failOnce = false;
        throw new Error("home write failed");
      }
      return originalPut(...args);
    });

    await expect(ensurePackageAgent(ctx, pkg, BUILDER, 1000)).rejects.toThrow("home write failed");
    const partial = passwd.find((entry) => entry.username.startsWith("pkg-"))!;
    const countAfterFailure = passwd.length;

    const recovered = await ensurePackageAgent(ctx, pkg, BUILDER, 1000);

    expect(recovered.uid).toBe(partial.uid);
    expect(recovered.username).toBe(partial.username);
    expect(passwd).toHaveLength(countAfterFailure);
  });
});
