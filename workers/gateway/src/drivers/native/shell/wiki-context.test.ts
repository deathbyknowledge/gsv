import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationMessage, RepoApplyArgs } from "@humansandmachines/gsv/protocol";
import type { KernelContext } from "../../../kernel/context";
import { testPeer } from "../../../test-support/peers";
import * as conversations from "../../../kernel/conversation-handlers";
import * as generation from "../../../kernel/ai";
import * as decisions from "../../../kernel/decisions";
import * as repositories from "../../../kernel/repo";
import { buildWikiContext } from "./wiki-context";

const history = vi.spyOn(conversations, "handleConversationHistory");
const generate = vi.spyOn(generation, "handleAiTextGenerate");
const decide = vi.spyOn(decisions, "handleAiDecide");
const read = vi.spyOn(repositories, "handleRepoRead");
const refs = vi.spyOn(repositories, "handleRepoRefs");
const search = vi.spyOn(repositories, "handleRepoSearch");
const apply = vi.spyOn(repositories, "handleRepoApply");
const message: ConversationMessage = {
  id: "message-4", conversationId: "ship-a", sequence: 4, text: "Mira suggested a knowledge graph.",
  author: { kind: "user", uid: 1000 }, origin: { kind: "client" }, createdAt: 1000,
};
const files = new Map<string, string>();
const commits: RepoApplyArgs[] = [];
let head: string;
function context(signal?: AbortSignal): KernelContext {
  // SAFETY: The wiki boundary receives mocked repositories, inference and canonical history.
  return { peer: testPeer({ kind: "human", calls: ["*"], account: { uid: 1000, gid: 1000, gids: [100], username: "sam", home: "/home/sam", cwd: "/home/sam" } }),
    auth: { getPasswdByUid: () => ({ username: "sam" }) }, requestSignal: signal,
  } as unknown as KernelContext;
}
function generated(value: object): Awaited<ReturnType<typeof generation.handleAiTextGenerate>> {
  // SAFETY: The workflow consumes only stopReason and generated text.
  return { message: { stopReason: "stop" }, text: JSON.stringify(value) } as Awaited<ReturnType<typeof generation.handleAiTextGenerate>>;
}

beforeEach(() => {
  vi.resetAllMocks();
  files.clear(); commits.length = 0; head = "head-0";
  // SAFETY: The workflow reads only the canonical messages from this response.
  history.mockResolvedValue({ messages: [message] } as Awaited<ReturnType<typeof conversations.handleConversationHistory>>);
  read.mockImplementation(async ({ repo, path, ref }) => {
    const content = files.get(path ?? "");
    if (content === undefined) throw new Error(`Path not found: ${path}`);
    return { repo, path: path!, ref: ref ?? "main", kind: "file", size: content.length, isBinary: false, content };
  });
  refs.mockImplementation(async ({ repo }) => ({ repo, heads: { main: head }, tags: {} }));
  search.mockImplementation(async ({ repo, query }) => ({ repo, query, ref: "main", matches: [], truncated: false }));
  apply.mockImplementation(async (args) => {
    if (args.expectedHead !== head) throw new Error("revision conflict");
    commits.push(args);
    for (const op of args.ops) if (op.type === "put") files.set(op.path, op.content ?? "");
    head = `head-${commits.length}`;
    return { repo: args.repo, ref: "main", head, ok: true };
  });
  generate.mockResolvedValueOnce(generated({ mentions: [{ text: "Mira", kind: "person" }, { text: "invented person", kind: "person" }] }))
    .mockResolvedValue(generated({ notes: [{ id: "mention_0", markdown: "Mira suggested a knowledge graph; this remains a proposal." }] }));
  decide.mockResolvedValue({ provider: "typesafe", model: "jev-latest", answers: { keep_0: { type: "boolean", probability: 0.95 } }, usage: { inputTokens: 1, outputTokens: 1 } });
});

describe("source-backed wiki enrichment", () => {
  it("discards invented spans and reuses the saved source on repeated requests", async () => {
    const first = await buildWikiContext(["ship-a", "4"], context(), true);
    expect(first.mentions).toHaveLength(1);
    expect(first.mentions[0]).toMatchObject({ text: "Mira", status: "created" });
    const page = files.get(first.mentions[0].path!)!;
    expect(page).toContain("Message: message-4");
    expect(page).toContain("> Mira suggested a knowledge graph.");
    expect(await buildWikiContext(["ship-a", "4"], context(), true)).toEqual(first);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(decide).toHaveBeenCalledOnce();
    expect(commits).toHaveLength(2);
    expect(commits.every((commit) => commit.repo === "sam/personal" && commit.expectedHead)).toBe(true);
  });

  it("does not write generated notes after cancellation", async () => {
    const controller = new AbortController();
    await buildWikiContext(["ship-a", "4"], context(), false);
    generate.mockImplementation(async () => {
      controller.abort(new Error("stopped"));
      return generated({ notes: [{ id: "mention_0", markdown: "A late note" }] });
    });
    await expect(buildWikiContext(["ship-a", "4"], context(controller.signal), true)).rejects.toThrow("stopped");
    expect([...files.keys()].some((path) => path.startsWith("pages/"))).toBe(false);
  });

  it("keeps a concurrent human edit instead of replacing the saved context", async () => {
    await buildWikiContext(["ship-a", "4"], context(), false);
    const cachePath = [...files.keys()][0];
    generate.mockImplementation(async () => {
      const saved = JSON.parse(files.get(cachePath)!);
      saved.mentions[0].status = "uncertain";
      files.set(cachePath, JSON.stringify(saved));
      return generated({ notes: [{ id: "mention_0", markdown: "A stale note" }] });
    });
    await expect(buildWikiContext(["ship-a", "4"], context(), true)).rejects.toThrow("context changed");
    expect(commits).toHaveLength(1);
    expect([...files.keys()].some((path) => path.startsWith("pages/"))).toBe(false);
  });

  it("does not infer novelty from truncated search results", async () => {
    search.mockImplementation(async ({ repo, query }) => ({ repo, query, ref: "main", matches: [], truncated: true }));
    const found = await buildWikiContext(["ship-a", "4"], context(), true);
    expect(found.mentions[0].status).toBe("uncertain");
    expect(generate).toHaveBeenCalledOnce();
  });
});
