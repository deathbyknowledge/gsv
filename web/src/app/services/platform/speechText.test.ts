import { describe, expect, it } from "vitest";
import { speechChunks } from "./speechText";

describe("spoken Markdown", () => {
  it("keeps prose and link labels without reading code, tables, markup or URLs", () => {
    const input = "# Ready\n\nYour **reminder** is set. Read the [route](https://example.com/private).\n\n- Bring water.\n- Bring `ID`.\n\n```sh\nrm -rf /example\n```\n\n| Name | Value |\n| --- | --- |\n| A | B |";
    const result = speechChunks(input).join(" ");
    expect(result).toContain("Your reminder is set. Read the route.");
    expect(result).toContain("Bring ID.");
    expect(result).toContain("There is a code example in the chat.");
    expect(result).toContain("There is a table in the chat.");
    expect(result).not.toMatch(/https|private|rm -rf|\*\*|\|/);
  });

  it("starts at sentence boundaries and bounds unusually long text", () => {
    const chunks = speechChunks("Dr. Smith arrives at 8.30. Then we leave.\n\n" + "A long sentence ".repeat(200));
    expect(chunks[0]).toBe("Dr. Smith arrives at 8.30.");
    expect(chunks).toContain("Then we leave.");
    expect(chunks.every((chunk) => chunk.length <= 600)).toBe(true);
    expect(speechChunks("Dr. ".repeat(200)).every((chunk) => chunk.length <= 600)).toBe(true);
    expect(speechChunks("![image](https://example.com/image.png)\n---")).toEqual([]);
  });

  it("uses Spanish presentation cues with the Spanish voice", () => {
    const text = speechChunks("Mira [https://example.com](https://example.com).\n\n```sh\nprivate-command\n```\n\n| A | B |\n| --- | --- |\n| 1 | 2 |", "es").join(" ");
    expect(text).toContain("la página enlazada");
    expect(text).toContain("Hay un ejemplo de código en el chat.");
    expect(text).toContain("Hay una tabla en el chat.");
    expect(text).not.toMatch(/https|private-command|There is/);
  });

  it("reads the start of a reply with too many sentences and points to the rest in Chat", () => {
    expect(speechChunks("Ready. ".repeat(256))).toHaveLength(256);
    const chunks = speechChunks("Ready. ".repeat(300));
    expect(chunks).toHaveLength(256);
    expect(chunks[0]).toBe("Ready.");
    expect(chunks.at(-1)).toBe("You can read the rest in the chat.");
  });

  it("bounds UTF-8 bytes without splitting Unicode characters", () => {
    const chunks = speechChunks(("á".repeat(599) + "🚀 ").repeat(150), "es");
    expect(chunks.at(-1)).toBe("Puedes leer el resto en el chat.");
    expect(chunks.length).toBeLessThanOrEqual(256);
    const encoder = new TextEncoder(), decoder = new TextDecoder();
    expect(chunks.every((chunk) => [...chunk].length <= 600 && decoder.decode(encoder.encode(chunk)) === chunk)).toBe(true);
    expect(chunks.reduce((total, chunk) => total + encoder.encode(chunk).length, 0)).toBeLessThanOrEqual(128 * 1024);
  });
});
