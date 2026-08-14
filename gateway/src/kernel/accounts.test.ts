import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KernelContext } from "./context";
import type { ConnectionIdentity, ProcessIdentity } from "@humansandmachines/gsv/protocol";
import {
  ensurePersonalAgent,
  handleAccountCreate,
  handleAccountList,
} from "./agents";
import {
  PERSONAL_INTELLIGENCE_COMMITMENTS_CONTEXT,
  PERSONAL_INTELLIGENCE_CONTEXT,
  PERSONAL_INTELLIGENCE_VOICE_CONTEXT,
} from "../prompts/personal-intelligence";
import {
  LEGACY_BOOT_CONTEXT_TEMPLATE,
  LEGACY_DEFAULT_USER_CONTEXT_TEMPLATE,
  LEGACY_MEMORY_CONTEXT_TEMPLATE_V1,
  LEGACY_MEMORY_CONTEXT_TEMPLATE_V2,
  LEGACY_MEMORY_CONTEXT_TEMPLATE_V3,
  LEGACY_MEMORY_CONTEXT_TEMPLATE_V4,
  LEGACY_OPEN_LOOPS_CONTEXT,
  PERSONAL_STANDING_CONTEXT,
  LEGACY_STYLE_CONTEXT,
} from "../prompts/agent-home";
import { LEGACY_DEFAULT_PERSONA_CONTEXT_TEMPLATE } from "../prompts/persona";

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
  const ripgitFiles = new Map<string, string>();
  const ripgitApplyBodies: Array<{
    owner: string;
    repo: string;
    author: string;
    email: string;
    message: string;
    ops: Array<{ type: string; path: string; contentBytes?: number[] }>;
  }> = [];

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
    updateUser: vi.fn((username: string, fields: Partial<Omit<PasswdRow, "username">>) => {
      const found = passwd.find((u) => u.username === username);
      if (!found) return false;
      Object.assign(found, fields);
      return true;
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
  const ripgit = {
    fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/apply")) {
        const parts = url.pathname.split("/").filter(Boolean);
        const body = JSON.parse(String(init?.body ?? "{}"));
        const owner = decodeURIComponent(parts[2] ?? "");
        const repo = decodeURIComponent(parts[3] ?? "");
        ripgitApplyBodies.push({
          owner,
          repo,
          ...body,
        });
        return new Response(JSON.stringify({ ok: true, head: "test-head" }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.pathname.endsWith("/read")) {
        const parts = url.pathname.split("/").filter(Boolean);
        const owner = decodeURIComponent(parts[2] ?? "");
        const repo = decodeURIComponent(parts[3] ?? "");
        const path = url.searchParams.get("path") ?? "";
        const content = ripgitFiles.get(`${owner}/${repo}:${path}`)
          ?? ripgitFiles.get(`${owner}:${path}`);
        if (content !== undefined) {
          return new Response(content, {
            headers: { "X-Blob-Size": String(new TextEncoder().encode(content).length) },
          });
        }
      }
      return new Response("missing", { status: 404 });
    }),
  };

  function ctxFor(identity: ConnectionIdentity, options: { ripgit?: boolean } = {}): KernelContext {
    return {
      auth: auth as unknown as KernelContext["auth"],
      caps: { resolve: vi.fn(() => []) } as unknown as KernelContext["caps"],
      env: {
        STORAGE: storage,
        ...(options.ripgit ? { RIPGIT: ripgit } : {}),
      } as unknown as KernelContext["env"],
      config: {
        get: vi.fn(() => null),
        set: vi.fn(),
      } as unknown as KernelContext["config"],
      identity,
    } as KernelContext;
  }

  return {
    ctxFor,
    auth,
    passwd,
    groups,
    shadow,
    personalAgents,
    ripgitApplyBodies,
    ripgitFiles,
  };
}

function provisionExistingPersonalAgent(
  state: ReturnType<typeof createCtx>,
  username = "friday",
): void {
  state.passwd.push({
    username,
    uid: 2000,
    gid: 2000,
    gecos: "alice's agent",
    home: `/home/${username}`,
    shell: "/bin/init",
  });
  state.groups.push({ name: username, gid: 2000, members: ["alice"] });
  state.shadow.set(username, "!");
  state.personalAgents.set(1000, 2000);
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

  it("preserves a custom display name (gecos), defaulting to the owner's agent", async () => {
    const { ctxFor, passwd } = createCtx();
    const ctx = ctxFor(userIdentity(1000, "alice", ["account.create"]));

    await handleAccountCreate({ kind: "agent", username: "scout", gecos: "Research Bot" }, ctx);
    expect(passwd.find((u) => u.username === "scout")?.gecos).toBe("Research Bot");

    await handleAccountCreate({ kind: "agent", username: "scout2" }, ctx);
    expect(passwd.find((u) => u.username === "scout2")?.gecos).toBe("alice's agent");
  });

  it("seeds agent prompt context without generated user or persona files", async () => {
    const { ctxFor, ripgitApplyBodies } = createCtx();
    const ctx = ctxFor(userIdentity(1000, "alice", ["account.create"]), { ripgit: true });

    await handleAccountCreate({
      kind: "agent",
      username: "scout",
      contextFiles: [{ name: "20-brief", text: "Scout briefing" }],
    }, ctx);

    const ops = ripgitApplyBodies.flatMap((body) => body.ops);
    const styleContextOp = ops.find((op) => op.path === "context.d/00-style.md");
    expect(styleContextOp).toEqual(expect.objectContaining({ type: "put" }));
    const styleContext = new TextDecoder().decode(new Uint8Array(styleContextOp?.contentBytes ?? []));
    expect(styleContext).toContain("Lead with the direct answer");
    expect(styleContext).toContain("# Example");
    expect(styleContext).not.toContain("# Style");
    const memoryContextOp = ops.find((op) => op.path === "context.d/15-memory.md");
    expect(memoryContextOp).toEqual(expect.objectContaining({ type: "put" }));
    const memoryContext = new TextDecoder().decode(new Uint8Array(memoryContextOp?.contentBytes ?? []));
    expect(memoryContext).toContain("human-owned kinds of memory");
    expect(memoryContext).toContain("`personal` wiki");
    expect(memoryContext).toContain("skills show memory");
    expect(memoryContext).not.toContain("/src/repos/scout/memory");
    expect(memoryContext).not.toContain("Master Control");
    expect(ops).not.toContainEqual(
      expect.objectContaining({ path: "context.d/20-open-loops.md" }),
    );
    expect(ops).not.toContainEqual(
      expect.objectContaining({ type: "put", path: "context.d/00-boot.md" }),
    );
    expect(ops).not.toContainEqual(
      expect.objectContaining({ type: "put", path: "context.d/00-constitution.md" }),
    );
    expect(ops).not.toContainEqual(
      expect.objectContaining({ type: "put", path: "context.d/05-persona.md" }),
    );
    expect(ops).not.toContainEqual(
      expect.objectContaining({ type: "put", path: "context.d/10-user.md" }),
    );
    expect(ripgitApplyBodies.flatMap((body) => body.ops)).toContainEqual(
      expect.objectContaining({ path: "context.d/20-brief.md" }),
    );
  });

  it("provisions human-owned shared memory while seeding the personal agent context", async () => {
    const { ctxFor, passwd, ripgitApplyBodies } = createCtx();
    const ctx = ctxFor(userIdentity(0, "root", ["*"]), { ripgit: true });

    const result = await handleAccountCreate(
      { kind: "human", username: "bob", password: "password-123" },
      ctx,
    );

    const personalAgentUsername = passwd.find((u) => u.uid === result.personalAgent?.uid)?.username;
    expect(personalAgentUsername).toBeTruthy();

    const bobOps = ripgitApplyBodies
      .filter((body) => body.owner === "bob")
      .flatMap((body) => body.ops);
    expect(bobOps).toContainEqual(
      expect.objectContaining({ type: "put", path: "context.d/.dir" }),
    );
    const personalContextOp = bobOps.find((op) => op.path === "context.d/10-personal.md");
    expect(personalContextOp).toEqual(expect.objectContaining({ type: "put" }));
    expect(new TextDecoder().decode(new Uint8Array(personalContextOp?.contentBytes ?? [])))
      .toBe(PERSONAL_STANDING_CONTEXT);
    expect(bobOps).not.toContainEqual(
      expect.objectContaining({ type: "put", path: "context.d/00-style.md" }),
    );
    expect(bobOps).not.toContainEqual(
      expect.objectContaining({ type: "put", path: "context.d/10-user.md" }),
    );

    const agentOps = ripgitApplyBodies
      .filter((body) => body.owner === personalAgentUsername)
      .flatMap((body) => body.ops);
    const bootContextOp = agentOps.find((op) => op.path === "context.d/00-boot.md");
    expect(bootContextOp).toEqual(expect.objectContaining({ type: "put" }));
    expect(new TextDecoder().decode(new Uint8Array(bootContextOp?.contentBytes ?? [])))
      .toContain("delete `~/context.d/00-boot.md`");
    expect(new TextDecoder().decode(new Uint8Array(bootContextOp?.contentBytes ?? [])))
      .toContain("keep it as an active assignment even if the conversation changes topic");
    expect(new TextDecoder().decode(new Uint8Array(bootContextOp?.contentBytes ?? [])))
      .not.toContain("Your program home");
    const roleContextOp = agentOps.find((op) => op.path === "context.d/00-role.md");
    const voiceContextOp = agentOps.find((op) => op.path === "context.d/05-voice.md");
    const commitmentsContextOp = agentOps.find((op) => (
      op.path === "context.d/10-commitments.md"
    ));
    expect(new TextDecoder().decode(new Uint8Array(roleContextOp?.contentBytes ?? [])))
      .toBe(PERSONAL_INTELLIGENCE_CONTEXT);
    expect(new TextDecoder().decode(new Uint8Array(voiceContextOp?.contentBytes ?? [])))
      .toBe(PERSONAL_INTELLIGENCE_VOICE_CONTEXT);
    expect(new TextDecoder().decode(new Uint8Array(commitmentsContextOp?.contentBytes ?? [])))
      .toBe(PERSONAL_INTELLIGENCE_COMMITMENTS_CONTEXT);
    expect(agentOps).not.toContainEqual(
      expect.objectContaining({ type: "put", path: "context.d/00-style.md" }),
    );
    expect(agentOps).not.toContainEqual(
      expect.objectContaining({ type: "put", path: "context.d/15-memory.md" }),
    );
    expect(agentOps).not.toContainEqual(
      expect.objectContaining({ path: "context.d/20-open-loops.md" }),
    );
    expect(agentOps).not.toContainEqual(
      expect.objectContaining({ type: "put", path: "context.d/05-persona.md" }),
    );
    expect(agentOps).not.toContainEqual(
      expect.objectContaining({ type: "put", path: "context.d/10-user.md" }),
    );

    const personalWiki = ripgitApplyBodies.find((body) =>
      body.owner === "bob" && body.repo === "personal"
    );
    expect(personalWiki).toBeTruthy();
    expect(personalWiki?.ops).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "put", path: "wiki.json" }),
      expect.objectContaining({ type: "put", path: "index.md" }),
      expect.objectContaining({ type: "put", path: "inbox/.dir" }),
      expect.objectContaining({ type: "put", path: "pages/journal/.dir" }),
      expect.objectContaining({ type: "put", path: "pages/people/.dir" }),
      expect.objectContaining({ type: "put", path: "pages/projects/.dir" }),
    ]));
  });

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

  it("rejects a weak human password without mutating auth state", async () => {
    const { ctxFor, auth, passwd, shadow } = createCtx();
    const ctx = ctxFor(userIdentity(0, "root", ["*"]));

    await expect(
      handleAccountCreate({ kind: "human", username: "bob", password: "short" }, ctx),
    ).rejects.toThrow(/password must be at least/i);

    // No half-created account: passwd row and shadow are untouched, and the
    // username stays available for a corrected retry.
    expect(auth.addUser).not.toHaveBeenCalled();
    expect(passwd.find((u) => u.username === "bob")).toBeUndefined();
    expect(shadow.has("bob")).toBe(false);

    const retry = await handleAccountCreate(
      { kind: "human", username: "bob", password: "password-123" },
      ctx,
    );
    expect(retry.account.username).toBe("bob");
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

  it("uses a humanized personal agent username as the display name", async () => {
    const { ctxFor, passwd } = createCtx();
    const ctx = ctxFor(userIdentity(0, "root", ["*"]));

    const result = await handleAccountCreate(
      { kind: "human", username: "bob", password: "password-123" },
      ctx,
    );

    const personalAgent = passwd.find((u) => u.uid === result.personalAgent?.uid);
    expect(personalAgent?.username).toBe("friday");
    expect(personalAgent?.gecos).toBe("Friday");
  });

  it.each([
    ["v1", LEGACY_MEMORY_CONTEXT_TEMPLATE_V1],
    ["v2", LEGACY_MEMORY_CONTEXT_TEMPLATE_V2],
    ["v3", LEGACY_MEMORY_CONTEXT_TEMPLATE_V3],
    ["v4", LEGACY_MEMORY_CONTEXT_TEMPLATE_V4],
  ])("reconciles the %s generated personal agent context", async (_version, memoryTemplate) => {
    const state = createCtx();
    provisionExistingPersonalAgent(state);
    state.ripgitFiles.set(
      "friday:context.d/00-boot.md",
      LEGACY_BOOT_CONTEXT_TEMPLATE
        .replaceAll("{{program.username}}", "friday")
        .replaceAll("{{program.home}}", "/home/friday"),
    );
    state.ripgitFiles.set("friday:context.d/00-style.md", LEGACY_STYLE_CONTEXT);
    state.ripgitFiles.set(
      "friday:context.d/15-memory.md",
      memoryTemplate.replaceAll("{{program.username}}", "friday"),
    );
    state.ripgitFiles.set("friday:context.d/20-open-loops.md", LEGACY_OPEN_LOOPS_CONTEXT);
    state.ripgitFiles.set(
      "friday:context.d/05-persona.md",
      LEGACY_DEFAULT_PERSONA_CONTEXT_TEMPLATE
        .replaceAll("{{program.username}}", "friday")
        .replaceAll("{{program.home}}", "/home/friday")
        .replaceAll("{{user.username}}", "alice"),
    );
    state.ripgitFiles.set(
      "friday:context.d/10-user.md",
      LEGACY_DEFAULT_USER_CONTEXT_TEMPLATE.replaceAll("{{user.username}}", "alice"),
    );
    const ctx = state.ctxFor(userIdentity(1000, "alice", ["account.create"]), { ripgit: true });

    const result = await ensurePersonalAgent(ctx, ctx.identity!.process);

    expect(result.created).toBe(false);
    expect(state.auth.updateUser).toHaveBeenCalledWith("friday", { gecos: "Friday" });
    expect(state.passwd.find((u) => u.username === "friday")?.gecos).toBe("Friday");
    const ops = state.ripgitApplyBodies.flatMap((body) => body.ops);
    expect(ops).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "put", path: "context.d/00-boot.md" }),
      expect.objectContaining({ type: "put", path: "context.d/00-role.md" }),
      expect.objectContaining({ type: "put", path: "context.d/05-voice.md" }),
      expect.objectContaining({ type: "put", path: "context.d/10-commitments.md" }),
      expect.objectContaining({ type: "delete", path: "context.d/00-style.md" }),
      expect.objectContaining({ type: "delete", path: "context.d/15-memory.md" }),
      expect.objectContaining({ type: "delete", path: "context.d/20-open-loops.md" }),
      expect.objectContaining({ type: "delete", path: "context.d/05-persona.md" }),
      expect.objectContaining({ type: "delete", path: "context.d/10-user.md" }),
    ]));
    const bootOp = ops.find((op) => op.path === "context.d/00-boot.md");
    expect(new TextDecoder().decode(new Uint8Array(bootOp?.contentBytes ?? [])))
      .toContain("This GSV was just created");
    const roleOp = ops.find((op) => op.path === "context.d/00-role.md");
    expect(new TextDecoder().decode(new Uint8Array(roleOp?.contentBytes ?? [])))
      .toContain("one continuous personal intelligence");
  });

  it("preserves customized personal agent context during reconciliation", async () => {
    const state = createCtx();
    provisionExistingPersonalAgent(state);
    const customPaths = [
      "context.d/00-boot.md",
      "context.d/00-style.md",
      "context.d/15-memory.md",
      "context.d/20-open-loops.md",
    ];
    for (const path of customPaths) {
      state.ripgitFiles.set(`friday:${path}`, `Custom ${path}`);
    }
    const ctx = state.ctxFor(userIdentity(1000, "alice", ["account.create"]), { ripgit: true });

    await ensurePersonalAgent(ctx, ctx.identity!.process);

    const ops = state.ripgitApplyBodies.flatMap((body) => body.ops);
    for (const path of customPaths) {
      expect(ops).not.toContainEqual(expect.objectContaining({ path }));
    }
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

  it("lists a custom agent the caller can run via its primary group", () => {
    const { ctxFor, passwd, groups, shadow } = createCtx();
    passwd.push({ username: "wiki-builder", uid: 2000, gid: 2000, gecos: "Wiki Builder", home: "/home/wiki-builder", shell: "/bin/init" });
    groups.push({ name: "wiki-builder", gid: 2000, members: ["alice"] });
    shadow.set("wiki-builder", "!");

    const result = handleAccountList({}, ctxFor(userIdentity(1000, "alice", ["account.list"])));
    const agent = result.accounts.find((a) => a.username === "wiki-builder");

    expect(agent).toBeTruthy();
    expect(agent?.relation).toBe("agent");
    expect(agent?.runnable).toBe(true);
    expect(agent?.displayName).toBe("Wiki Builder");

    // A different human without primary-group membership does not see it.
    passwd.push({ username: "carol", uid: 1500, gid: 1500, gecos: "carol", home: "/home/carol", shell: "/bin/init" });
    groups.push({ name: "carol", gid: 1500, members: [] });
    shadow.set("carol", "x");
    const carolView = handleAccountList({}, ctxFor(userIdentity(1500, "carol", ["account.list"])));
    expect(carolView.accounts.find((a) => a.username === "wiki-builder")).toBeUndefined();
  });

  it("filters root targeted listings through the requested owner", () => {
    const { ctxFor, passwd, groups, shadow } = createCtx();
    passwd.push({ username: "bob", uid: 1500, gid: 1500, gecos: "bob", home: "/home/bob", shell: "/bin/init" });
    groups.push({ name: "bob", gid: 1500, members: [] });
    shadow.set("bob", "x");

    passwd.push({ username: "wiki-builder", uid: 2000, gid: 2000, gecos: "Wiki Builder", home: "/home/wiki-builder", shell: "/bin/init" });
    groups.push({ name: "wiki-builder", gid: 2000, members: ["alice"] });
    shadow.set("wiki-builder", "!");

    passwd.push({ username: "bob-helper", uid: 2100, gid: 2100, gecos: "Bob Helper", home: "/home/bob-helper", shell: "/bin/init" });
    groups.push({ name: "bob-helper", gid: 2100, members: ["bob"] });
    shadow.set("bob-helper", "!");

    const result = handleAccountList({ uid: 1000 }, ctxFor(userIdentity(0, "root", ["*"])));
    const names = result.accounts.map((a) => a.username);

    expect(names).toContain("alice");
    expect(names).toContain("wiki-builder");
    expect(names).not.toContain("bob");
    expect(names).not.toContain("bob-helper");
  });
});
