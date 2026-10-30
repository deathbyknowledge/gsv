import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";

/**
 * Recording proxy in front of Together. The gateway talks to it as it would to
 * the provider. It keeps the only copy of the key, asks for usage on every
 * stream, and times the request: when it arrived, when the first byte, first
 * reasoning, first text and first tool-call delta came back, and when it ended.
 */

export type ModelStep = {
  index: number;
  startedAt: number;
  firstByteMs: number | null;
  firstReasoningMs: number | null;
  firstTextMs: number | null;
  firstToolDeltaMs: number | null;
  totalMs: number;
  status: number;
  model: string;
  reasoningEffort: string | null;
  requestBytes: number;
  messageCount: number;
  toolNames: string[];
  systemChars: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  finishReason: string | null;
  toolCalls: Array<{ name: string; args: string }>;
  text: string;
  reasoningChars: number;
  reasoningText: string;
  costUsd: number;
  error: string | null;
};

// Production's implied prices, solved from inference.request.finished cost and token fields.
const INPUT_USD = 300e-9;
const CACHED_USD = 6e-9;
const OUTPUT_USD = 1200e-9;

export function readTogetherKey(path = "/home/someone/HAM/infrastructure/.env"): string {
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim().replace(/^export\s+/, "");
    if (line.startsWith("TOGETHER_AI_API_KEY=")) {
      return line.slice("TOGETHER_AI_API_KEY=".length).replace(/^['"]|['"]$/g, "");
    }
  }
  throw new Error("TOGETHER_AI_API_KEY is not in the environment file");
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((done, fail) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => done(Buffer.concat(chunks)));
    request.on("error", fail);
  });
}

type Delta = {
  content?: string | null;
  reasoning?: string | null;
  reasoning_content?: string | null;
  tool_calls?: Array<{ index?: number; function?: { name?: string; arguments?: string } }>;
};
type Chunk = {
  choices?: Array<{ delta?: Delta; finish_reason?: string | null }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cached_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  } | null;
};

export type RipgitCall = { at: number; method: string; path: string; query: string; status: number; ms: number };

export type RecordingProxy = {
  baseUrl: string;
  ripgitLogUrl: string;
  /** The most recent request bodies, for inspecting the exact prompt. */
  requests: unknown[];
  /** Take the ripgit calls reported since the last call. */
  takeRipgit(): RipgitCall[];
  /** Take the steps recorded since the last call; each run gets its own list. */
  take(): ModelStep[];
  close(): Promise<void>;
};

export async function startProxy(options: { apiKey: string; upstream?: string }): Promise<RecordingProxy> {
  const upstream = options.upstream ?? "https://api.together.ai/v1";
  let steps: ModelStep[] = [];
  let index = 0;
  let ripgit: RipgitCall[] = [];
  const requests: unknown[] = [];

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const body = await readBody(request);
    if (request.url === "/__ripgit") {
      ripgit.push(JSON.parse(body.toString("utf8")) as RipgitCall);
      response.writeHead(204).end();
      return;
    }
    const startedAt = Date.now();
    const parsed = JSON.parse(body.toString("utf8")) as {
      model: string;
      reasoning_effort?: string;
      messages: Array<{ role: string; content: unknown }>;
      tools?: Array<{ function?: { name?: string } }>;
      stream_options?: Record<string, unknown>;
    };
    parsed.stream_options = { ...parsed.stream_options, include_usage: true };
    const system = parsed.messages.find((message) => message.role === "system" || message.role === "developer");
    const step: ModelStep = {
      index: index++,
      startedAt,
      firstByteMs: null,
      firstReasoningMs: null,
      firstTextMs: null,
      firstToolDeltaMs: null,
      totalMs: 0,
      status: 0,
      model: parsed.model,
      reasoningEffort: parsed.reasoning_effort ?? null,
      requestBytes: body.byteLength,
      messageCount: parsed.messages.length,
      toolNames: (parsed.tools ?? []).map((tool) => tool.function?.name ?? "?"),
      systemChars: typeof system?.content === "string" ? system.content.length : JSON.stringify(system?.content ?? "").length,
      inputTokens: 0,
      cachedTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      finishReason: null,
      toolCalls: [],
      text: "",
      reasoningChars: 0,
      reasoningText: "",
      costUsd: 0,
      error: null,
    };
    steps.push(step);
    requests.push(parsed);
    if (requests.length > 40) requests.shift();
    const headers = new Headers({ "content-type": "application/json", authorization: `Bearer ${options.apiKey}` });
    let upstreamResponse: Response;
    try {
      upstreamResponse = await fetch(`${upstream}/chat/completions`, {
        method: "POST", headers, body: JSON.stringify(parsed),
      });
    } catch (error) {
      step.error = String(error);
      step.totalMs = Date.now() - startedAt;
      response.writeHead(502).end();
      return;
    }
    step.status = upstreamResponse.status;
    response.writeHead(upstreamResponse.status, { "content-type": upstreamResponse.headers.get("content-type") ?? "text/event-stream" });
    const tools = new Map<number, { name: string; args: string }>();
    let pending = "";
    const consume = (text: string): void => {
      pending += text;
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        let chunk: Chunk;
        try {
          chunk = JSON.parse(data) as Chunk;
        } catch {
          continue;
        }
        const elapsed = Date.now() - startedAt;
        if (chunk.usage) {
          step.inputTokens = chunk.usage.prompt_tokens ?? 0;
          step.outputTokens = chunk.usage.completion_tokens ?? 0;
          step.cachedTokens = chunk.usage.prompt_tokens_details?.cached_tokens ?? chunk.usage.cached_tokens ?? 0;
          step.reasoningTokens = chunk.usage.completion_tokens_details?.reasoning_tokens ?? 0;
        }
        for (const choice of chunk.choices ?? []) {
          if (choice.finish_reason) step.finishReason = choice.finish_reason;
          const delta = choice.delta;
          if (!delta) continue;
          const reasoning = delta.reasoning ?? delta.reasoning_content;
          if (reasoning) {
            step.firstReasoningMs ??= elapsed;
            step.reasoningChars += reasoning.length;
            step.reasoningText += reasoning;
          }
          if (delta.content) {
            step.firstTextMs ??= elapsed;
            step.text += delta.content;
          }
          for (const call of delta.tool_calls ?? []) {
            step.firstToolDeltaMs ??= elapsed;
            const key = call.index ?? tools.size;
            const entry = tools.get(key) ?? { name: "", args: "" };
            if (call.function?.name) entry.name = call.function.name;
            if (call.function?.arguments) entry.args += call.function.arguments;
            tools.set(key, entry);
          }
        }
      }
    };
    const decoder = new TextDecoder();
    if (upstreamResponse.body) {
      const reader = upstreamResponse.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        step.firstByteMs ??= Date.now() - startedAt;
        consume(decoder.decode(value, { stream: true }));
        response.write(value);
      }
    }
    response.end();
    step.totalMs = Date.now() - startedAt;
    step.toolCalls = [...tools.values()];
    const uncached = Math.max(0, step.inputTokens - step.cachedTokens);
    step.costUsd = uncached * INPUT_USD + step.cachedTokens * CACHED_USD + step.outputTokens * OUTPUT_USD;
    if (upstreamResponse.status >= 400) step.error = `status ${upstreamResponse.status}: ${pending.slice(0, 300)}`;
  };

  const server = createServer((request, response) => {
    void handle(request, response).catch((error) => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
      console.error("[proxy]", error instanceof Error ? error.message : error);
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("proxy has no port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    ripgitLogUrl: `http://127.0.0.1:${address.port}/__ripgit`,
    takeRipgit() {
      const taken = ripgit;
      ripgit = [];
      return taken;
    },
    take() {
      const taken = steps;
      steps = [];
      return taken;
    },
    close: () => new Promise((done) => server.close(() => done())),
  };
}
