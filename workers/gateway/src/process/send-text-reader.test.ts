import { describe, expect, it } from "vitest";
import { SendTextReader } from "./send-text-reader";

/** Every way to cut `input` into chunks at one point, plus whole and one unit at a time. */
function chunkings(input: string): string[][] {
  const cuts: string[][] = [[input], Array.from({ length: input.length }, (_, index) => input[index])];
  for (let at = 1; at < input.length; at += 1) cuts.push([input.slice(0, at), input.slice(at)]);
  return cuts;
}

type ReadResult = { emitted: string; reader: SendTextReader };

function readAll(chunks: readonly string[]): ReadResult {
  const reader = new SendTextReader();
  let emitted = "";
  for (const chunk of chunks) emitted += reader.push(chunk);
  return { emitted, reader };
}

function expectText(json: string, expected: string, done = true): void {
  for (const chunks of chunkings(json)) {
    const { emitted, reader } = readAll(chunks);
    expect(emitted, JSON.stringify(chunks)).toBe(expected);
    expect(reader.text, JSON.stringify(chunks)).toBe(expected);
    expect(reader.done, JSON.stringify(chunks)).toBe(done);
  }
}

describe("SendTextReader", () => {
  it("reads plain text however the chunks fall", () => {
    expectText('{"text":"hello there"}', "hello there");
    expectText('{ "text" : "spaced" , "yield" : true }', "spaced");
  });

  it("decodes escapes that straddle chunk boundaries", () => {
    expectText('{"text":"line\\nbreak \\"quoted\\" back\\\\slash \\t tab \\/ slash \\r\\b\\f"}', 'line\nbreak "quoted" back\\slash \t tab / slash \r\b\f');
  });

  it("decodes unicode escapes split anywhere inside the hex digits", () => {
    expectText('{"text":"caf\\u00e9 \\u4e2d\\u6587"}', "café 中文");
  });

  it("joins escaped surrogate pairs split between their halves", () => {
    expectText('{"text":"smile \\ud83d\\ude00 done"}', "smile 😀 done");
  });

  it("joins raw surrogate pairs split between chunks", () => {
    const json = '{"text":"raw 😀 pair"}';
    expectText(json, "raw 😀 pair");
    const cut = json.indexOf("😀") + 1;
    const { emitted } = readAll([json.slice(0, cut), json.slice(cut)]);
    expect(emitted).toBe("raw 😀 pair");
    const { emitted: beforeLow } = readAll([json.slice(0, cut)]);
    expect(beforeLow).toBe("raw ");
  });

  it("releases a lone high surrogate once the next character shows it has no partner", () => {
    expectText('{"text":"\\ud83dA"}', "\ud83dA");
    expectText('{"text":"end\\ud83d"}', "end\ud83d");
  });

  it("emits only complete characters while an escape is pending", () => {
    const reader = new SendTextReader();
    expect(reader.push('{"text":"a\\')).toBe("a");
    expect(reader.push("u00")).toBe("");
    expect(reader.push("e9")).toBe("é");
    expect(reader.push("\\")).toBe("");
    expect(reader.push("n")).toBe("\n");
    expect(reader.done).toBe(false);
    expect(reader.push('"}')).toBe("");
    expect(reader.done).toBe(true);
    expect(reader.text).toBe("aé\n");
  });

  it("skips the members before text, whatever their shape", () => {
    expectText(
      '{"purpose":"a \\"reply\\" with } and ]","yield":false,"attach":["a:b","text",{"text":"nested"}],"count":12.5e3,"none":null,"deep":{"text":{"text":"[{"}},"text":"yes"}',
      "yes",
    );
  });

  it("stops at the closing quote and ignores what follows", () => {
    expectText('{"text":"first","yield":true,"attach":["x"]}', "first");
    const reader = new SendTextReader();
    reader.push('{"text":"first"');
    expect(reader.done).toBe(true);
    expect(reader.push(',"text":"second"}')).toBe("");
    expect(reader.text).toBe("first");
  });

  it("yields nothing when text is absent, empty or not a string", () => {
    expectText('{"yield":true}', "");
    expectText('{"text":""}', "");
    expectText('{"text":null,"yield":true}', "");
    expectText("{}", "");
  });

  it("stays open with the text so far until the closing quote arrives", () => {
    const reader = new SendTextReader();
    expect(reader.push('{"purpose":"reply","text":"partial wor')).toBe("partial wor");
    expect(reader.done).toBe(false);
    expect(reader.push('ds"')).toBe("ds");
    expect(reader.done).toBe(true);
  });

  it("stops reading, keeping what it has, when the JSON stops making sense", () => {
    const reader = new SendTextReader();
    expect(reader.push('{"text":"ok\\x')).toBe("ok");
    expect(reader.done).toBe(true);
    expect(reader.push('more"}')).toBe("");
    expect(reader.text).toBe("ok");
    const notAnObject = new SendTextReader();
    expect(notAnObject.push('["text","x"]')).toBe("");
    expect(notAnObject.done).toBe(true);
  });
});
