import type { processResponsesStream } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { z } from "zod";

/**
 * The OpenAI Responses stream event pi-ai consumes. Derived from pi-ai's own
 * signature so the gateway does not depend on the OpenAI SDK for its types.
 */
export type OpenAiResponseStreamEvent =
  Parameters<typeof processResponsesStream>[0] extends AsyncIterable<infer Event> ? Event : never;

const sseEventSchema = z.object({ type: z.string() }).catchall(z.json());
const responseEventSchema = z.custom<OpenAiResponseStreamEvent>(
  (value) => sseEventSchema.safeParse(value).success,
  "OpenAI response event must be a JSON object with a string discriminator",
);

/**
 * Parses a `text/event-stream` response into the JSON payload of each
 * `data:` event. Stops at the `[DONE]` sentinel and cancels the body when
 * the request signal aborts.
 */
export async function* parseSse(
  response: Response,
  signal: AbortSignal | undefined,
): AsyncIterable<unknown> {
  const reader = response.body?.getReader();
  if (!reader) {
    return;
  }
  const decoder = new TextDecoder();
  let buffer = "";
  const onAbort = (): void => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      if (signal?.aborted) {
        throw new Error("Request was aborted");
      }
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let index = buffer.indexOf("\n\n");
      while (index !== -1) {
        const chunk = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const data = chunk
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n")
          .trim();
        if (data && data !== "[DONE]") {
          yield JSON.parse(data);
        }
        index = buffer.indexOf("\n\n");
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Narrows parsed SSE payloads to Responses API events by their string discriminator. */
export async function* openAiResponseEvents(
  events: AsyncIterable<unknown>,
): AsyncIterable<OpenAiResponseStreamEvent> {
  for await (const event of events) {
    yield responseEventSchema.parse(event);
  }
}
