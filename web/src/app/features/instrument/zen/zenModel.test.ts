import { describe, expect, it } from "vitest";
import type { ProcHistoryRecord } from "@humansandmachines/gsv/protocol";
import type { ChatTranscriptRow } from "../../chat/domain/transcript";
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
  isMessageSend,
  outputText,
  parsePromptInput,
  placeLabel,
  receiptDuration,
  receiptPhrases,
  receiptRunning,
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

describe("momentsFromRows", () => {
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
  it("names each finished call by verb and place-qualified argument, in order", () => {
    const rows = [
      row({ id: "t1", role: "toolResult", toolCallId: "1", toolSyscall: "fs.search", toolTarget: "gsv", toolArgs: { path: "~/mail", q: "statement" }, status: "done", timestamp: 100 }),
      row({ id: "t2", role: "toolResult", toolCallId: "2", toolSyscall: "fs.read", toolTarget: "laptop", toolArgs: { target: "laptop", path: "~/Downloads/Q2.pdf" }, status: "done", timestamp: 150 }),
      row({ id: "t3", role: "toolResult", toolCallId: "3", toolSyscall: "shell.exec", toolTarget: "laptop", toolArgs: { target: "laptop", input: "cp ~/Downloads/Q2.pdf ~/Documents/Taxes/" }, toolOutcome: "denied", status: "done", timestamp: 300 }),
    ];
    // places come in first-touch order, and each place's calls in theirs
    expect(receiptPhrases(moment(rows)).map((phrase) => [phrase.verb, phrase.what, phrase.failed])).toEqual([
      ["searched", "~/mail", false],
      ["read", "laptop:~/Downloads/Q2.pdf", false],
      ["ran", "cp ~/Downloads/Q2.pdf ~/Documents/Taxes/", true],
    ]);
    expect(receiptSteps(moment(rows))).toBe(3);
    expect(receiptDuration(moment(rows))).toBe(formatSeconds(200));
  });
  it("folds three or more alike calls into a count and keeps two apart", () => {
    const read = (id: string, path: string) => row({ id, role: "toolResult", toolCallId: id, toolSyscall: "fs.read", toolTarget: "gsv", toolArgs: { path }, status: "done", timestamp: 1 });
    expect(receiptPhrases(moment([read("1", "a"), read("2", "b"), read("3", "c")]))).toEqual([{ verb: "read", what: null, count: 3, noun: "files", failed: false }]);
    expect(receiptPhrases(moment([read("1", "a"), read("2", "b")])).map((phrase) => phrase.what)).toEqual(["a", "b"]);
  });
  it("says what is still running in the present tense", () => {
    const rows = [row({ id: "t1", role: "tool", toolCallId: "1", toolSyscall: "fs.read", toolTarget: "laptop", toolArgs: { target: "laptop", path: "~/x" }, status: "running" })];
    expect(receiptRunning(moment(rows, true))).toMatchObject({ verb: "reading", what: "laptop:~/x" });
    expect(receiptRunning(moment([]))).toBeNull();
  });
});
