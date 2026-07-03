import type { AssistantMessageEvent, Context } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamWithCustomProvider } from "./custom-provider";

const CONTEXT: Context = {
  systemPrompt: "",
  messages: [],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("streamWithCustomProvider", () => {
  it("uses fetch for keyless OpenAI-compatible custom providers", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response([
      openAiChatSseChunk({ id: "chatcmpl-test", model: "local", choices: [{ delta: { content: "pong" } }] }),
      openAiChatSseChunk({
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 2, completion_tokens: 1 },
      }),
      "data: [DONE]\n\n",
    ].join(""), {
      headers: { "content-type": "text/event-stream" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const stream = streamWithCustomProvider({
      provider: "custom",
      model: "local",
      baseUrl: "http://localhost:18081/v1",
      providerStyle: "openai-chat-completions",
      maxTokens: 32,
      context: CONTEXT,
    });

    const message = await stream.result();
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const payload = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    expect(payload.stream_options).toBeUndefined();
    expect(message.content).toEqual([{ type: "text", text: "pong" }]);
  });

  it("requests streamed usage only for native OpenAI chat completions", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response([
      openAiChatSseChunk({ id: "chatcmpl-test", model: "gpt-4o-mini", choices: [{ delta: { content: "pong" } }] }),
      openAiChatSseChunk({
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 2, completion_tokens: 1 },
      }),
      "data: [DONE]\n\n",
    ].join(""), {
      headers: { "content-type": "text/event-stream" },
    }));

    const stream = streamWithCustomProvider({
      provider: "openai",
      model: "gpt-4o-mini",
      providerStyle: "openai-chat-completions",
      fetch: fetchMock,
      maxTokens: 32,
      context: CONTEXT,
    });

    await stream.result();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    const payload = JSON.parse(String((init as RequestInit | undefined)?.body ?? "{}")) as Record<string, unknown>;

    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(payload.stream_options).toEqual({ include_usage: true });
  });

  it("emits OpenAI chat completion deltas before the SSE response closes", async () => {
    const encoder = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const responseBody = new ReadableStream<Uint8Array>({
      start(nextController) {
        controller = nextController;
      },
    });
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(responseBody, {
      headers: { "content-type": "text/event-stream" },
    }));

    const stream = streamWithCustomProvider({
      provider: "custom",
      model: "local",
      baseUrl: "http://localhost:18081/v1",
      providerStyle: "openai-chat-completions",
      fetch: fetchMock,
      maxTokens: 32,
      context: CONTEXT,
    });
    const iterator = stream[Symbol.asyncIterator]();

    const start = await nextEvent(iterator);
    expect(start.done).toBe(false);
    expect(start.value).toMatchObject({ type: "start" });

    controller.enqueue(encoder.encode(openAiChatSseChunk({
      id: "chatcmpl-test",
      model: "local",
      choices: [{ delta: { content: "hel" } }],
    })));

    const textStart = await nextEvent(iterator);
    const textDelta = await nextEvent(iterator);
    expect(textStart.value).toMatchObject({ type: "text_start" });
    expect(textDelta.value).toMatchObject({ type: "text_delta", delta: "hel" });

    controller.enqueue(encoder.encode(openAiChatSseChunk({
      choices: [{ delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 2, completion_tokens: 1 },
    })));
    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
    controller.close();

    const message = await stream.result();
    expect(message.content).toEqual([{ type: "text", text: "hel" }]);
  });
});

function openAiChatSseChunk(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

async function nextEvent(
  iterator: AsyncIterator<AssistantMessageEvent>,
): Promise<IteratorResult<AssistantMessageEvent>> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  return new Promise((resolve, reject) => {
    timeout = setTimeout(() => reject(new Error("Timed out waiting for stream event")), 500);
    void iterator.next().then(
      (event) => {
        if (timeout) clearTimeout(timeout);
        resolve(event);
      },
      (error) => {
        if (timeout) clearTimeout(timeout);
        reject(error);
      },
    );
  });
}
