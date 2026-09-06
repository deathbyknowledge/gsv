import { describe, expect, it } from "vitest";
import type { ChatTranscriptRow } from "../../chat/domain/transcript";
import {
  activitiesForRows,
  argumentThatMatters,
  defaultPlace,
  formatSeconds,
  linkPlaceReferences,
  momentsFromRows,
  momentsFromConversation,
  parsePromptInput,
  placeLabel,
  resolvePlace,
  resolveTail,
  trimOutput,
  noteSummary,
} from "./zenModel";

const places = [
  { id: "laptop", label: "MacBook 16", online: true },
  { id: "office", label: "Office box", online: false },
];

function row(partial: Partial<ChatTranscriptRow> & { id: string }): ChatTranscriptRow {
  return { text: "", time: "", timestamp: null, ...partial };
}

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
      row({ id: "tool:1", role: "tool", toolCallId: "1", toolSyscall: "shell.exec", toolArgs: { target: "laptop", input: "ls" }, status: "planning", timestamp: 100 }),
      row({ id: "tool:2", role: "toolResult", toolCallId: "2", toolSyscall: "fs.read", toolArgs: { path: "~/a" }, text: "hello", status: "done", timestamp: 150 }),
      row({ id: "tool:1", role: "toolResult", toolCallId: "1", toolSyscall: "shell.exec", toolArgs: { target: "laptop", input: "ls" }, text: "a b c", status: "done", timestamp: 200 }),
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
      row({ id: "tool:1", role: "tool", toolCallId: "1", toolSyscall: "shell.exec", toolArgs: { target: "laptop", input: "sleep 5" }, status: "running" }),
    ];
    expect(activitiesForRows(rows, "run", true)[0].live).toBe(true);
    expect(activitiesForRows(rows, "run", false)[0].live).toBe(false);
  });
  it("flags failed and denied calls", () => {
    const rows = [
      row({ id: "tool:1", role: "toolResult", toolCallId: "1", toolSyscall: "shell.exec", toolArgs: { target: "laptop", input: "rm x" }, toolOutcome: "denied", status: "done" }),
    ];
    expect(activitiesForRows(rows, "run", false)[0].calls[0].failed).toBe(true);
  });
});

describe("momentsFromRows", () => {
  it("folds a run into a human moment and one ship moment carrying its activities", () => {
    const rows = [
      row({ id: "u1", role: "user", text: "look around", runId: "r1", timestamp: 1 }),
      row({ id: "tool:1", role: "toolResult", toolCallId: "1", toolSyscall: "shell.exec", toolArgs: { target: "laptop", input: "ls" }, text: "x", runId: "r1", status: "done", timestamp: 2 }),
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
      row({ id: "tool:9", role: "tool", toolCallId: "9", toolSyscall: "fs.read", toolArgs: { path: "~/x" }, runId: "r2", status: "running" }),
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
    const transcript = [message({ id: "t1", role: "tool", toolSyscall: "fs.read", toolArgs: { path: "~/a" }, timestamp: 2_000, runId: "r2", status: "running" })];
    const moments = momentsFromConversation([], transcript, "r2");
    expect(moments).toHaveLength(1);
    expect(moments[0]).toMatchObject({ role: "ship", text: "", thinking: true, runId: "r2" });
  });
});
