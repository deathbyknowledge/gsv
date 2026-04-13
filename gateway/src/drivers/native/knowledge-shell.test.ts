import { describe, expect, it, vi } from "vitest";
import { runMemCommand, runWikiCommand } from "./knowledge-shell";
import type { KernelContext } from "../../kernel/context";
import type {
  KnowledgeCompileArgs,
  KnowledgeDbInitArgs,
  KnowledgeIngestArgs,
  KnowledgeListArgs,
  KnowledgeMergeArgs,
  KnowledgePromoteArgs,
  KnowledgeQueryArgs,
  KnowledgeReadArgs,
  KnowledgeSearchArgs,
  KnowledgeWriteArgs,
} from "../../syscalls/knowledge";

function makeContext(capabilities: string[] = ["*"]): KernelContext {
  return {
    identity: {
      role: "user",
      process: {
        uid: 1000,
        gid: 1000,
        gids: [1000],
        username: "hank",
        home: "/home/hank",
        cwd: "/home/hank",
        workspaceId: null,
      },
      capabilities,
    },
  } as KernelContext;
}

function makeOps() {
  return {
    dbList: vi.fn(async () => ({ dbs: [] })),
    dbInit: vi.fn(async (_ctx: KernelContext, args: KnowledgeDbInitArgs) => ({ ok: true, id: args.id, created: true })),
    list: vi.fn(async (_ctx: KernelContext, _args: KnowledgeListArgs) => ({ entries: [] })),
    read: vi.fn(async (_ctx: KernelContext, args: KnowledgeReadArgs) => ({ exists: true, path: args.path, markdown: "# test\n" })),
    write: vi.fn(async (_ctx: KernelContext, args: KnowledgeWriteArgs) => ({ ok: true, path: args.path, created: true, updated: false })),
    search: vi.fn(async (_ctx: KernelContext, _args: KnowledgeSearchArgs) => ({ matches: [] })),
    query: vi.fn(async (_ctx: KernelContext, _args: KnowledgeQueryArgs) => ({ brief: "## Relevant knowledge\n", refs: [] })),
    ingest: vi.fn(async (_ctx: KernelContext, args: KnowledgeIngestArgs) => ({
      ok: true,
      db: args.db,
      path: args.path ?? `${args.db}/inbox/example.md`,
      created: true,
      requiresReview: true,
    })),
    compile: vi.fn(async (_ctx: KernelContext, args: KnowledgeCompileArgs) => ({
      ok: true,
      db: args.db,
      path: args.targetPath ?? `${args.db}/pages/example.md`,
      sourcePath: args.sourcePath,
      removedSource: !args.keepSource,
    })),
    merge: vi.fn(async (_ctx: KernelContext, args: KnowledgeMergeArgs) => ({
      ok: true,
      sourcePath: args.sourcePath,
      targetPath: args.targetPath,
      removedSource: !args.keepSource,
    })),
    promote: vi.fn(async (_ctx: KernelContext, args: KnowledgePromoteArgs) => ({
      ok: true,
      path: args.targetPath ?? "personal/inbox/example.md",
      created: true,
      requiresReview: args.mode !== "direct",
    })),
  };
}

describe("knowledge shell wrappers", () => {
  it("wiki help is self-documenting", async () => {
    const result = await runWikiCommand(["help"], makeContext(), makeOps());

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Wiki manages durable knowledge databases made of markdown pages and live source references.");
    expect(result.stdout).toContain("search finds matching notes; query returns a compact brief with references");
    expect(result.stdout).toContain("wiki help section");
  });

  it("mem write resolves paths relative to the personal db", async () => {
    const ops = makeOps();

    const result = await runMemCommand(
      ["write", "pages/people/alice.md", "--text", "# Alice"],
      makeContext(["knowledge.write"]),
      ops,
    );

    expect(result.exitCode).toBe(0);
    expect(ops.write).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        path: "personal/pages/people/alice.md",
        markdown: "# Alice",
      }),
    );
  });

  it("mem section append preserves explicit section editing", async () => {
    const ops = makeOps();

    const result = await runMemCommand(
      ["section", "append", "pages/people/alice.md", "Working style", "--text", "- Async first"],
      makeContext(["knowledge.write"]),
      ops,
    );

    expect(result.exitCode).toBe(0);
    expect(ops.write).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        path: "personal/pages/people/alice.md",
        patch: {
          sections: [
            {
              heading: "Working style",
              mode: "append",
              content: "- Async first",
            },
          ],
        },
      }),
    );
  });

  it("wiki source add parses live source refs", async () => {
    const ops = makeOps();

    const result = await runWikiCommand(
      ["source", "add", "product/pages/auth.md", "--source", "gsv:/workspaces/gsv/specs/auth.md::Auth spec"],
      makeContext(["knowledge.write"]),
      ops,
    );

    expect(result.exitCode).toBe(0);
    expect(ops.write).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        path: "product/pages/auth.md",
        patch: {
          addSources: [
            {
              target: "gsv",
              path: "/workspaces/gsv/specs/auth.md",
              title: "Auth spec",
            },
          ],
        },
      }),
    );
  });

  it("mem list accepts -r as a recursive alias", async () => {
    const ops = makeOps();

    const result = await runMemCommand(
      ["list", "inbox", "-r"],
      makeContext(["knowledge.list"]),
      ops,
    );

    expect(result.exitCode).toBe(0);
    expect(ops.list).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        prefix: "personal/inbox",
        recursive: true,
      }),
    );
  });
});
