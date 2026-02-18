import { describe, expect, it } from "vitest";
import type { Message, UserMessage, AssistantMessage, ToolResultMessage } from "@mariozechner/pi-ai";
import {
  estimateMessageTokens,
  estimateContextTokens,
  countImageBlocks,
  serializeMessagesForSummary,
  shouldCompact,
  splitOldAndRecent,
  chunkMessages,
} from "./tokens";
import type { CompactionConfig } from "../config";

// ── Helpers ──────────────────────────────────────────────────────────────

function makeUserMsg(text: string): UserMessage {
  return { role: "user", content: text, timestamp: Date.now() };
}

function makeAssistantMsg(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "messages",
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {} },
    stopReason: "stop",
    timestamp: Date.now(),
  } as AssistantMessage;
}

function makeToolResultMsg(toolName: string, text: string): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: "call-123",
    toolName,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: Date.now(),
  };
}

function makeImageUserMsg(text: string): UserMessage {
  return {
    role: "user",
    content: [
      { type: "text", text },
      { type: "image", data: "base64data", mimeType: "image/png" },
    ],
    timestamp: Date.now(),
  } as UserMessage;
}

const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  enabled: true,
  reserveTokens: 20_000,
  keepRecentTokens: 20_000,
  extractMemories: true,
};

// ── Token Estimation Tests ───────────────────────────────────────────────

describe("token estimation", () => {
  it("estimates tokens for a simple text message", () => {
    const msg = makeUserMsg("Hello, world!");
    const tokens = estimateMessageTokens(msg);
    // Should be a reasonable positive number
    expect(tokens).toBeGreaterThan(0);
    // JSON.stringify(msg) length / 4 * 1.2 rounded up
    const json = JSON.stringify(msg);
    const expected = Math.ceil((json.length / 4) * 1.2);
    expect(tokens).toBe(expected);
  });

  it("estimates more tokens for longer messages", () => {
    const short = makeUserMsg("Hi");
    const long = makeUserMsg("A".repeat(10000));
    expect(estimateMessageTokens(long)).toBeGreaterThan(
      estimateMessageTokens(short),
    );
  });

  it("estimates context tokens as sum of individual messages", () => {
    const messages = [
      makeUserMsg("Hello"),
      makeAssistantMsg("Hi there"),
      makeUserMsg("How are you?"),
    ];
    const total = estimateContextTokens(messages);
    const sum = messages.reduce(
      (acc, m) => acc + estimateMessageTokens(m),
      0,
    );
    expect(total).toBe(sum);
  });

  it("returns 0 for empty message list", () => {
    expect(estimateContextTokens([])).toBe(0);
  });
});

// ── Image Block Counting Tests ───────────────────────────────────────────

describe("countImageBlocks", () => {
  it("returns 0 when no images present", () => {
    const messages: Message[] = [
      makeUserMsg("Hello"),
      makeAssistantMsg("Hi"),
    ];
    expect(countImageBlocks(messages)).toBe(0);
  });

  it("counts image blocks in user messages", () => {
    const messages: Message[] = [
      makeImageUserMsg("Check this"),
      makeImageUserMsg("And this"),
      makeAssistantMsg("I see both images"),
    ];
    expect(countImageBlocks(messages)).toBe(2);
  });

  it("ignores string-content user messages", () => {
    const messages: Message[] = [makeUserMsg("Just text")];
    expect(countImageBlocks(messages)).toBe(0);
  });
});

// ── Serialization Tests ──────────────────────────────────────────────────

describe("serializeMessagesForSummary", () => {
  it("serializes user and assistant messages", () => {
    const messages: Message[] = [
      makeUserMsg("What is 2+2?"),
      makeAssistantMsg("The answer is 4."),
    ];
    const result = serializeMessagesForSummary(messages);
    expect(result).toContain("[user]: What is 2+2?");
    expect(result).toContain("[assistant]: The answer is 4.");
  });

  it("serializes tool results with tool name", () => {
    const messages: Message[] = [
      makeToolResultMsg("gsv__ReadFile", "file contents here"),
    ];
    const result = serializeMessagesForSummary(messages);
    expect(result).toContain("[tool result: gsv__ReadFile]:");
    expect(result).toContain("file contents here");
  });

  it("truncates very long tool results", () => {
    const longContent = "X".repeat(5000);
    const messages: Message[] = [
      makeToolResultMsg("gsv__ReadFile", longContent),
    ];
    const result = serializeMessagesForSummary(messages);
    expect(result).toContain("[...truncated]");
    expect(result.length).toBeLessThan(longContent.length);
  });
});

// ── shouldCompact Tests ──────────────────────────────────────────────────

describe("shouldCompact", () => {
  it("returns false when compaction is disabled", () => {
    const config: CompactionConfig = {
      ...DEFAULT_COMPACTION_CONFIG,
      enabled: false,
    };
    const messages = Array.from({ length: 100 }, (_, i) =>
      makeUserMsg("A".repeat(5000)),
    );
    expect(shouldCompact(messages, 100_000, config)).toBe(false);
  });

  it("returns false when messages are very short", () => {
    const messages = [makeUserMsg("Hi"), makeAssistantMsg("Hello")];
    expect(
      shouldCompact(messages, 200_000, DEFAULT_COMPACTION_CONFIG),
    ).toBe(false);
  });

  it("returns false with only 2 or fewer messages", () => {
    const messages = [makeUserMsg("Hi"), makeAssistantMsg("Hello")];
    expect(shouldCompact(messages, 100, DEFAULT_COMPACTION_CONFIG)).toBe(
      false,
    );
  });

  it("returns true when estimated tokens exceed threshold", () => {
    // Create messages that are large enough to exceed a small window
    const messages = Array.from({ length: 20 }, (_, i) =>
      makeUserMsg("A".repeat(2000)),
    );
    // Small window so tokens will exceed it
    expect(
      shouldCompact(messages, 5_000, DEFAULT_COMPACTION_CONFIG),
    ).toBe(true);
  });

  it("returns false when estimated tokens are below threshold", () => {
    const messages = [
      makeUserMsg("Hi"),
      makeAssistantMsg("Hello"),
      makeUserMsg("How are you?"),
    ];
    // Very large window
    expect(
      shouldCompact(messages, 1_000_000, DEFAULT_COMPACTION_CONFIG),
    ).toBe(false);
  });

  it("uses lastKnownInputTokens when provided (over threshold)", () => {
    // Messages are tiny, but real usage says we're over the limit
    const messages = [
      makeUserMsg("Hi"),
      makeAssistantMsg("Hello"),
      makeUserMsg("How are you?"),
    ];
    // contextWindow 100K, reserve 20K → threshold 80K
    // lastKnownInputTokens 90K → over threshold
    expect(
      shouldCompact(messages, 100_000, DEFAULT_COMPACTION_CONFIG, 90_000),
    ).toBe(true);
  });

  it("uses lastKnownInputTokens when provided (under threshold)", () => {
    // Messages look large via estimation, but real usage says we're fine
    const messages = Array.from({ length: 20 }, (_, i) =>
      makeUserMsg("A".repeat(2000)),
    );
    // contextWindow 200K, reserve 20K → threshold 180K
    // lastKnownInputTokens 50K → under threshold, should NOT compact
    expect(
      shouldCompact(messages, 200_000, DEFAULT_COMPACTION_CONFIG, 50_000),
    ).toBe(false);
  });

  it("falls back to estimation when lastKnownInputTokens is 0", () => {
    const messages = Array.from({ length: 20 }, (_, i) =>
      makeUserMsg("A".repeat(2000)),
    );
    // 0 is treated as unavailable → falls through to estimation
    const withZero = shouldCompact(messages, 5_000, DEFAULT_COMPACTION_CONFIG, 0);
    const withoutArg = shouldCompact(messages, 5_000, DEFAULT_COMPACTION_CONFIG);
    expect(withZero).toBe(withoutArg);
  });

  it("falls back to estimation when lastKnownInputTokens is undefined", () => {
    const messages = Array.from({ length: 20 }, (_, i) =>
      makeUserMsg("A".repeat(2000)),
    );
    const withUndefined = shouldCompact(messages, 5_000, DEFAULT_COMPACTION_CONFIG, undefined);
    const withoutArg = shouldCompact(messages, 5_000, DEFAULT_COMPACTION_CONFIG);
    expect(withUndefined).toBe(withoutArg);
  });

  it("includes systemPromptTokenEstimate in estimation fallback", () => {
    // Messages alone are under the threshold, but system prompt pushes over.
    // Use a config with small reserveTokens so the threshold is meaningful.
    const smallReserveConfig: CompactionConfig = {
      ...DEFAULT_COMPACTION_CONFIG,
      reserveTokens: 100,
    };
    const messages = [
      makeUserMsg("Hi"),
      makeAssistantMsg("Hello"),
      makeUserMsg("How are you?"),
    ];
    const msgTokens = estimateContextTokens(messages);
    // contextWindow set so messages alone fit, but messages + system prompt don't.
    // threshold = contextWindow - 100
    const contextWindow = msgTokens + 500;
    // Without system prompt estimate → messages fit under threshold → no compact.
    expect(
      shouldCompact(messages, contextWindow, smallReserveConfig),
    ).toBe(false);
    // With a system prompt estimate that pushes total over threshold → compact.
    expect(
      shouldCompact(messages, contextWindow, smallReserveConfig, undefined, 600),
    ).toBe(true);
  });

  it("ignores systemPromptTokenEstimate when lastKnownInputTokens is available", () => {
    // lastKnownInputTokens takes priority — system prompt estimate is irrelevant
    const messages = [
      makeUserMsg("Hi"),
      makeAssistantMsg("Hello"),
      makeUserMsg("How are you?"),
    ];
    // contextWindow 100K, reserve 20K → threshold 80K
    // lastKnownInputTokens 50K → under threshold, regardless of system prompt
    expect(
      shouldCompact(messages, 100_000, DEFAULT_COMPACTION_CONFIG, 50_000, 999_999),
    ).toBe(false);
  });
});

// ── splitOldAndRecent Tests ──────────────────────────────────────────────

describe("splitOldAndRecent", () => {
  it("keeps all messages when they fit in the recent budget", () => {
    const messages = [
      makeUserMsg("Hi"),
      makeAssistantMsg("Hello"),
      makeUserMsg("How are you?"),
    ];
    const totalTokens = estimateContextTokens(messages);
    const { old, recent } = splitOldAndRecent(messages, totalTokens + 1000);
    // With large budget, should keep most messages recent
    // But splitOldAndRecent always keeps at least 1 old when splitIdx would be 0
    expect(old.length + recent.length).toBe(messages.length);
  });

  it("always leaves at least one message in old", () => {
    const messages = [
      makeUserMsg("Hi"),
      makeAssistantMsg("Hello"),
    ];
    // Very large budget — should still not make old empty
    const { old, recent } = splitOldAndRecent(messages, 1_000_000);
    expect(old.length).toBeGreaterThanOrEqual(1);
    expect(recent.length).toBeGreaterThanOrEqual(1);
  });

  it("splits correctly with a small recent budget", () => {
    const messages = Array.from({ length: 10 }, (_, i) =>
      makeUserMsg(`Message ${i}: ${"X".repeat(500)}`),
    );
    // Very small budget — only last message or two should be recent
    const singleMsgTokens = estimateMessageTokens(messages[0]);
    const { old, recent } = splitOldAndRecent(
      messages,
      singleMsgTokens + 1,
    );
    expect(recent.length).toBeLessThanOrEqual(2);
    expect(old.length).toBeGreaterThanOrEqual(8);
  });

  it("preserves message order", () => {
    const messages = Array.from({ length: 5 }, (_, i) =>
      makeUserMsg(`Message ${i}`),
    );
    const singleTokens = estimateMessageTokens(messages[0]);
    const { old, recent } = splitOldAndRecent(
      messages,
      singleTokens * 2 + 1,
    );
    const recombined = [...old, ...recent];
    for (let i = 0; i < messages.length; i++) {
      expect((recombined[i] as UserMessage).content).toBe(
        (messages[i] as UserMessage).content,
      );
    }
  });
});

// ── chunkMessages Tests ──────────────────────────────────────────────────

describe("chunkMessages", () => {
  it("puts all messages in one chunk when under budget", () => {
    const messages = [
      makeUserMsg("Hi"),
      makeAssistantMsg("Hello"),
    ];
    const totalTokens = estimateContextTokens(messages);
    const chunks = chunkMessages(messages, totalTokens + 1000);
    expect(chunks.length).toBe(1);
    expect(chunks[0].length).toBe(2);
  });

  it("splits messages across chunks when they exceed budget", () => {
    const messages = Array.from({ length: 10 }, (_, i) =>
      makeUserMsg(`Message ${i}: ${"X".repeat(500)}`),
    );
    const singleMsgTokens = estimateMessageTokens(messages[0]);
    // Budget for ~2 messages per chunk
    const chunks = chunkMessages(messages, singleMsgTokens * 2 + 1);
    expect(chunks.length).toBeGreaterThan(1);
    // Verify all messages are accounted for
    const total = chunks.reduce((sum, c) => sum + c.length, 0);
    expect(total).toBe(10);
  });

  it("puts a single oversized message in its own chunk", () => {
    const messages = [
      makeUserMsg("Short"),
      makeUserMsg("X".repeat(100000)), // very large
      makeUserMsg("Short too"),
    ];
    const budget = estimateMessageTokens(makeUserMsg("Short")) * 2;
    const chunks = chunkMessages(messages, budget);
    // The oversized message should be alone in its chunk
    const oversizedChunk = chunks.find((c) =>
      c.some(
        (m) =>
          m.role === "user" &&
          typeof m.content === "string" &&
          m.content.length > 1000,
      ),
    );
    expect(oversizedChunk).toBeDefined();
    expect(oversizedChunk!.length).toBe(1);
  });

  it("returns empty array for empty input", () => {
    expect(chunkMessages([], 1000)).toEqual([]);
  });
});
