import { bodyToText } from "@humansandmachines/gsv/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  decodeMoondreamStream,
  MOONDREAM_IMAGE_READING_MODEL,
  normalizeImageReadingText,
  readImage,
} from "./image-reading";

describe("readImage", () => {
  it("uses caption mode by default and preserves internal whitespace", async () => {
    const run = vi.fn(async () => ({
      caption: "  first line\n  second line  ",
      finish_reason: "stop",
      metrics: {
        input_tokens: 10,
        output_tokens: 5,
        prefill_time_ms: 1,
        decode_time_ms: 2,
        ttft_ms: 3,
      },
    }));

    const response = await readImage({ run }, {
      data: "AQID",
      mimeType: "image/png",
    });

    expect(run).toHaveBeenCalledWith(MOONDREAM_IMAGE_READING_MODEL, {
      task: "caption",
      image: "data:image/png;base64,AQID",
      stream: false,
      max_tokens: 8192,
      caption_length: "normal",
    });
    expect(response?.result).toEqual({
      mode: "caption",
      text: "first line\n  second line",
      caption: "first line\n  second line",
      captionLength: "normal",
      finishReason: "stop",
      metrics: {
        inputTokens: 10,
        outputTokens: 5,
        prefillTimeMs: 1,
        decodeTimeMs: 2,
        timeToFirstTokenMs: 3,
      },
      provider: "workers-ai",
      model: MOONDREAM_IMAGE_READING_MODEL,
    });
  });

  it("requires an agent-supplied query prompt and exposes reasoning grounding", async () => {
    const run = vi.fn(async () => ({
      answer: "Four horses.",
      reasoning: {
        text: "I see four horses.",
        grounding: [{
          start_idx: 6,
          end_idx: 17,
          points: [[0.25, 0.5], [0.75, 0.5]],
        }],
      },
    }));

    await expect(readImage({ run }, {
      data: "AQID",
      mode: "query",
    })).rejects.toThrow("prompt is required for query mode");

    const response = await readImage({ run }, {
      data: "AQID",
      mode: "query",
      prompt: "How many horses are visible?",
      reasoning: true,
    });

    expect(run).toHaveBeenLastCalledWith(MOONDREAM_IMAGE_READING_MODEL, expect.objectContaining({
      task: "query",
      question: "How many horses are visible?",
      reasoning: true,
    }));
    expect(response?.result).toEqual(expect.objectContaining({
      mode: "query",
      answer: "Four horses.",
      reasoning: {
        text: "I see four horses.",
        grounding: [{
          startIndex: 6,
          endIndex: 17,
          points: [{ x: 0.25, y: 0.5 }, { x: 0.75, y: 0.5 }],
        }],
      },
    }));
  });

  it("maps OCR to query without imposing a general query prompt", async () => {
    const run = vi.fn(async () => ({ answer: "Invoice\nTotal: $20" }));

    const response = await readImage({ run }, {
      data: "AQID",
      mode: "ocr",
    });

    expect(run).toHaveBeenCalledWith(MOONDREAM_IMAGE_READING_MODEL, expect.objectContaining({
      task: "query",
      question: expect.stringContaining("Transcribe all visible text exactly"),
      reasoning: false,
    }));
    expect(response?.result).toEqual(expect.objectContaining({
      mode: "ocr",
      text: "Invoice\nTotal: $20",
    }));
  });

  it("returns normalized point and detect coordinates", async () => {
    const pointRun = vi.fn(async () => ({ points: [{ x: 0.2, y: 0.3 }] }));
    const detectRun = vi.fn(async () => ({
      objects: [{ x_min: 0.1, y_min: 0.2, x_max: 0.4, y_max: 0.6 }],
    }));

    const point = await readImage({ run: pointRun }, {
      data: "AQID",
      mode: "point",
      target: "the submit button",
      maxObjects: 12,
    });
    const detect = await readImage({ run: detectRun }, {
      data: "AQID",
      mode: "detect",
      target: "horse",
    });

    expect(pointRun).toHaveBeenCalledWith(MOONDREAM_IMAGE_READING_MODEL, expect.objectContaining({
      task: "point",
      target: "the submit button",
      max_objects: 12,
    }));
    expect(point?.result).toEqual(expect.objectContaining({
      mode: "point",
      points: [{ x: 0.2, y: 0.3 }],
    }));
    expect(detect?.result).toEqual(expect.objectContaining({
      mode: "detect",
      objects: [{ xMin: 0.1, yMin: 0.2, xMax: 0.4, yMax: 0.6 }],
    }));
  });

  it("prompts for JSON and validates the structured result", async () => {
    const run = vi.fn(async () => ({ answer: "{\"total\":20}" }));
    const schema = {
      type: "object",
      properties: { total: { type: "number" } },
      required: ["total"],
      additionalProperties: false,
    };

    const response = await readImage({ run }, {
      data: "AQID",
      mode: "query",
      prompt: "Extract the invoice total.",
      responseFormat: "json",
      schema,
    });

    expect(run).toHaveBeenCalledWith(MOONDREAM_IMAGE_READING_MODEL, expect.objectContaining({
      question: expect.stringContaining(JSON.stringify(schema)),
    }));
    expect(response?.result).toEqual(expect.objectContaining({
      responseFormat: "json",
      structured: { total: 20 },
    }));

    run.mockResolvedValueOnce({ answer: "{\"wrong\":20}" });
    await expect(readImage({ run }, {
      data: "AQID",
      mode: "query",
      prompt: "Extract the invoice total.",
      responseFormat: "json",
      schema,
    })).rejects.toThrow("missing total");
  });

  it("decodes Workers AI SSE into a plain UTF-8 response stream", async () => {
    const source = byteStream([
      "data: {\"text\":\"first \"}\n",
      "\ndata: {\"chunk\":\"second\"}\n\n",
      "data: [DONE]\n\n",
    ]);
    const response = await readImage({ run: vi.fn(async () => source) }, {
      data: "AQID",
      mode: "caption",
      stream: true,
    });

    expect(response?.result).toEqual(expect.objectContaining({
      mode: "caption",
      streamed: true,
      contentType: "text/plain; charset=utf-8",
    }));
    expect(await bodyToText({ stream: response!.stream! })).toBe("first second");
  });

  it("rejects incompatible streaming options", async () => {
    const run = vi.fn();

    await expect(readImage({ run }, {
      data: "AQID",
      mode: "detect",
      target: "horse",
      stream: true,
    })).rejects.toThrow("caption, query, and ocr");
    await expect(readImage({ run }, {
      data: "AQID",
      mode: "query",
      prompt: "Count",
      stream: true,
      responseFormat: "json",
    })).rejects.toThrow("structured output");
  });
});

describe("decodeMoondreamStream", () => {
  it("cancels the upstream reader when the consumer cancels", async () => {
    const cancel = vi.fn();
    const source = new ReadableStream<Uint8Array>({
      pull() {},
      cancel,
    });
    const decoded = decodeMoondreamStream(source);

    await decoded.cancel("done");

    expect(cancel).toHaveBeenCalledWith("done");
  });
});

describe("normalizeImageReadingText", () => {
  it("trims only outer whitespace", () => {
    expect(normalizeImageReadingText(" \n  one\n\n  two \t")).toBe("one\n\n  two");
  });
});

function byteStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}
