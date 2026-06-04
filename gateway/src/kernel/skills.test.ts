import { describe, expect, it } from "vitest";
import type { ProcessIdentity } from "@gsv/protocol/syscalls/system";
import type { InstalledPackageRecord } from "./packages";
import type { KernelContext } from "./context";
import { collectFilesystemSkillDocuments, collectKernelSkillDocuments, resolveSkillDocument } from "./skills";

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
      "/src/packages/foreign-tools/skills.d": ["guide.md"],
      "/src/packages/foreign-tools/skills.d/guide.md": [
        "---",
        "name: foreign-guide",
        "description: Foreign package guide.",
        "---",
        "",
        "# Foreign",
        "",
      ].join("\n"),
      "/src/packages/owned-tools/skills.d": ["guide.md"],
      "/src/packages/owned-tools/skills.d/guide.md": [
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
      "/src/packages/tools--sam-tools/skills.d": ["workflow.md"],
      "/src/packages/tools--sam-tools/skills.d/workflow.md": [
        "---",
        "name: workflow",
        "description: Global package workflow.",
        "---",
        "",
        "# Global",
        "",
      ].join("\n"),
      "/src/packages/tools--sam-tools-2/skills.d": ["workflow.md"],
      "/src/packages/tools--sam-tools-2/skills.d/workflow.md": [
        "---",
        "name: workflow",
        "description: User package workflow.",
        "---",
        "",
        "# User",
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
        path: "/src/packages/tools--sam-tools/skills.d/workflow.md",
      },
    });
    expect(resolveSkillDocument(docs, "tools--sam-tools-2:workflow")).toMatchObject({
      ok: true,
      doc: {
        path: "/src/packages/tools--sam-tools-2/skills.d/workflow.md",
      },
    });
  });

  it("uses the owning human's skills.d for agent processes", async () => {
    const ownerPackage = makePackage("pkg-owner-tools", "owner-tools", "sam/tools", { kind: "user", uid: IDENTITY.uid });
    const agentPackage = makePackage("pkg-agent-tools", "agent-tools", "friday/tools", { kind: "user", uid: AGENT_IDENTITY.uid });
    const listCalls: Array<{ scopes?: unknown }> = [];
    const ctx = makeAgentOwnedContext({
      packages: [ownerPackage, agentPackage],
      listCalls,
    });
    const fs = makeSkillFs({
      "/home/sam/skills.d": ["owner.md"],
      "/home/sam/skills.d/owner.md": skillMarkdown("owner-skill", "User skill."),
      "/home/friday/skills.d": ["agent.md"],
      "/home/friday/skills.d/agent.md": skillMarkdown("agent-skill", "Agent skill."),
      "/src/packages/owner-tools/skills.d": ["workflow.md"],
      "/src/packages/owner-tools/skills.d/workflow.md": skillMarkdown("owner-workflow", "Owner package workflow."),
    });

    const docs = await collectFilesystemSkillDocuments(fs, ctx, AGENT_IDENTITY);

    expect(docs.map((doc) => doc.name).sort()).toEqual([
      "owner-skill",
      "owner-workflow",
    ]);
    expect(docs.find((doc) => doc.name === "owner-skill")?.path).toBe("/home/sam/skills.d/owner.md");
    expect(docs.find((doc) => doc.name === "owner-workflow")?.source.writable).toBe(false);
    expect(listCalls[0]).toMatchObject({
      scopes: [
        { kind: "user", uid: IDENTITY.uid },
        { kind: "global" },
      ],
    });
  });
});

describe("collectKernelSkillDocuments", () => {
  it("uses the owning human's ripgit home repo for agent prompt skills", async () => {
    const readKeys: string[] = [];
    const ctx = makeAgentOwnedContext({
      ripgitEntries: {
        "sam/home:skills.d": [
          { name: "owner.md", mode: "100644", hash: "owner", type: "blob" },
        ],
        "sam/home:skills.d/owner.md": skillMarkdown("owner-skill", "User skill."),
        "friday/home:skills.d": [
          { name: "agent.md", mode: "100644", hash: "agent", type: "blob" },
        ],
        "friday/home:skills.d/agent.md": skillMarkdown("agent-skill", "Agent skill."),
      },
      readKeys,
    });

    const docs = await collectKernelSkillDocuments(ctx);

    expect(docs.map((doc) => doc.name)).toEqual(["owner-skill"]);
    expect(docs[0].path).toBe("/home/sam/skills.d/owner.md");
    expect(readKeys).toContain("sam/home:skills.d");
    expect(readKeys).not.toContain("friday/home:skills.d");
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
