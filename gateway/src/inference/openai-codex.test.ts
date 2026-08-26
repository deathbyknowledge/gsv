import { describe, expect, it } from "vitest";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import {
  completeWithOpenAiCodexFetch,
  streamWithOpenAiCodexFetch,
} from "./openai-codex";

function codexToken(accountId = "acct-test"): string {
  return jwtToken({
    "https://api.openai.com/auth": {
      chatgpt_account_id: accountId,
    },
  });
}

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
type JsonObject = { [key: string]: JsonValue };

function jwtToken(payload: JsonObject): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `header.${encoded}.signature`;
}

function bareCodexToken(): string {
  const payload = Buffer.from(JSON.stringify({ sub: "user-1" })).toString("base64url");
  return `header.${payload}.signature`;
}

function codexModel() {
  const model = getBuiltinModels("openai-codex").find((candidate) => candidate.id === "gpt-5.4-mini");
  if (!model) {
    throw new Error("missing openai-codex/gpt-5.4-mini fixture");
  }
  return model;
}

function codexTextEvents(text = "ok"): JsonObject[] {
  return [
    {
      type: "response.created",
      response: { id: "resp_1" },
    },
    {
      type: "response.output_item.added",
      item: { id: "msg_1", type: "message", role: "assistant", status: "in_progress", content: [] },
    },
    {
      type: "response.content_part.added",
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    },
    {
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      delta: text,
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    },
    {
      type: "response.completed",
      response: {
        id: "resp_1",
        model: "gpt-5.4-mini",
        status: "completed",
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          total_tokens: 2,
          input_tokens_details: { cached_tokens: 0 },
        },
      },
    },
  ];
}

function sseResponse(events: JsonObject[], separator = "\n\n"): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}${separator}`).join("");
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cf-ray": "ray-test",
    },
  });
}

describe("OpenAI Codex routed fetch transport", () => {
  it("streams Codex SSE through the supplied fetch implementation", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fetchMock: typeof fetch = async (url, init) => {
      capturedUrl = String(url);
      capturedInit = init;
      return sseResponse(codexTextEvents());
    };

    const result = await completeWithOpenAiCodexFetch({
      model: codexModel(),
      context: {
        systemPrompt: "Reply briefly.",
        messages: [{ role: "user", content: "Say ok" }],
      },
      fetch: fetchMock,
      options: {
        apiKey: codexToken("acct-123"),
        reasoning: "low",
        sessionId: "session-1",
        timeoutMs: 30_000,
      },
    });

    const headers = new Headers(capturedInit?.headers);
    const body = JSON.parse(String(capturedInit?.body));

    expect(result.stopReason).toBe("stop");
    expect(result.content).toContainEqual(expect.objectContaining({ type: "text", text: "ok" }));
    expect(capturedUrl).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(headers.get("authorization")).toBe(`Bearer ${codexToken("acct-123")}`);
    expect(headers.get("chatgpt-account-id")).toBe("acct-123");
    expect(headers.get("openai-beta")).toBe("responses=experimental");
    expect(headers.get("session-id")).toBe("session-1");
    expect(body).toMatchObject({
      model: "gpt-5.4-mini",
      stream: true,
      store: false,
      instructions: "Reply briefly.",
      prompt_cache_key: "session-1",
      tool_choice: "auto",
      parallel_tool_calls: true,
    });
    expect(body).not.toHaveProperty("max_output_tokens");
  });

  it("uses an OAuth account id supplied outside the access token", async () => {
    let capturedInit: RequestInit | undefined;
    const accessToken = bareCodexToken();
    const fetchMock: typeof fetch = async (_url, init) => {
      capturedInit = init;
      return sseResponse(codexTextEvents());
    };

    const result = await completeWithOpenAiCodexFetch({
      model: codexModel(),
      context: {
        systemPrompt: "Reply briefly.",
        messages: [{ role: "user", content: "Say ok" }],
      },
      fetch: fetchMock,
      options: {
        apiKey: accessToken,
        openAiCodexAccountId: "acct-from-metadata",
      },
    });

    const headers = new Headers(capturedInit?.headers);

    expect(result.stopReason).toBe("stop");
    expect(headers.get("authorization")).toBe(`Bearer ${accessToken}`);
    expect(headers.get("chatgpt-account-id")).toBe("acct-from-metadata");
  });

  it("handles CRLF-delimited Codex SSE frames", async () => {
    const fetchMock: typeof fetch = async () => sseResponse(codexTextEvents(), "\r\n\r\n");

    const result = await completeWithOpenAiCodexFetch({
      model: codexModel(),
      context: {
        systemPrompt: "Reply briefly.",
        messages: [{ role: "user", content: "Say ok" }],
      },
      fetch: fetchMock,
      options: {
        apiKey: codexToken("acct-123"),
      },
    });

    expect(result.stopReason).toBe("stop");
    expect(result.content).toContainEqual(expect.objectContaining({ type: "text", text: "ok" }));
  });

  it("emits an error instead of done for terminal failed Codex responses", async () => {
    const fetchMock: typeof fetch = async () => sseResponse([
      {
        type: "response.created",
        response: { id: "resp_failed" },
      },
      {
        type: "response.completed",
        response: {
          id: "resp_failed",
          model: "gpt-5.4-mini",
          status: "failed",
          error: {
            code: "server_error",
            message: "Codex failed",
          },
          usage: {
            input_tokens: 1,
            output_tokens: 0,
            total_tokens: 1,
            input_tokens_details: { cached_tokens: 0 },
          },
        },
      },
    ]);

    const stream = streamWithOpenAiCodexFetch({
      model: codexModel(),
      context: {
        systemPrompt: "Reply briefly.",
        messages: [{ role: "user", content: "Say ok" }],
      },
      fetch: fetchMock,
      options: {
        apiKey: codexToken("acct-123"),
      },
    });
    const events = [];
    for await (const event of stream) {
      events.push(event);
    }

    const result = await stream.result();

    expect(events.map((event) => event.type)).toEqual(["start", "error"]);
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("OpenAI Codex returned an error stop reason");
  });

  it("includes non-secret response diagnostics on HTML challenge errors", async () => {
    const fetchMock: typeof fetch = async () =>
      new Response("<html><body>Unable to load site</body></html>", {
        status: 403,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cf-ray": "ray-blocked",
          "x-request-id": "req-blocked",
        },
      });

    const result = await streamWithOpenAiCodexFetch({
      model: codexModel(),
      context: { systemPrompt: "", messages: [{ role: "user", content: "hi" }] },
      fetch: fetchMock,
      options: {
        apiKey: codexToken(),
      },
    }).result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("HTTP 403");
    expect(result.errorMessage).toContain("cf-ray=ray-blocked");
    expect(result.errorMessage).toContain("<html>");
  });
});
