import { describe, expect, it } from "vitest";
import { parseSse } from "./sse";

function streamOf(chunks: string[]): Response {
  const encoder = new TextEncoder();
  let index = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index === chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[index]));
      index += 1;
    },
  }));
}

async function collect(response: Response): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of parseSse(response, undefined)) {
    events.push(event);
  }
  return events;
}

describe("parseSse", () => {
  it("keeps events apart when a CRLF delimiter straddles two reads", async () => {
    const events = await collect(streamOf([
      'data: {"type":"one"}\r\n\r',
      '\ndata: {"type":"two"}\r\n\r\n',
    ]));

    expect(events).toEqual([{ type: "one" }, { type: "two" }]);
  });

  it("returns at the DONE sentinel without waiting for the server to close", async () => {
    const encoder = new TextEncoder();
    let closed = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"one"}\n\ndata: [DONE]\n\n'));
        // The stream deliberately stays open.
      },
      cancel() {
        closed = true;
      },
    }));

    const events = await collect(response);

    expect(events).toEqual([{ type: "one" }]);
    expect(closed).toBe(true);
  });

  it("joins multi-line data fields and skips comments", async () => {
    const events = await collect(streamOf([
      ': keep-alive\n\nevent: message\ndata: {"type":\ndata: "one"}\n\n',
    ]));

    expect(events).toEqual([{ type: "one" }]);
  });
});
