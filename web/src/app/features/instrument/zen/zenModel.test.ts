import { describe, expect, it } from "vitest";
import type { ProcHistoryRecord } from "@humansandmachines/gsv/protocol";
import type { ChatTranscriptRow, ChatTranscriptValue } from "../../chat/domain/transcript";
import { mergeTranscriptRows } from "../../chat/domain/transcriptMerge";
import { transcriptRowsFromRecords } from "../../chat/domain/typedHistory";
import type { LibraryCollection } from "../../gsv-console/library/libraryTypes";
import {
  activitiesForRows,
  answerAttribution,
  answerHistorySnapshot,
  argumentThatMatters,
  defaultPlace,
  formatSeconds,
  linkPlaceReferences,
  momentsFromRows,
  momentsFromConversation,
  memoryPagesForMoment,
  isMessageSend,
  outputText,
  parsePromptInput,
  placeLabel,
  receiptDuration,
  receiptTargets,
  receiptSteps,
  resolvePlace,
  resolveTail,
  trimOutput,
  noteSummary,
  type AnswerHistoryEntry,
  type Moment,
} from "./zenModel";

const places = [
  { id: "laptop", label: "MacBook 16", online: true },
  { id: "office", label: "Office box", online: false },
];

function row(partial: Partial<ChatTranscriptRow> & { id: string }): ChatTranscriptRow {
  return { text: "", time: "", timestamp: null, ...partial };
}

describe("answerAttribution", () => {
  const answer: Pick<Moment, "role" | "text" | "runId" | "timestamp" | "streaming"> = {
    role: "ship", text: "Done.", runId: "r1", timestamp: 200, streaming: false,
  };
  const generation = (timestamp: number, model: string, runId = "r1"): AnswerHistoryEntry => ({
    runId, timestamp, metadata: { provider: { provider: "openai-codex", model } },
  });
  const fallback: AnswerHistoryEntry = {
    runId: "r1", timestamp: 150,
    metadata: {
      provider: { provider: "deepseek", model: "deepseek-chat", responseModel: "deepseek-v3.2" },
      fallback: {
        used: true,
        from: { provider: "openai-codex", model: "gpt-6-astra" },
        to: { provider: "deepseek", model: "deepseek-chat" },
        reason: "Upstream unavailable",
      },
    },
  };

  it("labels the actual response model and evidenced fallback instead of the requested Astra", () => {
    expect(answerAttribution(answer, [generation(100, "gpt-6-astra"), fallback], 200)).toEqual({
      model: "deepseek-v3.2", provider: "deepseek",
      fallbacks: [{ from: "gpt-6-astra", to: "deepseek-chat", reason: "Upstream unavailable" }],
      omittedFallbacks: 0,
    });
  });

  it("prefers responseModel and uses the recorded request model only when absent", () => {
    const request = generation(100, "gpt-6-astra");
    expect(answerAttribution(answer, [request], 200)?.model).toBe("gpt-6-astra");
    expect(answerAttribution(answer, [{ ...request, metadata: {
      provider: { provider: "openai-codex", model: "gpt-6-astra", responseModel: "gpt-6-astra-2026-09" },
    } }], 200)?.model).toBe("gpt-6-astra-2026-09");
  });

  it("keeps each reply in a mixed-model run tied to its own commit cutoff", () => {
    const history = [fallback, generation(100, "gpt-6-astra")];
    const early = answerAttribution({ ...answer, timestamp: 125 }, history, 200);
    expect(early?.model).toBe("gpt-6-astra");
    expect(early?.fallbacks).toEqual([]);
    expect(answerAttribution(answer, history, 200)?.model).toBe("deepseek-v3.2");
    expect(history[0]).toBe(fallback);
  });

  it("does not retag old replies after later generations or another run change model", () => {
    expect(answerAttribution(answer, [
      generation(100, "gpt-6-astra"),
      generation(200, "gpt-5.6-sol", "r2"),
      { ...fallback, timestamp: 300 },
    ], 300)).toMatchObject({ model: "gpt-6-astra", fallbacks: [] });
  });

  it("does not borrow an older model when the latest generation lacks metadata", () => {
    expect(answerAttribution(answer, [
      generation(100, "gpt-6-astra"), { runId: "r1", timestamp: 150 },
    ], 200)).toBeNull();
    expect(answerAttribution(answer, [], 200)).toBeNull();
  });

  it("does not infer an answer model from fallback targets alone", () => {
    expect(answerAttribution(answer, [{ ...fallback, metadata: { fallback: fallback.metadata?.fallback } }], 200))
      .toMatchObject({ model: null, provider: null, fallbacks: [{ from: "gpt-6-astra", to: "deepseek-chat" }] });
  });

  it("requires a committed Ship reply with an attributable run and timestamp", () => {
    for (const change of [
      { role: "human" as const }, { role: "note" as const }, { text: " " },
      { streaming: true }, { runId: null }, { timestamp: null },
    ]) expect(answerAttribution({ ...answer, ...change }, [fallback], 200)).toBeNull();
    expect(answerAttribution(answer, [{ ...fallback, timestamp: null }], 200)).toBeNull();
  });

  it("waits for a history snapshot covering the committed reply before using same-run metadata", () => {
    const previous = generation(100, "gpt-6-astra");
    expect(answerAttribution(answer, [previous], 125)).toBeNull();
    expect(answerAttribution(answer, [previous, fallback], 200)?.model).toBe("deepseek-v3.2");
  });

  it("bounds fallback diagnostics and deduplicates repeated typed generation metadata", () => {
    const history: AnswerHistoryEntry[] = Array.from({ length: 5 }, (_, index) => ({
      runId: "r1", timestamp: 100 + index,
      metadata: {
        provider: { model: `model-${index + 1}` },
        fallback: { used: true, from: { model: `model-${index}` }, to: { model: `model-${index + 1}` }, reason: "x".repeat(1_000_000) },
      },
    }));
    history.push(history[4]);
    const result = answerAttribution(answer, history, 200);
    expect(result?.fallbacks.map(({ from, to }) => [from, to])).toEqual([
      ["model-2", "model-3"], ["model-3", "model-4"], ["model-4", "model-5"],
    ]);
    expect(result?.omittedFallbacks).toBe(2);
    expect(result?.fallbacks.every(({ reason }) => reason?.length === 240 && reason.endsWith("…"))).toBe(true);
  });
});

describe("answerHistorySnapshot", () => {
  it("withholds stale model metadata while a newer assistant group is on the next delta page", () => {
    const answer: Pick<Moment, "role" | "text" | "runId" | "timestamp" | "streaming"> = {
      role: "ship", text: "Done.", runId: "r1", timestamp: 200, streaming: false,
    };
    const previous: ProcHistoryRecord = {
      id: 1, messageId: 1, index: 0, generation: 1, runId: "r1", createdAt: 100, source: "typed",
      kind: "note", payload: { text: "Working", thinking: [] }, metadata: { provider: { model: "gpt-6-astra" } },
    };
    const result: ProcHistoryRecord = {
      id: 3, messageId: 3, index: 0, generation: 1, runId: "r1", createdAt: 210, source: "typed",
      kind: "result", payload: { callId: "send", tool: "Send", outcome: "completed", output: "sent", media: [], resources: [] },
    };
    const partial = answerHistorySnapshot({ pid: "p1", records: [previous, result], hasMore: true }, "p1");
    expect(answerAttribution(answer, partial.entries, partial.through)).toBeNull();

    const current: ProcHistoryRecord = {
      ...previous, id: 2, messageId: 2, createdAt: 150,
      metadata: { provider: { provider: "deepseek", model: "deepseek-chat", responseModel: "deepseek-v3.2" } },
    };
    const history = { pid: "p1", records: [previous, current, result], hasMore: false };
    const complete = answerHistorySnapshot(history, "p1");
    expect(complete.entries).toHaveLength(2);
    expect(complete.through).toBe(210);
    expect(answerAttribution(answer, complete.entries, complete.through)?.model).toBe("deepseek-v3.2");
    expect(answerHistorySnapshot(history, "another-process").entries).toEqual([]);
    expect(answerHistorySnapshot(undefined, "p1").entries).toEqual([]);
  });
});

describe("parsePromptInput", () => {
  it("sends a sentence to the ship", () => {
    expect(parsePromptInput("  what's in my downloads? ")).toEqual({ kind: "say", text: "what's in my downloads?" });
  });
  it("runs a command for $ or !", () => {
    expect(parsePromptInput("$ ls -la")).toEqual({ kind: "run", command: "ls -la" });
    expect(parsePromptInput("!pwd")).toEqual({ kind: "run", command: "pwd" });
    expect(parsePromptInput("$")).toBeNull();
  });
  it("switches place on a bare mention", () => {
    expect(parsePromptInput("@laptop")).toEqual({ kind: "switch", name: "laptop" });
    expect(parsePromptInput("@laptop please")).toEqual({ kind: "say", text: "@laptop please" });
  });
  it("ignores empty input", () => {
    expect(parsePromptInput("   ")).toBeNull();
  });
});

describe("places", () => {
  it("labels the cloud home and known places", () => {
    expect(placeLabel("gsv", places)).toBe("your cloud home");
    expect(placeLabel("laptop", places)).toBe("MacBook 16");
    expect(placeLabel("ghost", places)).toBe("ghost");
  });
  it("resolves by id or label, case-insensitively", () => {
    expect(resolvePlace("LAPTOP", places)).toBe("laptop");
    expect(resolvePlace("office box", places)).toBe("office");
    expect(resolvePlace("cloud", places)).toBe("gsv");
    expect(resolvePlace("nowhere", places)).toBeNull();
  });
  it("defaults the prompt to the first online machine", () => {
    expect(defaultPlace(places)).toBe("laptop");
    expect(defaultPlace([{ id: "office", label: "Office box", online: false }])).toBe("gsv");
  });
});

describe("argumentThatMatters", () => {
  it("picks the command, path, or url by syscall", () => {
    expect(argumentThatMatters("shell.exec", { input: "ls", target: "laptop" })).toBe("ls");
    expect(argumentThatMatters("fs.read", { path: "~/notes.md" })).toBe("~/notes.md");
    expect(argumentThatMatters("net.fetch", { url: "https://example.com" })).toBe("https://example.com");
    expect(argumentThatMatters("ai.text.generate", { prompt: "x" })).toBe("");
  });
});

describe("activitiesForRows", () => {
  it("groups calls by place in first-touch order and merges results into calls", () => {
    const rows = [
      row({ id: "tool:1", role: "tool", toolCallId: "1", toolSyscall: "shell.exec", toolTarget: "laptop", toolArgs: { target: "laptop", input: "ls" }, status: "planning", timestamp: 100 }),
      row({ id: "tool:2", role: "toolResult", toolCallId: "2", toolSyscall: "fs.read", toolTarget: "gsv", toolArgs: { path: "~/a" }, text: "hello", status: "done", timestamp: 150 }),
      row({ id: "tool:1", role: "toolResult", toolCallId: "1", toolSyscall: "shell.exec", toolTarget: "laptop", toolArgs: { target: "laptop", input: "ls" }, text: "a b c", status: "done", timestamp: 200 }),
    ];
    const activities = activitiesForRows(rows, "run", false);
    expect(activities.map((activity) => activity.target)).toEqual(["laptop", "gsv"]);
    expect(activities[0].calls).toHaveLength(1);
    expect(activities[0].calls[0]).toMatchObject({ summary: "ls", output: "a b c", finished: true, failed: false });
    expect(activities[0].endedAt).toBe(200);
    expect(activities[1].calls[0].summary).toBe("~/a");
  });
  it("marks the last activity live while its latest call is unfinished in the active run", () => {
    const rows = [
      row({ id: "tool:1", role: "tool", toolCallId: "1", toolSyscall: "shell.exec", toolTarget: "laptop", toolArgs: { target: "laptop", input: "sleep 5" }, status: "running" }),
    ];
    expect(activitiesForRows(rows, "run", true)[0].live).toBe(true);
    expect(activitiesForRows(rows, "run", false)[0].live).toBe(false);
  });
  it("flags failed and denied calls", () => {
    const rows = [
      row({ id: "tool:1", role: "toolResult", toolCallId: "1", toolSyscall: "shell.exec", toolTarget: "laptop", toolArgs: { target: "laptop", input: "rm x" }, toolOutcome: "denied", status: "done" }),
    ];
    expect(activitiesForRows(rows, "run", false)[0].calls[0].failed).toBe(true);
  });
});

describe("filesystem operation presentation", () => {
  const present = (syscall: string, output: ChatTranscriptValue, overrides: Partial<ChatTranscriptRow> = {}) => activitiesForRows([row({
    id: "operation", role: "toolResult", toolCallId: "operation", toolSyscall: syscall, toolTarget: "gsv",
    toolArgs: { path: "/tmp/requested.txt" }, toolOutput: output, toolOutcome: "completed", status: "done", text: "original diagnostic",
    ...overrides,
  })], "run", false)[0].calls[0];

  it("moves verified mutation confirmations into the heading using returned paths and counts", () => {
    const cases: [string, ChatTranscriptValue, { label: string; subject: string; detail?: string }][] = [
      ["fs.write", { ok: true, path: "/tmp/resolved.txt", size: 11 }, { label: "wrote", subject: "/tmp/resolved.txt", detail: "11 bytes" }],
      ["fs.write", { ok: true, path: "/tmp/empty.txt", size: 0 }, { label: "wrote", subject: "/tmp/empty.txt", detail: "0 bytes" }],
      ["fs.write", { ok: true, path: "/tmp/one.txt", size: 1 }, { label: "wrote", subject: "/tmp/one.txt", detail: "1 byte" }],
      ["fs.edit", { ok: true, path: "/tmp/resolved.txt", replacements: 1 }, { label: "edited", subject: "/tmp/resolved.txt", detail: "1 replacement" }],
      ["fs.edit", { ok: true, path: "/tmp/resolved.txt", replacements: 2 }, { label: "edited", subject: "/tmp/resolved.txt", detail: "2 replacements" }],
      ["fs.delete", { ok: true, path: "/tmp/resolved.txt" }, { label: "deleted", subject: "/tmp/resolved.txt" }],
    ];
    for (const [syscall, output, operation] of cases) {
      const call = present(syscall, output);
      expect(call).toMatchObject({ operation, finished: true, failed: false, output: "" });
      expect(outputText(syscall, output, "fallback")).not.toBe("");
    }
  });

  it.each(["failed", "denied", "cancelled"] as const)("keeps %s operations neutral and retains the diagnostic body", (outcome) => {
    for (const [syscall, label] of [["fs.write", "write"], ["fs.edit", "edit"], ["fs.delete", "delete"]]) {
      expect(present(syscall, { ok: false, error: "permission denied" }, { toolOutcome: outcome })).toMatchObject({
        operation: { label, subject: "/tmp/requested.txt" }, failed: true, output: "permission denied",
      });
    }
  });

  it("does not turn contradictory or unknown outcomes into successful headings or hide their result", () => {
    const output = { ok: true, path: "/tmp/resolved.txt", size: 11 };
    for (const overrides of [
      { toolOutcome: undefined }, { toolOutcome: "failed" as const }, { isError: true }, { status: "error" as const },
    ]) {
      const call = present("fs.write", output, { ...overrides, text: "" });
      expect(call.operation).toEqual({ label: "write", subject: "/tmp/requested.txt" });
      expect(call.output).toBe(JSON.stringify(output, null, 2));
    }
  });

  it("keeps the authoritative typed failure message when its output has a success shape", () => {
    const result = present("fs.write", { ok: true, path: "/tmp/resolved.txt", size: 11 }, {
      toolOutcome: "failed", text: "The returned result could not be retained.",
    });
    expect(result).toMatchObject({ operation: { label: "write", subject: "/tmp/requested.txt" }, failed: true,
      output: "The returned result could not be retained.",
    });
  });

  it("retains malformed mutation data instead of inferring success from the stored prose", () => {
    const malformed: [string, ChatTranscriptValue, string][] = [
      ["fs.write", { ok: true, path: "/tmp/resolved.txt", size: "11" }, "write"],
      ["fs.edit", { ok: true, path: "/tmp/resolved.txt", replacements: -1 }, "edit"],
      ["fs.delete", { ok: true }, "delete"],
    ];
    for (const [syscall, output, label] of malformed) {
      expect(present(syscall, output, { text: "wrote 11 bytes" })).toMatchObject({
        operation: { label, subject: "/tmp/requested.txt" }, output: "wrote 11 bytes",
      });
    }
  });

  it("describes running and planned operations without claiming completion", () => {
    const output = { ok: true, path: "/tmp/resolved.txt", size: 11 };
    const running = present("fs.write", output, { role: "tool", status: "running", toolOutcome: undefined });
    expect(running).toMatchObject({ operation: { label: "writing", subject: "/tmp/requested.txt" }, finished: false, output: "" });
    const planned = present("fs.delete", null, { role: "tool", status: "planning", toolOutcome: undefined });
    expect(planned.operation).toEqual({ label: "delete", subject: "/tmp/requested.txt" });
  });

  it("keeps file content in the body and search query/path separate from matching results", () => {
    const read = present("fs.read", { ok: true, path: "/tmp/requested.txt", kind: "text", content: "line one\nline two" });
    expect(read.operation).toEqual({ label: "read", subject: "/tmp/requested.txt" });
    expect(read.output).toBe("line one\nline two");
    const search = present("fs.search", { ok: true, matches: [{ path: "/tmp/hit.txt", line: 2, content: "needle" }], count: 1 }, {
      toolArgs: { query: "needle", path: "/tmp", include: "*.txt" },
    });
    expect(search.operation).toEqual({ label: "searched", subject: "needle in /tmp" });
    expect(search.output).toBe("/tmp/hit.txt");
    const noScope = present("fs.search", { ok: true, matches: [], count: 0 }, { toolArgs: { query: "needle" } });
    expect(noScope.operation).toEqual({ label: "searched", subject: "needle" });
    const unknown = present("fs.search", { matches: [] }, { toolArgs: { query: "needle", path: "/tmp" } });
    expect(unknown.operation?.label).toBe("search");
    const failed = present("fs.search", { ok: false, error: "search rejected" }, { toolArgs: { query: "needle", path: "/tmp" }, toolOutcome: "failed" });
    expect(failed).toMatchObject({ operation: { label: "search", subject: "needle in /tmp" }, output: "search rejected", failed: true });
  });

  it("does not invent search terms or filesystem operations from tool text", () => {
    const search = present("fs.search", { matches: [] }, { toolArgs: { q: "not query", path: "/tmp" }, text: "searched secret in /elsewhere" });
    expect(search.operation).toEqual({ label: "search", subject: "in /tmp" });
    expect(present("shell.exec", { stdout: "ok", exitCode: 0 }, { toolArgs: { input: "cat file", path: "/tmp" } }).operation).toBeUndefined();
    expect(present("codemode.exec", { status: "completed", result: 1 }, { toolArgs: { code: "return 1;", path: "/tmp" } }).operation).toBeUndefined();
  });

  it("preserves the original search subject when the final result arrives without arguments", () => {
    const calls = activitiesForRows([
      row({ id: "search", role: "tool", status: "running", toolCallId: "search", toolSyscall: "fs.search", toolTarget: "gsv", toolArgs: { query: "needle", path: "/tmp" } }),
      row({ id: "result", role: "toolResult", status: "done", toolCallId: "search", toolSyscall: "fs.search", toolTarget: "gsv", toolOutcome: "completed", toolOutput: { ok: true, matches: [], count: 0 } }),
    ], "run", false)[0].calls;
    expect(calls).toHaveLength(1);
    expect(calls[0].operation).toEqual({ label: "searched", subject: "needle in /tmp" });
  });
});

describe("momentsFromRows", () => {
  it("retains originating process identities on messages, working moments, and events", () => {
    const moments = momentsFromRows([
      row({ id: "human", role: "user", text: "Look", processId: "previous-ship" }),
      row({ id: "call", role: "tool", runId: "work", toolSyscall: "fs.read", toolTarget: "gsv", status: "running" }),
      row({ id: "answer", role: "assistant", runId: "work", text: "Done", processId: "worker" }),
      row({ id: "later", role: "assistant", runId: "work", text: "Still done", processId: "different-process" }),
      row({ id: "event", role: "system", text: "An event", processId: "event-owner" }),
    ], null);
    expect(moments.map((moment) => [moment.role, moment.processId])).toEqual([
      ["human", "previous-ship"], ["ship", "worker"], ["note", "event-owner"],
    ]);
  });
  it("folds a run into a human moment and one ship moment carrying its activities", () => {
    const rows = [
      row({ id: "u1", role: "user", text: "look around", runId: "r1", timestamp: 1 }),
      row({ id: "tool:1", role: "toolResult", toolCallId: "1", toolSyscall: "shell.exec", toolTarget: "laptop", toolArgs: { target: "laptop", input: "ls" }, text: "x", runId: "r1", status: "done", timestamp: 2 }),
      row({ id: "a1", role: "assistant", text: "Fourteen files.", runId: "r1", status: "done", timestamp: 3 }),
    ];
    const moments = momentsFromRows(rows, null);
    expect(moments.map((moment) => moment.role)).toEqual(["human", "ship"]);
    expect(moments[1].text).toBe("Fourteen files.");
    expect(moments[1].activities).toHaveLength(1);
    expect(moments[1].activities[0].target).toBe("laptop");
    expect(moments[1].thinking).toBe(false);
  });
  it("shows a thinking ship moment while the active run has tools but no text", () => {
    const rows = [
      row({ id: "u1", role: "user", text: "go", runId: "r2" }),
      row({ id: "tool:9", role: "tool", toolCallId: "9", toolSyscall: "fs.read", toolTarget: "gsv", toolArgs: { path: "~/x" }, runId: "r2", status: "running" }),
    ];
    const moments = momentsFromRows(rows, "r2");
    expect(moments[1].thinking).toBe(true);
    expect(moments[1].activities[0].live).toBe(true);
  });
  it("keeps a streaming assistant row streaming and skips empty assistant rows", () => {
    const rows = [
      row({ id: "a0", role: "assistant", text: "", runId: "r3", status: "done" }),
      row({ id: "a1", role: "assistant", text: "Working", runId: "r3", streaming: true, status: "streaming" }),
    ];
    const moments = momentsFromRows(rows, "r3");
    expect(moments).toHaveLength(1);
    expect(moments[0].streaming).toBe(true);
  });
});

describe("resolveTail", () => {
  it("keeps the head settled and only noises the tail", () => {
    let calls = 0;
    const random = () => (calls++ % 2 === 0 ? 0 : 0.99);
    const text = "settled text that is long enough to have a tail";
    const result = resolveTail(text, random, 10);
    expect(result.head).toBe(text.slice(0, text.length - 10));
    expect(result.tail).toHaveLength(10);
    expect(result.tail.map((entry) => entry.char).join("")).toBe(text.slice(-10));
    expect(result.tail.every((entry) => entry.noise === null || entry.noise.length === 1)).toBe(true);
  });
  it("never noises spaces", () => {
    const result = resolveTail("a b c d e f", () => 0, 6);
    expect(result.tail.filter((entry) => entry.char === " ").every((entry) => entry.noise === null)).toBe(true);
  });
});

describe("formatting", () => {
  it("formats durations", () => {
    expect(formatSeconds(40)).toBe("0.04s");
    expect(formatSeconds(3800)).toBe("3.8s");
    expect(formatSeconds(72_000)).toBe("1m 12s");
  });
  it("trims long output", () => {
    expect(trimOutput("x".repeat(700))).toMatch(/… 100 more characters$/);
  });
  it("links known place mentions", () => {
    expect(linkPlaceReferences("on @laptop and @nowhere", places)).toBe("on [@laptop](#place:laptop) and @nowhere");
    expect(linkPlaceReferences("mail@laptop", places)).toBe("mail@laptop");
  });
});

describe("noteSummary", () => {
  it("keeps a short note whole", () => {
    expect(noteSummary("Three installers were removed.")).toBe("Three installers were removed.");
  });
  it("takes the first sentence of a long note", () => {
    const text = "Earlier we sorted the downloads folder and filed two invoices. Then a long tail of detail follows that nobody needs on one line.";
    expect(noteSummary(text)).toBe("Earlier we sorted the downloads folder and filed two invoices.");
  });
  it("truncates a long first sentence", () => {
    const text = "a".repeat(200);
    expect(noteSummary(text)).toHaveLength(92);
    expect(noteSummary(text).endsWith("...")).toBe(true);
  });
});

describe("momentsFromConversation", () => {
  const message = (overrides: Partial<ChatTranscriptRow>): ChatTranscriptRow => ({
    id: "m", role: "assistant", text: "", time: "", timestamp: 1_000, ...overrides,
  });
  it("keeps the canonical reply's process when joining another transcript and fills only absent identities", () => {
    const moments = momentsFromConversation([
      message({ id: "old", text: "Old answer", runId: "old-run", processId: "old-ship" }),
      message({ id: "new", text: "New answer", runId: "new-run" }),
      message({ id: "human", role: "user", text: "Question", processId: "conversation-owner" }),
    ], [
      message({ id: "old-note", text: "Old working", runId: "old-run", processId: "current-ship" }),
      message({ id: "new-note", text: "New working", runId: "new-run", processId: "new-ship" }),
      message({ id: "orphan-call", role: "tool", toolSyscall: "fs.read", runId: "working-run", processId: "worker", status: "running" }),
      message({ id: "event", role: "system", text: "Notice", processId: "event-owner" }),
    ], "working-run");
    expect(moments.slice(0, 4).map((moment) => [moment.id, moment.processId])).toEqual([
      ["old", "old-ship"], ["new", "new-ship"], ["human", "conversation-owner"], ["event", "event-owner"],
    ]);
    expect(moments[0].narration).toBe("");
    expect(moments[1].narration).toBe("New working");
    expect(moments[4]).toMatchObject({ processId: "current-ship", text: "", narration: "Old working" });
    expect(moments[5]).toMatchObject({ processId: "worker", thinking: true });
  });
  it("shows what the ship sent, folds what it told itself, and keeps the run's work", () => {
    const messages = [
      message({ id: "u1", role: "user", text: "tidy my downloads", timestamp: 1_000 }),
      message({ id: "a1", role: "assistant", text: "Done: three installers gone.", timestamp: 5_000, runId: "r1" }),
    ];
    const transcript = [
      message({ id: "t1", role: "tool", toolSyscall: "shell.exec", toolArgs: { input: "ls", target: "laptop" }, toolOutcome: "completed", timestamp: 2_000, runId: "r1" }),
      message({ id: "n1", role: "assistant", text: "I should look first, then remove.", timestamp: 3_000, runId: "r1" }),
    ];
    const moments = momentsFromConversation(messages, transcript, null);
    expect(moments.map((moment) => [moment.role, moment.text])).toEqual([
      ["human", "tidy my downloads"],
      ["ship", "Done: three installers gone."],
    ]);
    expect(moments[1].activities).toHaveLength(1);
    expect(moments[1].narration).toBe("I should look first, then remove.");
  });
  it("shows a working moment for an active run that has not sent anything yet", () => {
    const transcript = [message({ id: "t1", role: "tool", toolSyscall: "fs.read", toolTarget: "gsv", toolArgs: { path: "~/a" }, timestamp: 2_000, runId: "r2", status: "running" })];
    const moments = momentsFromConversation([], transcript, "r2");
    expect(moments).toHaveLength(1);
    expect(moments[0]).toMatchObject({ role: "ship", text: "", thinking: true, runId: "r2" });
  });

  const sent = (id: string, timestamp: number, overrides: Partial<ChatTranscriptRow> = {}) => message({
    id: `conversation:${id}`, messageId: id, runId: "run", processId: "ship", text: id, timestamp, ...overrides,
  });
  const call = (id: string, timestamp: number, overrides: Partial<ChatTranscriptRow> = {}) => message({
    id, role: "toolResult", text: "", toolCallId: id, toolSyscall: "fs.read", toolTarget: "gsv",
    toolArgs: { path: `/pages/${id}.md` }, toolOutput: id, toolOutcome: "completed", status: "done",
    runId: "run", processId: "ship", timestamp, ...overrides,
  });
  const outgoing = (id: string, key: string, timestamp: number) => message({
    id: `history:${key}`, historyRecordKey: key, messageDirection: "out", conversationMessageId: id,
    text: id, runId: "run", processId: "ship", timestamp,
  });
  const callsOf = (moment: Moment) => moment.activities.flatMap((activity) => activity.calls.map((entry) => entry.callId));

  it("partitions two Sends and trailing work without duplicating narration or calls", () => {
    const messages = [sent("first", 20), sent("second", 40)];
    const transcript = [
      call("before-first", 10), message({ id: "n1", runId: "run", processId: "ship", text: "First thought", timestamp: 11 }),
      outgoing("first", "20:0", 20),
      call("before-second", 30), message({ id: "n2", runId: "run", processId: "ship", text: "Second thought", timestamp: 31 }),
      outgoing("second", "40:0", 40),
      call("after-second", 50), message({ id: "n3", runId: "run", processId: "ship", text: "More work", timestamp: 51 }),
      call("send-control", 52, { toolName: "Send", toolSyscall: null }),
      call("shell-control", 53, { toolName: "Shell", toolSyscall: null, toolRunControl: true }),
    ];
    const moments = momentsFromConversation(messages, transcript, "run");
    expect(moments.map((entry) => [entry.text, callsOf(entry), entry.narration])).toEqual([
      ["first", ["before-first"], "First thought"],
      ["second", ["before-second"], "Second thought"],
      ["", ["after-second"], "More work"],
    ]);
    expect(moments.slice(0, 2).map(({ id, timestamp, processId }) => ({ id, timestamp, processId }))).toEqual([
      { id: "conversation:first", timestamp: 20, processId: "ship" },
      { id: "conversation:second", timestamp: 40, processId: "ship" },
    ]);
    expect(new Set(moments.flatMap((entry) => entry.activities.map((activity) => activity.key))).size).toBe(3);
    const completed = momentsFromConversation(messages, transcript, null);
    expect(completed.map((entry) => entry.id)).toEqual(moments.map((entry) => entry.id));
    expect(completed.at(-1)?.thinking).toBe(false);
    const next = momentsFromConversation([...messages, sent("third", 60)], transcript, null);
    expect(next.map((entry) => [entry.text, callsOf(entry)])).toEqual([
      ["first", ["before-first"]], ["second", ["before-second"]], ["third", ["after-second"]],
    ]);
  });

  it("keeps interleaved processes and runs in their own message intervals", () => {
    const messages = [sent("one", 20), sent("other-process", 30, { processId: "worker" }), sent("other-run", 35, { runId: "run2" }), sent("two", 50)];
    const transcript = [call("a", 10), call("b", 15, { processId: "worker" }), call("c", 25, { runId: "run2" }), call("d", 40), call("e", 45, { processId: "worker" })];
    const moments = momentsFromConversation(messages, transcript, null);
    expect(moments.map((entry) => [entry.text, entry.processId, callsOf(entry)])).toEqual([
      ["one", "ship", ["a"]], ["other-process", "worker", ["b"]], ["other-run", "ship", ["c"]],
      ["", "worker", ["e"]], ["two", "ship", ["d"]],
    ]);
  });

  it("uses durable call and outgoing coordinates when multiple Sends share one millisecond", () => {
    const messages = [sent("first", 100, { conversationSequence: 1 }), sent("second", 100, { conversationSequence: 2 })];
    const transcript = [
      call("first-call", 300, { historyRecordKey: "9:0", toolCallRecordKey: "1:1", toolStartedAt: 100 }),
      outgoing("first", "2:0", 100),
      call("second-call", 300, { historyRecordKey: "10:0", toolCallRecordKey: "3:1", toolStartedAt: 100 }),
      outgoing("second", "4:0", 100),
      call("last-call", 300, { historyRecordKey: "11:0", toolCallRecordKey: "5:1", toolStartedAt: 99 }),
    ];
    const moments = momentsFromConversation(messages, transcript, null).sort((left, right) => (left.timestamp ?? 0) - (right.timestamp ?? 0));
    expect(moments.map((entry) => [entry.text, callsOf(entry)])).toEqual([
      ["first", ["first-call"]], ["second", ["second-call"]], ["", ["last-call"]],
    ]);
    expect(moments.at(-1)?.timestamp).toBe(100);
    expect(moments.at(-1)?.activities[0].startedAt).toBe(99);
  });

  it("keeps a pending parallel call with the message it preceded when completion arrives after a later Send", () => {
    const messages = [sent("first", 20), sent("second", 40)];
    const pending = call("slow", 10, { role: "tool", status: "running", toolOutcome: undefined, toolOutput: undefined, toolTarget: "laptop" });
    const between = call("quick", 30);
    const before = momentsFromConversation(messages, [pending, between], "run");
    expect(before.map(callsOf)).toEqual([["slow"], ["quick"]]);
    expect(before[0].activities[0].live).toBe(true);
    const result = call("slow", 60, { toolArgs: undefined, toolTarget: undefined, toolSyscall: undefined, toolOutput: "finished later" });
    const after = momentsFromConversation(messages, [pending, between, result], "run");
    expect(after.map(callsOf)).toEqual([["slow"], ["quick"]]);
    expect(after[0].activities[0]).toMatchObject({ target: "laptop", startedAt: 10, endedAt: 60, live: false });
    expect(after[0].activities[0].calls[0]).toMatchObject({ finished: true, output: "finished later", filePath: "/pages/slow.md" });
    const reloaded = momentsFromConversation(messages, [{ ...result, toolStartedAt: 10, toolTarget: "laptop", toolSyscall: "fs.read", toolArgs: pending.toolArgs }, between], "run");
    expect(reloaded).toEqual(after);
  });

  it("joins a streamed message to its committed identity without repeating its work", () => {
    const streaming = sent("first", 20, { id: "stream:first", text: "Fir", streaming: true });
    const committed = sent("first", 20, { text: "First answer", streaming: false });
    const transcript = [call("a", 10), call("b", 30)];
    const live = momentsFromConversation([streaming], transcript, "run");
    const durable = momentsFromConversation([streaming, committed], [...transcript, outgoing("first", "20:0", 20)], "run");
    expect(live.map(callsOf)).toEqual([["a"], ["b"]]);
    expect(durable.map(callsOf)).toEqual([["a"], ["b"]]);
    expect(durable[0]).toMatchObject({ id: committed.id, text: "First answer", streaming: false, timestamp: 20 });
    expect(durable[1].id).toBe(live[1].id);
    expect(momentsFromConversation([committed, streaming], transcript, "run")[0]).toMatchObject({ id: committed.id, streaming: false });
  });

  it("does not attach work before an unloaded Send to the next visible message", () => {
    const moments = momentsFromConversation([sent("visible", 40)], [
      call("old", 10), outgoing("unloaded", "20:0", 20), call("current", 30), outgoing("visible", "40:0", 40),
    ], null);
    expect(moments.map((entry) => [entry.text, callsOf(entry)])).toEqual([["", ["old"]], ["visible", ["current"]]]);
  });

  it("keeps same-millisecond unpersisted work in deterministic input order without merging distinct messages", () => {
    const moments = momentsFromConversation([sent("first", 100), sent("second", 100)], [call("a", 100), call("b", 100)], null);
    expect(moments.map((entry) => [entry.id, callsOf(entry)])).toEqual([
      ["conversation:first", ["a", "b"]], ["conversation:second", []],
    ]);
  });

  it("preserves call placement through actual typed projection and a partial live-result merge", () => {
    const envelope = (messageId: number, createdAt: number) => ({
      id: messageId, messageId, index: 0, generation: 1, runId: "run", createdAt, source: "typed" as const,
    });
    const before: ProcHistoryRecord[] = [
      { ...envelope(1, 10), kind: "call", payload: { callId: "slow", tool: "Read", syscall: "fs.read", args: { path: "/pages/slow.md" }, target: "laptop", runId: "run" } },
      { ...envelope(2, 20), kind: "message", payload: { direction: "out", text: "first", media: [], origin: {}, conversationMessageId: "first" } },
    ];
    const projected = transcriptRowsFromRecords(before).map((entry) => ({ ...entry, processId: "ship" }));
    const messages = [sent("first", 20), sent("second", 40)];
    const pending = momentsFromConversation(messages, projected, "run");
    expect(pending.map(callsOf)).toEqual([["slow"], []]);
    expect(pending[0].activities[0].live).toBe(true);
    const merged = mergeTranscriptRows(projected, [row({
      id: "finish", role: "toolResult", runId: "run", toolCallId: "slow", toolName: "Read", text: "", toolOutput: "finished", status: "done", timestamp: 60,
    })]);
    const live = momentsFromConversation(messages, merged, "run");
    const after: ProcHistoryRecord[] = [...before,
      { ...envelope(3, 40), kind: "message", payload: { direction: "out", text: "second", media: [], origin: {}, conversationMessageId: "second" } },
      { ...envelope(4, 60), kind: "result", payload: { callId: "slow", tool: "Read", outcome: "completed", output: "finished", media: [], resources: [] } },
    ];
    const durable = momentsFromConversation(messages, transcriptRowsFromRecords(after).map((entry) => ({ ...entry, processId: "ship" })), "run");
    expect(live).toEqual(durable);
    expect(durable[0].activities[0]).toMatchObject({ startedAt: 10, endedAt: 60, target: "laptop", live: false });
    expect(durable.map(callsOf)).toEqual([["slow"], []]);
  });

  it("retains distinct identities and unknown times for unlinked historical work", () => {
    const moments = momentsFromConversation([], [
      call("a", 1, { runId: undefined, timestamp: null }), call("b", 2, { runId: undefined, timestamp: null }),
    ], null);
    expect(moments.map(callsOf)).toEqual([["a"], ["b"]]);
    expect(new Set(moments.map((entry) => entry.id)).size).toBe(2);
    expect(moments.map((entry) => entry.timestamp)).toEqual([null, null]);
  });

  it("orders parallel calls by start while retaining the last completion time for the target", () => {
    const moments = momentsFromConversation([sent("first", 20)], [
      call("fast", 15, { toolStartedAt: 11 }), call("slow", 60, { toolStartedAt: 10 }),
    ], null);
    expect(moments).toHaveLength(1);
    expect(callsOf(moments[0])).toEqual(["slow", "fast"]);
    expect(moments[0].activities[0]).toMatchObject({ startedAt: 10, endedAt: 60 });
    expect(receiptDuration(moments[0])).toBe(formatSeconds(50));
  });
});

describe("memoryPagesForMoment", () => {
  const personal: LibraryCollection = { id: "personal", title: "Personal", repo: "owner/wiki", writable: true, updatedAt: null };
  const read = (id: string, path: string, overrides: Partial<ChatTranscriptRow> = {}) => row({
    id, role: "toolResult", toolCallId: id, toolSyscall: "fs.read", toolTarget: "gsv",
    toolArgs: { path }, status: "done", toolOutcome: "completed", ...overrides,
  });
  const moment = (rows: ChatTranscriptRow[]): Moment => ({
    id: "reply", role: "ship", text: "See personal/pages/example.md", streaming: false, thinking: false,
    runId: "run", timestamp: 1, activities: activitiesForRows(rows, "run", false), narration: "",
  });

  it("resolves exact known pages after collection discovery and deduplicates repeated reads", () => {
    const longPath = `pages/deep/${"long-name-".repeat(12)}.md`;
    const value = moment([
      read("overview", "/src/repos/owner/wiki/index.md"),
      read("nested", `/src/repos/owner/wiki/${longPath}`),
      read("again", "/src/repos/owner/wiki/index.md"),
    ]);
    expect(memoryPagesForMoment(value, [])).toEqual([]);
    expect(memoryPagesForMoment(value, [personal])).toEqual([
      { db: "personal", path: "personal/index.md" },
      { db: "personal", path: `personal/${longPath}` },
    ]);
    expect(value.activities[0].calls[1].filePath).toBe(`/src/repos/owner/wiki/${longPath}`);
  });

  it("retains the exact Read path when its completion omits arguments", () => {
    const path = "/src/repos/owner/wiki/pages/example.md";
    const value = moment([
      read("same-call", path, { role: "tool", status: "running", toolOutcome: undefined }),
      read("same-call", path, { toolArgs: undefined }),
    ]);
    expect(value.activities[0].calls).toHaveLength(1);
    expect(memoryPagesForMoment(value, [personal])).toEqual([{ db: "personal", path: "personal/pages/example.md" }]);
  });

  const ineligibleCalls: Partial<ChatTranscriptRow>[] = [
    { role: "tool" as const, status: "running" as const, toolOutcome: undefined },
    { toolOutcome: "failed" as const },
    { toolOutcome: "denied" as const },
    { toolOutcome: "cancelled" as const },
    { isError: true },
    { status: "error" as const },
    { toolTarget: "laptop" },
    { toolTarget: null },
    { toolSyscall: "fs.write" },
    { toolSyscall: "shell.exec", toolArgs: { input: "wiki read personal/pages/example.md" } },
    { toolSyscall: "codemode.exec", toolArgs: { code: "read a wiki page" } },
    { toolArgs: undefined, text: '{"path":"/src/repos/owner/wiki/pages/example.md"}', toolOutput: { path: "/src/repos/owner/wiki/pages/example.md" } },
    { toolArgs: { path: 42 } },
  ];
  it.each(ineligibleCalls)("does not make a Memory link from an ineligible call: %j", (overrides) => {
    expect(memoryPagesForMoment(moment([read("read", "/src/repos/owner/wiki/pages/example.md", overrides)]), [personal])).toEqual([]);
  });

  it("excludes direct user commands and text-only references", () => {
    const value = moment([read("read", "/src/repos/owner/wiki/pages/example.md")]);
    value.activities[0].you = true;
    expect(memoryPagesForMoment(value, [personal])).toEqual([]);
    expect(memoryPagesForMoment(moment([]), [personal])).toEqual([]);
  });

  it.each([
    "personal/pages/example.md", "~/wiki/pages/example.md", "/src/repos/owner/unknown/pages/example.md",
    "/src/repos/owner/wiki-extra/pages/example.md", "/src/repos/owner/wiki/README.md",
    "/src/repos/owner/wiki/pages/example.txt", "/src/repos/owner/wiki/pages/folder",
    "/src/repos/owner/wiki/pages/../index.md", "/src/repos/owner/wiki/pages/./example.md",
    "/src/repos/owner/wiki/pages//example.md", "/src/repos/owner/wiki/pages/example.md/",
    "/src/repos/owner/wiki/pages/example.md ", " /src/repos/owner/wiki/pages/example.md",
    "/src/repos/owner/wiki/pages/\0example.md",
  ])("rejects unmatched, non-page, or ambiguous path %j", (path) => {
    const value = moment([read("read", path)]);
    expect(value.activities[0].calls[0].filePath).toBe(path);
    expect(memoryPagesForMoment(value, [personal])).toEqual([]);
  });

  it("does not choose between ambiguous repository or collection identities", () => {
    const value = moment([read("read", "/src/repos/owner/wiki/pages/example.md")]);
    expect(memoryPagesForMoment(value, [personal, { ...personal, id: "other" }])).toEqual([]);
    expect(memoryPagesForMoment(value, [personal, { ...personal, repo: "other/wiki" }])).toEqual([]);
  });
});

describe("isMessageSend", () => {
  it("recognizes the exact run-control tool without guessing from shell prose", () => {
    expect(isMessageSend(row({ id: "send", toolName: "Send", toolSyscall: null }))).toBe(true);
    expect(isMessageSend(row({ id: "shell", toolName: "Shell", toolSyscall: "shell.exec", toolArgs: { input: "message ana hi" } }))).toBe(false);
    expect(isMessageSend(row({ id: "classified-shell", toolName: "Shell", toolSyscall: null, toolRunControl: true }))).toBe(true);
    expect(isMessageSend(row({ id: "stream-shell", toolName: "Shell", toolSyscall: null }))).toBe(false);
    expect(isMessageSend(row({ id: "other", toolName: "Send", toolSyscall: "adapter.send" }))).toBe(false);
  });
});

describe("outputText", () => {
  it("reads a command's stdout and stderr instead of the transport json", () => {
    expect(outputText("shell.exec", { ok: true, stdout: "a\nb\n", stderr: "", exitCode: 0 }, "{json}")).toBe("a\nb\n");
    expect(outputText("shell.exec", { stdout: "", stderr: "no such file", exitCode: 1 }, "")).toBe("no such file");
    expect(outputText("shell.exec", { stdout: "", stderr: "", exitCode: 0 }, "")).toBe("");
    expect(outputText("shell.exec", { status: "completed", output: "total 21\ndrwxr-xr-x .gsv" }, "{json}")).toBe("total 21\ndrwxr-xr-x .gsv");
  });
  it("retains fallback for unknown or malformed shell results", () => {
    expect(outputText("shell.exec", { status: "failed", error: "unrecognized failure" }, "fallback")).toBe("fallback");
    expect(outputText("shell.exec", { stdout: 3 }, "fallback")).toBe("fallback");
    expect(outputText("shell.exec", {}, "fallback")).toBe("fallback");
  });
  it.each(["codemode.exec", "codemode.run"])("shows %s logs, return values, and failures without treating returned data as a shell envelope", (syscall) => {
    expect(outputText(syscall, { status: "completed", result: "hello", logs: ["first", "second"] }, "fallback")).toBe("first\nsecond\nhello");
    expect(outputText(syscall, { status: "completed", result: false }, "fallback")).toBe("false");
    expect(outputText(syscall, { status: "completed", result: 0 }, "fallback")).toBe("0");
    expect(outputText(syscall, { status: "completed", result: null }, "fallback")).toBe("completed");
    expect(outputText(syscall, { status: "completed", result: null, logs: ["logged"] }, "fallback")).toBe("logged");
    expect(outputText(syscall, { status: "completed", result: "" }, "fallback")).toBe('""');
    const returned = { stdout: "ordinary field", output: "also ordinary", exitCode: 0, values: [false, 0] };
    expect(outputText(syscall, { status: "completed", result: returned }, "fallback")).toBe(JSON.stringify(returned, null, 2));
    const literal = '{"stdout":"literal JSON-looking string"}';
    expect(outputText(syscall, { status: "completed", result: literal }, "fallback")).toBe(literal);
    expect(outputText(syscall, { status: "failed", error: "execution failed", logs: ["before failure"] }, "fallback")).toBe("before failure\nexecution failed");
    expect(outputText(syscall, { status: "failed", error: "execution failed" }, "fallback")).toBe("execution failed");
  });
  it.each(["codemode.exec", "codemode.run"])("retains fallback for unknown or malformed %s results", (syscall) => {
    const outputs: ChatTranscriptValue[] = [
      {}, { status: "completed" }, { status: "completed", output: "not a CodeMode result" },
      { status: "completed", result: 1, logs: [false] }, { status: "failed", error: false },
      { status: "running", result: 1 }, { stdout: "not a CodeMode result" },
    ];
    for (const output of outputs) {
      expect(outputText(syscall, output, "fallback")).toBe("fallback");
    }
    const literal = '{"status":"completed","result":1}';
    expect(outputText(syscall, literal, "fallback")).toBe(literal);
    expect(outputText("codemode.other", { status: "completed", result: 1 }, "fallback")).toBe("fallback");
  });
  it("describes successful filesystem mutations with correct counts", () => {
    expect(outputText("fs.write", { ok: true, path: "/note.md", size: 11 }, "fallback")).toBe("wrote 11 bytes");
    expect(outputText("fs.write", { ok: true, path: "/note.md", size: 1 }, "fallback")).toBe("wrote 1 byte");
    expect(outputText("fs.write", { ok: true, path: "/note.md", size: 0 }, "fallback")).toBe("wrote 0 bytes");
    expect(outputText("fs.edit", { ok: true, path: "/note.md", replacements: 1 }, "fallback")).toBe("replaced 1 occurrence");
    expect(outputText("fs.edit", { ok: true, path: "/note.md", replacements: 2 }, "fallback")).toBe("replaced 2 occurrences");
    expect(outputText("fs.edit", { ok: true, path: "/note.md", replacements: 0 }, "fallback")).toBe("replaced 0 occurrences");
    expect(outputText("fs.delete", { ok: true, path: "/note.md" }, "fallback")).toBe("deleted");
  });
  it("retains fallback for malformed filesystem mutation results", () => {
    expect(outputText("fs.write", { ok: true, path: "/note.md", size: "11" }, "fallback")).toBe("fallback");
    expect(outputText("fs.write", { ok: true, size: 11 }, "fallback")).toBe("fallback");
    expect(outputText("fs.write", { ok: true, path: "/note.md", size: -1 }, "fallback")).toBe("fallback");
    expect(outputText("fs.edit", { ok: true, path: "/note.md", replacements: 1.5 }, "fallback")).toBe("fallback");
    expect(outputText("fs.edit", { ok: false, path: "/note.md", replacements: 1, error: 1 }, "fallback")).toBe("fallback");
    expect(outputText("fs.delete", { ok: true }, "fallback")).toBe("fallback");
  });
  it("renders typed output independently of JSON-looking row text", () => {
    const row: ChatTranscriptRow = { id: "t", role: "toolResult", text: "{\"output\":\"misleading prose\"}", toolOutput: { status: "completed", output: "hello\nworld" }, time: "", timestamp: 1, toolSyscall: "shell.exec", toolArgs: { input: "echo" } };
    const activity = activitiesForRows([row], "r", false)[0];
    expect(activity.calls[0].output).toBe("hello\nworld");
  });
  it("lists a directory and shows a file", () => {
    expect(outputText("fs.read", { ok: true, entries: [{ name: "Downloads", kind: "directory" }, { name: "a.txt", kind: "file" }] }, "")).toBe("Downloads/\na.txt");
    expect(outputText("fs.read", { content: "hello" }, "")).toBe("hello");
  });
  it("displays structured filesystem errors without interpreting other result values", () => {
    const error = { ok: false, error: "ENOENT: no such file or directory" };
    for (const syscall of ["fs.read", "fs.write", "fs.edit", "fs.delete", "fs.search"]) {
      expect(outputText(syscall, error, "fallback")).toBe(error.error);
    }
    const literal = JSON.stringify(error);
    expect(outputText("fs.read", literal, "fallback")).toBe(literal);
    expect(outputText("fs.read", { ok: true, error: "ordinary data" }, "fallback")).toBe("fallback");
    expect(outputText("fs.read", { ok: false, error: 1 }, "fallback")).toBe("fallback");
    expect(outputText("net.fetch", error, "fallback")).toBe("fallback");
  });
});

describe("receipt", () => {
  const moment = (rows: ChatTranscriptRow[], active = false) => ({
    id: "m",
    role: "ship" as const,
    text: "",
    streaming: false,
    thinking: false,
    runId: "run",
    timestamp: null,
    activities: activitiesForRows(rows, "run", active),
    narration: "",
  });
  it("summarizes targets in first-touch order, retaining failure and expanded call details", () => {
    const rows = [
      row({ id: "t1", role: "toolResult", toolCallId: "1", toolSyscall: "fs.search", toolTarget: "gsv", toolArgs: { path: "~/mail", q: "statement" }, status: "done", timestamp: 100 }),
      row({ id: "t2", role: "toolResult", toolCallId: "2", toolSyscall: "fs.read", toolTarget: "laptop", toolArgs: { target: "laptop", path: "~/Downloads/Q2.pdf" }, status: "done", timestamp: 150 }),
      row({ id: "t3", role: "toolResult", toolCallId: "3", toolSyscall: "shell.exec", toolTarget: "laptop", toolArgs: { target: "laptop", input: "cp ~/Downloads/Q2.pdf ~/Documents/Taxes/" }, toolOutcome: "denied", status: "done", timestamp: 300 }),
    ];
    // places come in first-touch order, and each place's calls in theirs
    expect(receiptTargets(moment(rows))).toEqual([
      { target: "gsv", live: false, failed: false },
      { target: "laptop", live: false, failed: true },
    ]);
    expect(moment(rows).activities[1].calls.map((call) => call.syscall)).toEqual(["fs.read", "shell.exec"]);
    expect(receiptSteps(moment(rows))).toBe(3);
    expect(receiptDuration(moment(rows))).toBe(formatSeconds(200));
  });
  it("keeps one target summary for mixed work without discarding any calls", () => {
    const read = (id: string, path: string) => row({ id, role: "toolResult", toolCallId: id, toolSyscall: "fs.read", toolTarget: "gsv", toolArgs: { path }, status: "done", timestamp: 1 });
    const value = moment([read("1", "a"), read("2", "b"), read("3", "c")]);
    expect(receiptTargets(value)).toEqual([{ target: "gsv", live: false, failed: false }]);
    expect(value.activities[0].calls.map((call) => call.summary)).toEqual(["a", "b", "c"]);
  });
  it("identifies the target still in use and omits empty work", () => {
    const rows = [row({ id: "t1", role: "tool", toolCallId: "1", toolSyscall: "fs.read", toolTarget: "laptop", toolArgs: { target: "laptop", path: "~/x" }, status: "running" })];
    expect(receiptTargets(moment(rows, true))).toEqual([{ target: "laptop", live: true, failed: false }]);
    expect(receiptTargets(moment([]))).toEqual([]);
  });
  it("keeps every unfinished parallel target live when a later target has already finished", () => {
    const value = moment([
      row({ id: "a", role: "tool", toolCallId: "a", toolSyscall: "fs.read", toolTarget: "laptop", status: "running" }),
      row({ id: "b", role: "tool", toolCallId: "b", toolSyscall: "fs.read", toolTarget: "office", status: "running" }),
      row({ id: "c", role: "toolResult", toolCallId: "c", toolSyscall: "fs.read", toolTarget: "gsv", status: "done" }),
    ], true);
    expect(receiptTargets(value)).toEqual([
      { target: "laptop", live: true, failed: false }, { target: "office", live: true, failed: false }, { target: "gsv", live: false, failed: false },
    ]);
  });
});
