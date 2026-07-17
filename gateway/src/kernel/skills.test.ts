import { describe, expect, it } from "vitest";
import type { ProcessIdentity } from "@humansandmachines/gsv/protocol";
import type { InstalledPackageRecord } from "./packages";
import type { KernelContext } from "./context";
import {
  collectFilesystemSkillDocuments,
  collectKernelSkillDocuments,
  collectPromptSkillIndex,
  listSkillFiles,
  parseSkillMarkdown,
  renderSkillIndex,
  resolveSkillDocument,
  validateSkillMarkdown,
} from "./skills";

const IDENTITY: ProcessIdentity = {
  uid: 1000,
  gid: 1000,
  gids: [1000],
  username: "sam",
  home: "/home/sam",
  cwd: "/home/sam",
};

const AGENT_IDENTITY: ProcessIdentity = {
  uid: 2000,
  gid: 2000,
  gids: [2000],
  username: "friday",
  home: "/home/friday",
  cwd: "/home/friday",
};

describe("collectFilesystemSkillDocuments", () => {
  it("marks package skills writable only when source repo is owned by the identity", async () => {
    const foreign = makePackage("pkg-foreign", "foreign-tools", "alice/tools");
    const owned = makePackage("pkg-owned", "owned-tools", "sam/tools");
    const ctx = {
      packages: {
        list: () => [foreign, owned],
      },
    } as unknown as KernelContext;
    const fs = makeSkillFs({
      "/src/repos/alice/tools/skills.d": ["guide.md"],
      "/src/repos/alice/tools/skills.d/guide.md": [
        "---",
        "name: foreign-guide",
        "description: Foreign package guide.",
        "---",
        "",
        "# Foreign",
        "",
      ].join("\n"),
      "/src/repos/sam/tools/skills.d": ["guide.md"],
      "/src/repos/sam/tools/skills.d/guide.md": [
        "---",
        "name: owned-guide",
        "description: Owned package guide.",
        "---",
        "",
        "# Owned",
        "",
      ].join("\n"),
    });

    const docs = await collectFilesystemSkillDocuments(fs, ctx, IDENTITY);

    expect(docs.find((doc) => doc.name === "foreign-guide")?.source).toMatchObject({
      kind: "package",
      label: "pkg:foreign-tools",
      writable: false,
    });
    expect(docs.find((doc) => doc.name === "owned-guide")?.source).toMatchObject({
      kind: "package",
      label: "pkg:owned-tools",
      writable: true,
    });
  });

  it("generates unique package skill ids for duplicate package names", async () => {
    const packageId = "pkg-tools";
    const globalPackage = makePackage(packageId, "tools", "sam/tools", { kind: "global" });
    const userPackage = makePackage(packageId, "tools", "sam/tools", { kind: "user", uid: IDENTITY.uid });
    const ctx = {
      packages: {
        list: () => [userPackage, globalPackage],
      },
    } as unknown as KernelContext;
    const fs = makeSkillFs({
      "/src/repos/sam/tools/skills.d": ["workflow.md"],
      "/src/repos/sam/tools/skills.d/workflow.md": [
        "---",
        "name: workflow",
        "description: Package workflow.",
        "---",
        "",
        "# Workflow",
        "",
      ].join("\n"),
    });

    const docs = await collectFilesystemSkillDocuments(fs, ctx, IDENTITY);

    expect(docs.map((doc) => doc.id).sort()).toEqual([
      "tools--sam-tools-2:workflow",
      "tools--sam-tools:workflow",
    ]);
    expect(resolveSkillDocument(docs, "tools--sam-tools:workflow")).toMatchObject({
      ok: true,
      doc: {
        path: "/src/repos/sam/tools/skills.d/workflow.md",
      },
    });
    expect(resolveSkillDocument(docs, "tools--sam-tools-2:workflow")).toMatchObject({
      ok: true,
      doc: {
        path: "/src/repos/sam/tools/skills.d/workflow.md",
      },
    });
  });

  it("uses both owning human and agent skills.d for agent processes", async () => {
    const ownerPackage = makePackage("pkg-owner-tools", "owner-tools", "sam/tools", { kind: "user", uid: IDENTITY.uid });
    const agentPackage = makePackage("pkg-agent-tools", "agent-tools", "friday/tools", { kind: "user", uid: AGENT_IDENTITY.uid });
    const listCalls: Array<{ scopes?: unknown }> = [];
    const ctx = makeAgentOwnedContext({
      packages: [ownerPackage, agentPackage],
      listCalls,
    });
    const fs = makeSkillFs({
      "/home/sam/skills.d": ["shared.md"],
      "/home/sam/skills.d/shared.md": skillMarkdown("shared", "User-wide skill."),
      "/home/friday/skills.d": ["shared.md", "specialized.md"],
      "/home/friday/skills.d/shared.md": skillMarkdown("shared", "Agent-specific override skill."),
      "/home/friday/skills.d/specialized.md": skillMarkdown("specialized", "Agent-only skill."),
      "/src/repos/sam/tools/skills.d": ["workflow.md"],
      "/src/repos/sam/tools/skills.d/workflow.md": skillMarkdown("owner-workflow", "Owner package workflow."),
    });

    const docs = await collectFilesystemSkillDocuments(fs, ctx, AGENT_IDENTITY);

    expect(docs.map((doc) => doc.id)).toEqual([
      "user:shared",
      "agent:shared",
      "specialized",
      "owner-workflow",
    ]);
    expect(resolveSkillDocument(docs, "user:shared")).toMatchObject({
      ok: true,
      doc: {
        path: "/home/sam/skills.d/shared.md",
        source: { label: "user" },
      },
    });
    expect(resolveSkillDocument(docs, "agent:shared")).toMatchObject({
      ok: true,
      doc: {
        path: "/home/friday/skills.d/shared.md",
        source: { label: "agent" },
      },
    });
    expect(docs.find((doc) => doc.name === "owner-workflow")?.source.writable).toBe(false);
    expect(listCalls[0]).toMatchObject({
      scopes: [
        { kind: "user", uid: IDENTITY.uid },
        { kind: "global" },
      ],
    });
  });

  it("discovers nested skills.d children without exposing them in top-level-only collection", async () => {
    const ctx = {
      packages: {
        list: () => [],
      },
    } as unknown as KernelContext;
    const fs = makeSkillFs({
      "/home/sam/skills.d": ["device-management"],
      "/home/sam/skills.d/device-management": ["SKILL.md", "notes.md", "skills.d"],
      "/home/sam/skills.d/device-management/SKILL.md": [
        "---",
        "name: device-management",
        "description: Manage devices and targets.",
        "aliases: devices, targets",
        "---",
        "",
        "# Devices",
        "",
      ].join("\n"),
      "/home/sam/skills.d/device-management/notes.md": "supporting notes",
      "/home/sam/skills.d/device-management/skills.d": ["adding-devices"],
      "/home/sam/skills.d/device-management/skills.d/adding-devices": ["SKILL.md"],
      "/home/sam/skills.d/device-management/skills.d/adding-devices/SKILL.md": [
        "---",
        "name: adding-devices",
        "description: Add device workflow.",
        "aliases: node install",
        "---",
        "",
        "# Adding Devices",
        "",
      ].join("\n"),
    });

    const docs = await collectFilesystemSkillDocuments(fs, ctx, IDENTITY);
    const topLevelOnly = await collectFilesystemSkillDocuments(fs, ctx, IDENTITY, { includeNested: false });

    expect(docs.find((doc) => doc.id === "device-management")).toMatchObject({
      depth: 0,
      aliases: ["devices", "targets"],
    });
    expect(docs.find((doc) => doc.id === "device-management/adding-devices")).toMatchObject({
      depth: 1,
      parentId: "device-management",
      aliases: ["node install"],
    });
    expect(resolveSkillDocument(docs, "node install")).toMatchObject({
      ok: true,
      doc: {
        id: "device-management/adding-devices",
      },
    });
    expect(topLevelOnly.map((doc) => doc.id)).toEqual(["device-management"]);
    await expect(listSkillFiles(fs, docs.find((doc) => doc.id === "device-management")!)).resolves.toEqual(["notes.md"]);
  });

  it("links nested children to the final deduped parent skill id", async () => {
    const ctx = makeAgentOwnedContext();
    const fs = makeSkillFs({
      "/home/sam/skills.d": ["device-management"],
      "/home/sam/skills.d/device-management": ["SKILL.md", "skills.d"],
      "/home/sam/skills.d/device-management/SKILL.md": skillMarkdown("device-management", "User device manual."),
      "/home/sam/skills.d/device-management/skills.d": ["adding-devices"],
      "/home/sam/skills.d/device-management/skills.d/adding-devices": ["SKILL.md"],
      "/home/sam/skills.d/device-management/skills.d/adding-devices/SKILL.md": skillMarkdown("adding-devices", "User add device workflow."),
      "/home/friday/skills.d": ["device-management"],
      "/home/friday/skills.d/device-management": ["SKILL.md", "skills.d"],
      "/home/friday/skills.d/device-management/SKILL.md": skillMarkdown("device-management", "Agent device manual."),
      "/home/friday/skills.d/device-management/skills.d": ["adding-devices"],
      "/home/friday/skills.d/device-management/skills.d/adding-devices": ["SKILL.md"],
      "/home/friday/skills.d/device-management/skills.d/adding-devices/SKILL.md": skillMarkdown("adding-devices", "Agent add device workflow."),
    });

    const docs = await collectFilesystemSkillDocuments(fs, ctx, AGENT_IDENTITY);

    expect(docs.map((doc) => doc.id).sort()).toEqual([
      "agent:device-management",
      "agent:device-management/adding-devices",
      "user:device-management",
      "user:device-management/adding-devices",
    ]);
    expect(docs.find((doc) => doc.id === "user:device-management/adding-devices")?.parentId)
      .toBe("user:device-management");
    expect(docs.find((doc) => doc.id === "agent:device-management/adding-devices")?.parentId)
      .toBe("agent:device-management");
  });
});

describe("parseSkillMarkdown", () => {
  it("parses the prompt-visible metadata without hierarchy frontmatter", () => {
    expect(parseSkillMarkdown("# Package Development\n\nBuild packages.", "package-development")).toEqual({
      name: "package-development",
      description: "Build packages.",
      aliases: [],
    });
  });
});

describe("validateSkillMarkdown", () => {
  it("accepts a complete skill whose name matches its path", () => {
    expect(validateSkillMarkdown([
      "---",
      "name: browse-instagram",
      "description: >",
      "  Browse Instagram through the connected browser when the user asks for a repeatable review.",
      "---",
      "",
      "# Browse Instagram",
      "",
      "Use the browser target and inspect before acting.",
      "",
    ].join("\n"), "browse-instagram")).toEqual({
      ok: true,
      name: "browse-instagram",
      description: "Browse Instagram through the connected browser when the user asks for a repeatable review.",
    });
  });

  it("reports malformed metadata, mismatched paths, and empty instructions", () => {
    const result = validateSkillMarkdown([
      "---",
      "name: Browse Instagram",
      "name: duplicate",
      "description:",
      "---",
      "",
    ].join("\n"), "browse-instagram");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual(expect.arrayContaining([
      "frontmatter field 'name' must appear exactly once",
      "frontmatter name 'duplicate' must match skill path name 'browse-instagram'",
      "frontmatter field 'description' is required",
      "SKILL.md must include non-empty workflow instructions after frontmatter",
    ]));
  });
});

describe("renderSkillIndex", () => {
  it("renders top-level skills as the prompt-visible manual index", () => {
    const index = renderSkillIndex([
      {
        id: "device-management",
        name: "device-management",
        description: "Manage devices and targets.",
        source: { kind: "home", label: "home", writable: true },
      },
    ]);

    expect(index).toContain("Available skills are top-level only.");
    expect(index).toContain("skills list <skill>");
    expect(index).toContain("<skill>");
    expect(index).toContain("<name>device-management</name>");
    expect(index).toContain("<description>Manage devices and targets.</description>");
  });

  it("can render names without descriptions", () => {
    const index = renderSkillIndex([
      {
        id: "device-management",
        name: "device-management",
        description: "Manage devices and targets.",
        source: { kind: "home", label: "home", writable: true },
      },
    ], "names");

    expect(index).toContain("<name>device-management</name>");
    expect(index).not.toContain("<description>");
    expect(index).not.toContain("Manage devices and targets.");
  });
});

describe("collectKernelSkillDocuments", () => {
  it("keeps nested child skills out of the prompt skill index", async () => {
    const readKeys: string[] = [];
    const ctx = {
      identity: {
        role: "user",
        process: IDENTITY,
        capabilities: ["*"],
      },
      packages: {
        list: () => [],
      },
      env: {
        RIPGIT: makeRipgitFetcher({
          "sam/home:skills.d": [
            { name: "device-management", mode: "040000", hash: "parent", type: "tree" },
          ],
          "sam/home:skills.d/device-management/SKILL.md": skillMarkdown("device-management", "Manage devices."),
          "sam/home:skills.d/device-management/skills.d": [
            { name: "adding-devices", mode: "040000", hash: "child", type: "tree" },
          ],
          "sam/home:skills.d/device-management/skills.d/adding-devices/SKILL.md": skillMarkdown("adding-devices", "Add devices."),
        }, readKeys),
      },
    } as unknown as KernelContext;

    const index = await collectPromptSkillIndex(ctx);

    expect(index.map((entry) => entry.id)).toEqual(["device-management"]);
    expect(readKeys).not.toContain("sam/home:skills.d/device-management/skills.d");
  });

  it("uses both owning human and agent ripgit home repos for prompt skills", async () => {
    const readKeys: string[] = [];
    const ctx = makeAgentOwnedContext({
      ripgitEntries: {
        "sam/home:skills.d": [
          { name: "owner.md", mode: "100644", hash: "owner", type: "blob" },
        ],
        "sam/home:skills.d/owner.md": skillMarkdown("owner-skill", "User-wide skill."),
        "friday/home:skills.d": [
          { name: "agent.md", mode: "100644", hash: "agent", type: "blob" },
        ],
        "friday/home:skills.d/agent.md": skillMarkdown("agent-skill", "Agent-only skill."),
      },
      readKeys,
    });

    const docs = await collectKernelSkillDocuments(ctx);

    expect(docs.map((doc) => doc.name)).toEqual([
      "owner-skill",
      "agent-skill",
    ]);
    expect(docs.map((doc) => doc.path)).toEqual([
      "/home/sam/skills.d/owner.md",
      "/home/friday/skills.d/agent.md",
    ]);
    expect(readKeys).toContain("sam/home:skills.d");
    expect(readKeys).toContain("friday/home:skills.d");
  });
});

function makePackage(
  packageId: string,
  name: string,
  repo: string,
  scope: InstalledPackageRecord["scope"] = { kind: "user", uid: IDENTITY.uid },
): InstalledPackageRecord {
  return {
    packageId,
    scope,
    manifest: {
      name,
      description: name,
      version: "0.1.0",
      runtime: "web-ui",
      source: {
        repo,
        ref: "main",
        subdir: ".",
        resolvedCommit: "base123",
      },
      entrypoints: [],
    },
    artifact: { hash: "hash", mainModule: "main.js", modulePaths: ["main.js"] },
    enabled: true,
    reviewRequired: false,
    reviewedAt: 1,
    installedAt: 1,
    updatedAt: 1,
  } as InstalledPackageRecord;
}

function makeAgentOwnedContext(options: {
  packages?: InstalledPackageRecord[];
  listCalls?: Array<{ scopes?: unknown }>;
  ripgitEntries?: Record<string, string | Array<{ name: string; mode: string; hash: string; type: "tree" | "blob" | "symlink" }>>;
  readKeys?: string[];
} = {}): KernelContext {
  const packages = options.packages ?? [];
  return {
    identity: {
      role: "user",
      process: AGENT_IDENTITY,
      capabilities: ["*"],
    },
    auth: {
      getPasswdByUid(uid: number) {
        if (uid === IDENTITY.uid) {
          return {
            uid: IDENTITY.uid,
            gid: IDENTITY.gid,
            username: IDENTITY.username,
            gecos: "sam",
            home: IDENTITY.home,
            shell: "/bin/init",
          };
        }
        if (uid === AGENT_IDENTITY.uid) {
          return {
            uid: AGENT_IDENTITY.uid,
            gid: AGENT_IDENTITY.gid,
            username: AGENT_IDENTITY.username,
            gecos: "friday",
            home: AGENT_IDENTITY.home,
            shell: "/bin/init",
          };
        }
        return null;
      },
      resolveGids(_username: string, gid: number) {
        return [gid];
      },
    },
    procs: {
      getOwnerUid() {
        return IDENTITY.uid;
      },
    },
    processId: "task-1",
    packages: {
      list(args: { scopes?: Array<{ kind: string; uid?: number }> }) {
        options.listCalls?.push(args);
        const scopeKeys = new Set((args.scopes ?? []).map((scope) =>
          scope.kind === "user" ? `user:${scope.uid}` : scope.kind
        ));
        return packages.filter((pkg) => {
          const scope = pkg.scope.kind === "user" ? `user:${pkg.scope.uid}` : pkg.scope.kind;
          return scopeKeys.has(scope);
        });
      },
    },
    env: {
      RIPGIT: options.ripgitEntries ? makeRipgitFetcher(options.ripgitEntries, options.readKeys) : undefined,
    },
  } as unknown as KernelContext;
}

function makeSkillFs(entries: Record<string, string[] | string>) {
  return {
    async readdir(path: string): Promise<string[]> {
      const entry = entries[path];
      if (!Array.isArray(entry)) {
        throw new Error(`ENOENT: ${path}`);
      }
      return entry;
    },
    async stat(path: string): Promise<{ isFile: boolean; isDirectory: boolean }> {
      const entry = entries[path];
      if (entry === undefined) {
        throw new Error(`ENOENT: ${path}`);
      }
      return {
        isFile: typeof entry === "string",
        isDirectory: Array.isArray(entry),
      };
    },
    async readFile(path: string): Promise<string> {
      const entry = entries[path];
      if (typeof entry !== "string") {
        throw new Error(`ENOENT: ${path}`);
      }
      return entry;
    },
  };
}

function skillMarkdown(name: string, description: string): string {
  return [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    "---",
    "",
    `# ${name}`,
    "",
  ].join("\n");
}

function makeRipgitFetcher(
  entries: Record<string, string | Array<{ name: string; mode: string; hash: string; type: "tree" | "blob" | "symlink" }>>,
  readKeys: string[] = [],
): Fetcher {
  const encoder = new TextEncoder();
  return {
    async fetch(input: RequestInfo | URL) {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const match = /^\/hyperspace\/repos\/([^/]+)\/([^/]+)\/read$/.exec(url.pathname);
      if (!match) {
        return new Response("not found", { status: 404 });
      }
      const owner = decodeURIComponent(match[1]);
      const repo = decodeURIComponent(match[2]);
      const path = url.searchParams.get("path") ?? "";
      const key = `${owner}/${repo}:${path}`;
      readKeys.push(key);
      const entry = entries[key];
      if (!entry) {
        return new Response("missing", { status: 404 });
      }
      if (typeof entry !== "string") {
        return Response.json(entry);
      }
      return new Response(entry, {
        headers: {
          "X-Blob-Size": String(encoder.encode(entry).length),
        },
      });
    },
  } as unknown as Fetcher;
}
