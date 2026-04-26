import { describe, expect, it } from "vitest";
import type {
  RepoApplyOp,
  RepoReadResult,
  RepoSummary,
  RepoTreeEntry,
} from "@gsv/protocol/syscalls/repositories";
import { WikiKnowledgeStore } from "../../../../builtin-packages/wiki/src/backend/knowledge-store";

class InMemoryKnowledgeClient {
  private readonly files = new Map<string, string>();

  constructor(initial?: Record<string, string>) {
    for (const [path, content] of Object.entries(initial ?? {})) {
      this.files.set(path, content);
    }
  }

  async request<T = unknown>(name: string, args: unknown): Promise<T> {
    if (name === "repo.list") {
      const repos: RepoSummary[] = [
        {
          repo: "uid-1/home",
          owner: "uid-1",
          name: "home",
          kind: "home",
          writable: true,
          public: false,
        },
      ];
      return { repos } as T;
    }
    if (name === "repo.read") {
      const { path = "" } = args as { path?: string };
      return this.readPath(path) as T;
    }
    if (name === "repo.apply") {
      const { ops } = args as { ops: RepoApplyOp[] };
      this.apply(ops);
      return { ok: true, repo: "uid-1/home", ref: "main", head: "head" } as T;
    }
    throw new Error(`unexpected request ${name}`);
  }

  private readPath(path: string): RepoReadResult {
    const exact = this.files.get(path);
    if (typeof exact === "string") {
      return {
        repo: "uid-1/home",
        ref: "main",
        path,
        kind: "file",
        size: new TextEncoder().encode(exact).length,
        isBinary: false,
        content: exact,
      };
    }

    const prefix = path ? `${path}/` : "";
    const children = [...this.files.keys()].filter((candidate) => candidate.startsWith(prefix));
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
      repo: "uid-1/home",
      ref: "main",
      path,
      kind: "tree",
      entries: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  private apply(ops: RepoApplyOp[]): void {
    for (const op of ops) {
      if (op.type === "put") {
        this.files.set(op.path, op.content ?? "");
        continue;
      }
      if (op.type === "delete") {
        const prefix = `${op.path}/`;
        for (const path of [...this.files.keys()]) {
          if (path === op.path || (op.recursive && path.startsWith(prefix))) {
            this.files.delete(path);
          }
        }
        continue;
      }
      if (op.type === "move") {
        const content = this.files.get(op.from);
        if (typeof content === "string") {
          this.files.set(op.to, content);
          this.files.delete(op.from);
        }
      }
    }
  }
}

function createStore(initial?: Record<string, string>): WikiKnowledgeStore {
  return new WikiKnowledgeStore(new InMemoryKnowledgeClient(initial));
}

describe("WikiKnowledgeStore", () => {
  it("initializes and lists knowledge databases", async () => {
    const store = createStore({
      "knowledge/.dir": "",
    });

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
  });

  it("writes, reads, lists, and searches knowledge notes", async () => {
    const store = createStore({
      "knowledge/.dir": "",
    });

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
            path: "/workspaces/onboarding/notes/alice.md",
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
        path: "/workspaces/onboarding/notes/alice.md",
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

  it("ingests live source refs into inbox notes and compiles them into db pages", async () => {
    const store = createStore({
      "knowledge/.dir": "",
    });

    const ingest = await store.ingest({
      db: "personal",
      title: "Alice onboarding notes",
      summary: "Durable notes collected from onboarding work.",
      sources: [
        {
          target: "gsv",
          path: "/workspaces/onboarding/notes/alice.md",
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
    expect(ingest.path.startsWith("personal/inbox/")).toBe(true);
    expect(ingest.requiresReview).toBe(true);

    const staged = await store.read({ path: ingest.path });
    expect(staged.exists).toBe(true);
    expect(staged.sources).toEqual([
      {
        target: "gsv",
        path: "/workspaces/onboarding/notes/alice.md",
        title: "Onboarding notes",
      },
      {
        target: "macbook",
        path: "/Users/hank/Downloads/alice-review.txt",
      },
    ]);
    expect(staged.markdown).toContain("## Sources");
    expect(staged.markdown).toContain("[gsv] /workspaces/onboarding/notes/alice.md | Onboarding notes");

    const compiled = await store.compile({
      db: "personal",
      sourcePath: ingest.path,
      targetPath: "personal/pages/alice.md",
    });

    expect(compiled).toEqual({
      ok: true,
      db: "personal",
      path: "personal/pages/alice.md",
      sourcePath: ingest.path,
      removedSource: true,
    });

    const page = await store.read({ path: "personal/pages/alice.md" });
    expect(page.exists).toBe(true);
    expect(page.sources).toEqual(staged.sources);
    expect(page.markdown).toContain("## Sources");

    const dbs = await store.listDbs({});
    expect(dbs.dbs).toEqual([
      {
        id: "personal",
        title: "personal",
      },
    ]);

    const index = await store.read({ path: "personal/index.md" });
    expect(index.exists).toBe(true);
    expect(index.markdown).toContain("pages/alice.md");

    const log = await store.read({ path: "personal/log.md" });
    expect(log.exists).toBe(false);
  });

  it("merges duplicate notes into the target and removes the source by default", async () => {
    const store = createStore({
      "knowledge/.dir": "",
      "knowledge/people/alice.md": [
        "# Alice",
        "",
        "## Facts",
        "- Prefers concise replies",
        "",
        "## Evidence",
        "- Mentioned in onboarding review",
        "",
      ].join("\n"),
      "knowledge/people/alice-smith.md": [
        "# Alice Smith",
        "",
        "## Facts",
        "- Works in product design",
        "",
        "## Evidence",
        "- Added during design kickoff",
        "",
      ].join("\n"),
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

  it("promotes text into inbox candidates and builds compact query briefs", async () => {
    const store = createStore({
      "knowledge/.dir": "",
      "knowledge/inbox/.dir": "",
      "knowledge/projects/alpha.md": [
        "# Project Alpha",
        "",
        "Shipping the alpha deployment for daily driving.",
        "",
        "## Facts",
        "- Focus is adapters UX",
        "- Goal is production alpha readiness",
        "",
      ].join("\n"),
    });

    const promoted = await store.promote({
      source: { kind: "text", text: "Alice prefers async updates and concise replies." },
      targetPath: "personal/pages/alice.md",
      mode: "inbox",
    });

    expect(promoted.ok).toBe(true);
    if (!promoted.ok) {
      throw new Error("expected inbox promotion");
    }
    expect(promoted.path.startsWith("personal/inbox/")).toBe(true);
    expect(promoted.requiresReview).toBe(true);

    const candidate = await store.read({ path: promoted.path });
    expect(candidate.exists).toBe(true);
    expect(candidate.markdown).toContain("Suggested target: personal/pages/alice.md");

    const query = await store.query({
      query: "alpha adapters",
      prefixes: ["projects"],
    });

    expect(query.refs).toEqual([
      {
        path: "projects/alpha.md",
        title: "Project Alpha",
      },
    ]);
    expect(query.brief).toContain("Project Alpha");
    expect(query.brief).toContain("Focus is adapters UX");
  });
});
