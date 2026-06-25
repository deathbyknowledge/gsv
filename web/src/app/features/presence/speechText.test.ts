import { describe, expect, it } from "vitest";
import { chunkSpeechText, normalizeInterimSpeechText, selectSpeechPrefix } from "./speechText";

describe("presence speech text helpers", () => {
  it("normalizes short interim status text", () => {
    expect(normalizeInterimSpeechText("  Using fs.read  ")).toBe("Using fs.read.");
    expect(normalizeInterimSpeechText("Already done.")).toBe("Already done.");
    expect(normalizeInterimSpeechText("```ts\ncode\n```")).toBe("");
  });

  it("waits for enough text before selecting a non-final prefix", () => {
    expect(selectSpeechPrefix("short unfinished thought", false, true)).toBeNull();

    const prefix = selectSpeechPrefix(
      "This is long enough to speak now. This part can wait.",
      false,
      true,
    );
    expect(prefix?.text).toBe("This is long enough to speak now. This part can wait.");
  });

  it("chunks long responses and balances a short first chunk", () => {
    const chunks = chunkSpeechText("Ok. This is the longer follow up sentence that should be merged into the first speech chunk.");

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].text.length).toBeGreaterThanOrEqual(48);
    expect(chunks.every((chunk) => chunk.total === chunks.length)).toBe(true);
  });

  it("keeps structural markdown blocks as speakable chunks", () => {
    const chunks = chunkSpeechText("| A | B |\n| - | - |\n| 1 | 2 |");

    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toContain("| A | B |");
  });
});
