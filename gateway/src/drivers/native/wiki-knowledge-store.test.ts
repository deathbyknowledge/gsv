import { describe, expect, it } from "vitest";
import type {
  RepoApplyOp,
  RepoReadResult,
  RepoSummary,
  RepoTreeEntry,
} from "@humansandmachines/gsv/protocol";
import type { PackageStorageBinding } from "@humansandmachines/gsv/sdk/context";
import { runWikiCommand } from "../../../../builtin-packages/wiki/src/cli/wiki-runner";
import { WikiKnowledgeStore } from "../../../../builtin-packages/wiki/src/backend/knowledge-store";

class InMemoryKnowledgeClient {
  private readonly repos = new Map<string, Map<string, string>>();
  private readonly summaries = new Map<string, RepoSummary>();
  private readonly readCounts = new Map<string, number>();
  private nextTimestamp = 1;

  constructor(initial?: Record<string, string>, extraRepos?: Record<string, Record<string, string>>) {
    this.addRepo("hank/home", "home", "home", initial ?? {});
    for (const [repo, files] of Object.entries(extraRepos ?? {})) {
      const [, name = repo] = repo.split("/");
      this.addRepo(repo, name, "user", files);
    }
  }

  has(repo: string, path: string): boolean {
    return this.repos.get(repo)?.has(path) === true;
  }

  readText(repo: string, path: string): string | undefined {
    return this.repos.get(repo)?.get(path);
  }

  addUserRepo(repo: string, files: Record<string, string>): void {
    const [, name = repo] = repo.split("/");
    this.addRepo(repo, name, "user", files);
  }

  setUpdatedAt(repo: string, updatedAt: number): void {
    const summary = this.summaries.get(repo);
    if (!summary) {
      throw new Error(`Repository not found: ${repo}`);
    }
    this.summaries.set(repo, { ...summary, updatedAt });
  }

  setFile(repo: string, path: string, content: string): void {
    this.filesFor(repo).set(path, content);
    const summary = this.summaries.get(repo);
    if (summary) {
      this.summaries.set(repo, { ...summary, updatedAt: this.nextUpdatedAt() });
    }
  }

  setWritable(repo: string, writable: boolean): void {
    const summary = this.summaries.get(repo);
    if (!summary) {
      throw new Error(`Repository not found: ${repo}`);
    }
    this.summaries.set(repo, { ...summary, writable });
  }

  readCount(repo: string, path: string): number {
    return this.readCounts.get(`${repo}:${path}`) ?? 0;
  }

  async request<T = unknown>(name: string, args: unknown): Promise<T> {
    if (name === "repo.list") {
      const repos = [...this.summaries.values()].sort((left, right) => {
        if (left.kind === "home" && right.kind !== "home") return -1;
        if (right.kind === "home" && left.kind !== "home") return 1;
        return left.repo.localeCompare(right.repo);
      });
      return { repos } as T;
    }
    if (name === "repo.create") {
      const { repo, description } = args as { repo: string; description?: string };
      const existing = this.summaries.has(repo);
      if (!existing) {
        const [, name = repo] = repo.split("/");
        this.addRepo(repo, name, "user", {}, description);
      }
      return { repo, ref: "main", head: "head", created: !existing } as T;
    }
    if (name === "repo.read") {
      const { repo = "hank/home", path = "" } = args as { repo?: string; path?: string };
      this.readCounts.set(`${repo}:${path}`, this.readCount(repo, path) + 1);
      return this.readPath(repo, path) as T;
    }
    if (name === "repo.apply") {
      const { repo = "hank/home", ops } = args as { repo?: string; ops: RepoApplyOp[] };
      this.apply(repo, ops);
      return { ok: true, repo, ref: "main", head: "head" } as T;
    }
    throw new Error(`unexpected request ${name}`);
  }

  private addRepo(
    repo: string,
    name: string,
    kind: RepoSummary["kind"],
    files: Record<string, string>,
    description?: string,
  ): void {
    const [owner = "hank"] = repo.split("/");
    this.summaries.set(repo, {
      repo,
      owner,
      name,
      kind,
      writable: true,
      public: false,
      description,
      updatedAt: this.nextUpdatedAt(),
    });
    this.repos.set(repo, new Map(Object.entries(files)));
  }

  private filesFor(repo: string): Map<string, string> {
    const files = this.repos.get(repo);
    if (!files) {
      throw new Error(`Repository not found: ${repo}`);
    }
    return files;
  }

  private readPath(repo: string, path: string): RepoReadResult {
    const files = this.filesFor(repo);
    const exact = files.get(path);
    if (typeof exact === "string") {
      return {
        repo,
        ref: "main",
        path,
        kind: "file",
        size: new TextEncoder().encode(exact).length,
        isBinary: false,
        content: exact,
      };
    }

    const prefix = path ? `${path}/` : "";
    const children = [...files.keys()].filter((candidate) => candidate.startsWith(prefix));
    if (children.length === 0) {
      throw new Error(`Path not found: ${path || "/"}`);
    }

    const byName = new Map<string, RepoTreeEntry>();
    for (const child of children) {
      const remainder = child.slice(prefix.length);
      const [name, ...rest] = remainder.split("/");
      if (!name) continue;
      if (rest.length > 0) {
        byName.set(name, {
          name,
          path: path ? `${path}/${name}` : name,
          mode: "040000",
          hash: `tree-${name}`,
          type: "tree",
        });
      } else {
        byName.set(name, {
          name,
          path: path ? `${path}/${name}` : name,
          mode: "100644",
          hash: `blob-${name}`,
          type: "blob",
        });
      }
    }

    return {
      repo,
      ref: "main",
      path,
      kind: "tree",
      entries: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  private apply(repo: string, ops: RepoApplyOp[]): void {
    const files = this.filesFor(repo);
    for (const op of ops) {
      if (op.type === "put") {
        files.set(op.path, op.content ?? "");
        this.touchRepo(repo);
        continue;
      }
      if (op.type === "delete") {
        const prefix = `${op.path}/`;
        for (const path of [...files.keys()]) {
          if (path === op.path || (op.recursive && path.startsWith(prefix))) {
            files.delete(path);
          }
        }
        this.touchRepo(repo);
        continue;
      }
      if (op.type === "move") {
        const content = files.get(op.from);
        if (typeof content === "string") {
          files.set(op.to, content);
          files.delete(op.from);
          this.touchRepo(repo);
        }
      }
    }
  }

  private nextUpdatedAt(): number {
    const value = this.nextTimestamp;
    this.nextTimestamp += 1;
    return value;
  }

  private touchRepo(repo: string): void {
    const summary = this.summaries.get(repo);
    if (summary) {
      this.summaries.set(repo, { ...summary, updatedAt: this.nextUpdatedAt() });
    }
  }
}

type WikiRepoCacheRow = {
  repo: string;
  repo_updated_at: number | null;
  is_wiki: number;
  wiki_id: string | null;
  title: string | null;
  last_checked_at: number;
};

class InMemoryPackageStorage {
  readonly migrations = new Map<number, string>();
  readonly rows = new Map<string, WikiRepoCacheRow>();

  readonly binding: PackageStorageBinding = {
    sql: {
      exec: async <T extends Record<string, unknown>>(statement: string, ...bindings: unknown[]) => {
        const normalized = statement.trim().replace(/\s+/g, " ");
        if (normalized.startsWith("CREATE TABLE IF NOT EXISTS wiki_schema_migrations")) {
          return [] as T[];
        }
        if (normalized.startsWith("SELECT id, name FROM wiki_schema_migrations ORDER BY id")) {
          return [...this.migrations.entries()].map(([id, name]) => ({ id, name })) as T[];
        }
        if (normalized.startsWith("CREATE TABLE IF NOT EXISTS wiki_repo_cache")) {
          return [] as T[];
        }
        if (normalized.startsWith("CREATE INDEX IF NOT EXISTS idx_wiki_repo_cache_is_wiki")) {
          return [] as T[];
        }
        if (normalized.startsWith("INSERT INTO wiki_schema_migrations")) {
          const [id, name] = bindings;
          this.migrations.set(Number(id), String(name ?? ""));
          return [] as T[];
        }
        if (normalized.startsWith("SELECT repo, repo_updated_at, is_wiki, wiki_id, title FROM wiki_repo_cache")) {
          return [...this.rows.values()].map((row) => ({ ...row })) as T[];
        }
        if (normalized.startsWith("INSERT INTO wiki_repo_cache")) {
          const [repo, repoUpdatedAt, isWiki, wikiId, title, lastCheckedAt] = bindings;
          if (typeof repo !== "string") {
            throw new Error("repo binding must be a string");
          }
          this.rows.set(repo, {
            repo,
            repo_updated_at: typeof repoUpdatedAt === "number" ? repoUpdatedAt : null,
            is_wiki: isWiki === 1 ? 1 : 0,
            wiki_id: typeof wikiId === "string" ? wikiId : null,
            title: typeof title === "string" ? title : null,
            last_checked_at: typeof lastCheckedAt === "number" ? lastCheckedAt : Date.now(),
          });
          return [] as T[];
        }
        throw new Error(`unexpected sql: ${normalized}`);
      },
    },
  };
}

function createStore(
  initial?: Record<string, string>,
  extraRepos?: Record<string, Record<string, string>>,
): WikiKnowledgeStore {
  return new WikiKnowledgeStore(new InMemoryKnowledgeClient(initial, extraRepos));
}

function wikiRepo(id: string, title: string, files: Record<string, string>): Record<string, string> {
  return {
    "wiki.json": JSON.stringify({
      kind: "gsv.wiki",
      version: 1,
      id,
      title,
    }),
    "index.md": [
      `# ${title}`,
      "",
      "## Pages",
      "- _No pages yet._",
      "",
    ].join("\n"),
    ...files,
  };
}

function commandContext(client: InMemoryKnowledgeClient, argv: string[], stdin = "") {
  return {
    kernel: client,
    argv,
    stdin: {
      async text() {
        return stdin;
      },
    },
  };
}

describe("WikiKnowledgeStore", () => {
  it("initializes and lists knowledge databases", async () => {
    const client = new InMemoryKnowledgeClient();
    const store = new WikiKnowledgeStore(client);

    const init = await store.initDb({
      id: "product",
      title: "Product knowledge",
      description: "Compiled notes for product work.",
    });

    expect(init).toEqual({
      ok: true,
      id: "product",
      created: true,
    });

    const dbs = await store.listDbs({});
    expect(dbs).toEqual({
      dbs: [
        {
          id: "product",
          title: "Product knowledge",
        },
      ],
    });
    expect(client.has("hank/home", "knowledge/product/index.md")).toBe(false);
    expect(client.readText("hank/product", "wiki.json")).toContain('"kind": "gsv.wiki"');
    expect(client.readText("hank/product", "index.md")).toContain("# Product knowledge");
  });

  it("discovers repo-backed wiki collections from manifests", async () => {
    const store = createStore(
      undefined,
      {
        "hank/gsv": wikiRepo("gsv", "GSV Manual", {
          "pages/orientation.md": "# Orientation\n",
        }),
        "hank/product": wikiRepo("product", "Product Wiki", {
          "pages/roadmap.md": "# Roadmap\n",
        }),
      },
    );

    const dbs = await store.listDbs({});
    expect(dbs.dbs).toEqual([
      { id: "gsv", title: "GSV Manual" },
      { id: "product", title: "Product Wiki" },
    ]);

    const productPage = await store.read({ path: "product/pages/roadmap.md" });
    expect(productPage.exists).toBe(true);
    expect(productPage.title).toBe("Roadmap");

    const manualPage = await store.read({ path: "gsv/pages/orientation.md" });
    expect(manualPage.exists).toBe(true);
    expect(manualPage.title).toBe("Orientation");
  });

  it("caches wiki repo discovery hits and misses across store instances", async () => {
    const client = new InMemoryKnowledgeClient(undefined, {
      "hank/gsv": wikiRepo("gsv", "GSV Manual", {
        "pages/orientation.md": "# Orientation\n",
      }),
      "hank/scratch": {
        "README.md": "# Scratch\n",
      },
    });
    const storage = new InMemoryPackageStorage();

    const first = new WikiKnowledgeStore(client, storage.binding);
    expect(await first.listDbs({})).toEqual({
      dbs: [{ id: "gsv", title: "GSV Manual" }],
    });
    expect(client.readCount("hank/home", "wiki.json")).toBe(1);
    expect(client.readCount("hank/gsv", "wiki.json")).toBe(1);
    expect(client.readCount("hank/scratch", "wiki.json")).toBe(1);
    expect(storage.migrations.get(1)).toBe("repo_discovery_cache");
    expect(storage.rows.get("hank/scratch")?.is_wiki).toBe(0);

    const second = new WikiKnowledgeStore(client, storage.binding);
    expect(await second.listDbs({})).toEqual({
      dbs: [{ id: "gsv", title: "GSV Manual" }],
    });
    expect(client.readCount("hank/home", "wiki.json")).toBe(1);
    expect(client.readCount("hank/gsv", "wiki.json")).toBe(1);
    expect(client.readCount("hank/scratch", "wiki.json")).toBe(1);

    client.addUserRepo("hank/manual", wikiRepo("manual", "Manual", {
      "pages/start.md": "# Start\n",
    }));
    const withNewRepo = new WikiKnowledgeStore(client, storage.binding);
    expect((await withNewRepo.listDbs({})).dbs.map((db) => db.id)).toEqual(["gsv", "manual"]);
    expect(client.readCount("hank/gsv", "wiki.json")).toBe(1);
    expect(client.readCount("hank/scratch", "wiki.json")).toBe(1);
    expect(client.readCount("hank/manual", "wiki.json")).toBe(1);

    client.setFile("hank/scratch", "wiki.json", JSON.stringify({
      kind: "gsv.wiki",
      version: 1,
      id: "scratch",
      title: "Scratch Wiki",
    }));
    const withChangedRepo = new WikiKnowledgeStore(client, storage.binding);
    expect((await withChangedRepo.listDbs({})).dbs.map((db) => db.id)).toEqual(["gsv", "manual", "scratch"]);
    expect(client.readCount("hank/gsv", "wiki.json")).toBe(1);
    expect(client.readCount("hank/manual", "wiki.json")).toBe(1);
    expect(client.readCount("hank/scratch", "wiki.json")).toBe(2);
    expect(storage.rows.get("hank/scratch")?.is_wiki).toBe(1);

    expect(await withChangedRepo.deleteDb({ id: "scratch" })).toEqual({
      ok: true,
      id: "scratch",
      removed: true,
    });
    expect((await withChangedRepo.listDbs({})).dbs.map((db) => db.id)).toEqual(["gsv", "manual"]);
    expect(client.readCount("hank/gsv", "wiki.json")).toBe(1);
    expect(client.readCount("hank/manual", "wiki.json")).toBe(1);
    expect(client.readCount("hank/scratch", "wiki.json")).toBe(3);
    expect(storage.rows.get("hank/scratch")?.is_wiki).toBe(0);
  });

  it("does not create a repo when writing a missing page with create disabled", async () => {
    const client = new InMemoryKnowledgeClient();
    const store = new WikiKnowledgeStore(client);

    const write = await store.write({
      path: "missing/pages/nope.md",
      markdown: "# Nope\n",
      create: false,
    });

    expect(write).toEqual({
      ok: false,
      error: "Knowledge note 'missing/pages/nope.md' does not exist",
    });
    expect(client.has("hank/missing", "wiki.json")).toBe(false);
  });

  it("writes, reads, lists, and searches knowledge notes", async () => {
    const store = createStore();

    const write = await store.write({
      path: "personal/pages/alice.md",
      patch: {
        title: "Alice",
        summary: "Design partner working on onboarding.",
        addFacts: ["Prefers concise reviews"],
        addTags: ["people", "design"],
        addSources: [
          {
            target: "gsv",
            path: "/home/alice/projects/onboarding/notes/alice.md",
            title: "Onboarding notes",
          },
        ],
        sections: [
          {
            heading: "Working style",
            content: [
              "- Async first",
              "- Appreciates direct feedback",
            ],
          },
        ],
      },
      create: true,
    });

    expect(write).toEqual({
      ok: true,
      path: "personal/pages/alice.md",
      created: true,
      updated: false,
    });

    const read = await store.read({ path: "personal/pages/alice.md" });
    expect(read.exists).toBe(true);
    expect(read.title).toBe("Alice");
    expect(read.markdown).toContain("## Facts");
    expect(read.markdown).toContain("Prefers concise reviews");
    expect(read.markdown).toContain("## Working style");
    expect(read.markdown).toContain("Async first");
    expect(read.sources).toEqual([
      {
        target: "gsv",
        path: "/home/alice/projects/onboarding/notes/alice.md",
        title: "Onboarding notes",
      },
    ]);

    const list = await store.list({ prefix: "personal/pages", recursive: true });
    expect(list.entries).toEqual([
      {
        path: "personal/pages/alice.md",
        kind: "file",
        title: "alice",
      },
    ]);

    const index = await store.read({ path: "personal/index.md" });
    expect(index.exists).toBe(true);
    expect(index.markdown).toContain("pages/alice.md");

    const search = await store.search({ query: "concise", prefix: "personal/pages" });
    expect(search.matches).toHaveLength(1);
    expect(search.matches[0]?.path).toBe("personal/pages/alice.md");
  });

  it("ingests live source refs directly into db pages", async () => {
    const store = createStore();

    const ingest = await store.ingest({
      db: "personal",
      title: "Alice onboarding notes",
      summary: "Durable notes collected from onboarding work.",
      sources: [
        {
          target: "gsv",
          path: "/home/alice/projects/onboarding/notes/alice.md",
          title: "Onboarding notes",
        },
        {
          target: "macbook",
          path: "/Users/hank/Downloads/alice-review.txt",
        },
      ],
    });

    expect(ingest.ok).toBe(true);
    if (!ingest.ok) {
      throw new Error("expected ingest to succeed");
    }
    expect(ingest.path).toBe("personal/pages/alice-onboarding-notes.md");

    const page = await store.read({ path: ingest.path });
    expect(page.exists).toBe(true);
    expect(page.sources).toEqual([
      {
        target: "gsv",
        path: "/home/alice/projects/onboarding/notes/alice.md",
        title: "Onboarding notes",
      },
      {
        target: "macbook",
        path: "/Users/hank/Downloads/alice-review.txt",
      },
    ]);
    expect(page.markdown).toContain("## Sources");
    expect(page.markdown).toContain("[gsv] /home/alice/projects/onboarding/notes/alice.md | Onboarding notes");

    const dbs = await store.listDbs({});
    expect(dbs.dbs).toEqual([
      {
        id: "personal",
        title: "personal",
      },
    ]);

    const index = await store.read({ path: "personal/index.md" });
    expect(index.exists).toBe(true);
    expect(index.markdown).toContain("pages/alice-onboarding-notes.md");

    const log = await store.read({ path: "personal/log.md" });
    expect(log.exists).toBe(false);
  });

  it("merges duplicate notes into the target and removes the source by default", async () => {
    const store = createStore(undefined, {
      "hank/people": wikiRepo("people", "People", {
        "alice.md": [
          "# Alice",
          "",
          "## Facts",
          "- Prefers concise replies",
          "",
          "## Evidence",
          "- Mentioned in onboarding review",
          "",
        ].join("\n"),
        "alice-smith.md": [
          "# Alice Smith",
          "",
          "## Facts",
          "- Works in product design",
          "",
          "## Evidence",
          "- Added during design kickoff",
          "",
        ].join("\n"),
      }),
    });

    const merged = await store.merge({
      sourcePath: "people/alice.md",
      targetPath: "people/alice-smith.md",
    });

    expect(merged).toEqual({
      ok: true,
      sourcePath: "people/alice.md",
      targetPath: "people/alice-smith.md",
      removedSource: true,
    });

    const target = await store.read({ path: "people/alice-smith.md" });
    expect(target.exists).toBe(true);
    expect(target.markdown).toContain("Prefers concise replies");
    expect(target.markdown).toContain("Works in product design");

    const source = await store.read({ path: "people/alice.md" });
    expect(source.exists).toBe(false);
  });

  it("builds compact query briefs from matching notes", async () => {
    const store = createStore(undefined, {
      "hank/projects": wikiRepo("projects", "Projects", {
        "alpha.md": [
          "# Project Alpha",
          "",
          "Shipping the alpha deployment for daily driving.",
          "",
          "## Facts",
          "- Focus is adapters UX",
          "- Goal is production alpha readiness",
          "",
        ].join("\n"),
      }),
    });

    const search = await store.search({
      query: "alpha adapters",
      prefix: "projects",
    });

    expect(search.matches.map((match) => ({ path: match.path, title: match.title }))).toEqual([
      {
        path: "projects/alpha.md",
        title: "Project Alpha",
      },
    ]);
    expect(search.matches[0]?.snippet).toContain("Project Alpha");
  });
});

describe("Wiki CLI", () => {
  it("prints collection info with repo access and a title-based tree", async () => {
    const client = new InMemoryKnowledgeClient(undefined, {
      "hank/gsv-manual": wikiRepo("gsv-manual", "GSV Manual", {
        "index.md": [
          "# GSV Manual",
          "",
          "## Pages",
          "- pages/connect.md",
          "- pages/setup/install-cli.md",
          "- pages/whatsapp.md",
          "",
        ].join("\n"),
        "pages/connect.md": [
          "# Connect Devices",
          "",
          "Connect native shell devices to the workspace.",
          "",
        ].join("\n"),
        "pages/setup/install-cli.md": [
          "# Install CLI",
          "",
          "Install and pair the local command line.",
          "",
        ].join("\n"),
        "pages/whatsapp.md": [
          "# WhatsApp Adapter",
          "",
          "Pair messages with the channel adapter.",
          "",
        ].join("\n"),
      }),
    });
    client.setWritable("hank/gsv-manual", false);

    const output = await runWikiCommand(commandContext(client, ["info", "gsv-manual"]));

    expect(output).toBe([
      "id: gsv-manual",
      "title: GSV Manual",
      "repo: hank/gsv-manual",
      "access: read-only",
      "tree:",
      "- GSV Manual (index.md)",
      "- pages/",
      "  - setup/",
      "    - Install CLI (pages/setup/install-cli.md)",
      "  - Connect Devices (pages/connect.md)",
      "  - WhatsApp Adapter (pages/whatsapp.md)",
      "",
    ].join("\n"));
    expect(output).not.toContain("wiki.json");
    expect(output).not.toContain(".dir");
  });

  it("reports a missing wiki for info", async () => {
    const client = new InMemoryKnowledgeClient(undefined, {
      "hank/gsv": wikiRepo("gsv", "GSV Manual", {
        "pages/connect.md": "# Connect Devices\n",
      }),
    });

    await expect(runWikiCommand(commandContext(client, ["info", "missing"]))).rejects.toThrow(
      "Wiki collection 'missing' does not exist",
    );
  });

  it("parses multi-word search queries and emits JSON search results", async () => {
    const client = new InMemoryKnowledgeClient(undefined, {
      "hank/gsv": wikiRepo("gsv", "GSV Manual", {
        "index.md": [
          "# GSV Manual",
          "",
          "## Pages",
          "- pages/connect.md",
          "- pages/whatsapp.md",
          "",
        ].join("\n"),
        "pages/connect.md": [
          "# Connect Devices",
          "",
          "Connect native shell devices to the workspace.",
          "",
        ].join("\n"),
        "pages/whatsapp.md": [
          "# WhatsApp Adapter",
          "",
          "Pair messages with the channel adapter.",
          "",
        ].join("\n"),
      }),
    });

    const output = await runWikiCommand(commandContext(client, [
      "search",
      "connect",
      "whatsapp",
      "--prefix",
      "gsv",
      "--json",
    ]));
    const parsed = JSON.parse(output) as { matches: Array<{ path: string }> };
    expect(parsed.matches.map((match) => match.path)).toContain("gsv/pages/whatsapp.md");

    const quotedOutput = await runWikiCommand(commandContext(client, [
      "search",
      "connect whatsapp",
      "--prefix",
      "gsv",
      "--json",
    ]));
    const quoted = JSON.parse(quotedOutput) as { matches: Array<{ path: string }> };
    expect(quoted.matches.map((match) => match.path)).toContain("gsv/pages/whatsapp.md");

    const brief = await runWikiCommand(commandContext(client, [
      "brief",
      "connect",
      "whatsapp",
      "--prefix",
      "gsv",
      "--limit",
      "1",
    ]));
    expect(brief).toContain("1. ");
    expect(brief).toContain("path: gsv/pages/");
  });

  it("emits JSON for db list, list, and read", async () => {
    const client = new InMemoryKnowledgeClient(undefined, {
      "hank/gsv": wikiRepo("gsv", "GSV Manual", {
        "index.md": [
          "# GSV Manual",
          "",
          "## Pages",
          "- pages/whatsapp.md",
          "",
        ].join("\n"),
        "pages/whatsapp.md": [
          "# WhatsApp Adapter",
          "",
          "Pair messages with the channel adapter.",
          "",
        ].join("\n"),
      }),
    });

    const dbList = JSON.parse(await runWikiCommand(commandContext(client, ["db", "list", "--json"]))) as {
      dbs: Array<{ id: string; title?: string }>;
    };
    expect(dbList.dbs).toEqual([{ id: "gsv", title: "GSV Manual" }]);

    const list = JSON.parse(await runWikiCommand(commandContext(client, ["list", "gsv/pages", "--json"]))) as {
      entries: Array<{ path: string; kind: "file" | "dir"; title?: string }>;
    };
    expect(list.entries).toContainEqual({
      path: "gsv/pages/whatsapp.md",
      kind: "file",
      title: "whatsapp",
    });

    const read = JSON.parse(await runWikiCommand(commandContext(client, [
      "read",
      "gsv/pages/whatsapp.md",
      "--json",
    ]))) as { path: string; exists: boolean; title?: string; markdown?: string };
    expect(read).toMatchObject({
      path: "gsv/pages/whatsapp.md",
      exists: true,
      title: "WhatsApp Adapter",
    });
    expect(read.markdown).toContain("Pair messages");
  });

  it("uses stdin for write text", async () => {
    const client = new InMemoryKnowledgeClient();

    const written = await runWikiCommand(commandContext(
      client,
      ["write", "gsv/pages/stdin.md"],
      "# From stdin\n\nConnect WhatsApp from piped text.\n",
    ));
    expect(written).toBe("created gsv/pages/stdin.md\n");

    const readWritten = await runWikiCommand(commandContext(client, ["read", "gsv/pages/stdin.md"]));
    expect(readWritten).toContain("Connect WhatsApp from piped text.");
  });
});
