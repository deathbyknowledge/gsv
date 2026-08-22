import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const INTEGRATION_REPLY = "deterministic integration reply";

export type RecordedGenerationRequest = {
  path: string;
  usesFixtureCredential: boolean;
  model: string | undefined;
  stream: boolean;
  messageCount: number;
  toolCount: number;
  messages: unknown[];
  tools: unknown[];
};

export type ScriptedOpenAiToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type ScriptedOpenAiResponse =
  | {
      kind: "text";
      chunks: string[];
      delayMs?: number;
    }
  | {
      kind: "message";
      text: string;
      delayMs?: number;
    }
  | {
      kind: "tool-calls";
      calls: ScriptedOpenAiToolCall[];
      delayMs?: number;
    }
  | {
      kind: "error";
      status: number;
      message: string;
      code?: string;
      delayMs?: number;
    };

export type HeldOpenAiResponse = {
  started: Promise<void>;
  release(): void;
};

export type OpenAiFixture = {
  baseUrl: string;
  requests: RecordedGenerationRequest[];
  enqueue(...responses: ScriptedOpenAiResponse[]): void;
  hold(response: ScriptedOpenAiResponse): HeldOpenAiResponse;
  waitForRequests(count: number, timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
};

type Deferred = {
  promise: Promise<void>;
  resolve(): void;
};

type QueuedResponse = {
  response: ScriptedOpenAiResponse;
  started?: Deferred;
  released?: Deferred;
};

const DEFAULT_RESPONSE: ScriptedOpenAiResponse = {
  kind: "message",
  text: INTEGRATION_REPLY,
  delayMs: 25,
};

export async function startOpenAiFixture(): Promise<OpenAiFixture> {
  const requests: RecordedGenerationRequest[] = [];
  const queue: QueuedResponse[] = [];
  const heldResponses = new Set<Deferred>();
  let closed = false;

  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end("Not Found");
      return;
    }

    let body: Record<string, unknown>;
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    } catch {
      writeJsonError(response, 400, "Fixture received invalid JSON");
      return;
    }

    const messages = copyArray(body.messages);
    const tools = copyArray(body.tools);
    const requestNumber = requests.push({
      path: request.url,
      usesFixtureCredential: request.headers.authorization === "Bearer fixture-only",
      model: typeof body.model === "string" ? body.model : undefined,
      stream: body.stream === true,
      messageCount: messages.length,
      toolCount: tools.length,
      messages,
      tools,
    });

    const queued = queue.shift() ?? { response: DEFAULT_RESPONSE };
    queued.started?.resolve();
    if (queued.released) {
      await queued.released.promise;
      heldResponses.delete(queued.released);
    }
    if (closed) {
      response.destroy();
      return;
    }
    if (response.destroyed) return;

    const delayMs = queued.response.delayMs ?? 0;
    if (delayMs > 0) {
      await delay(delayMs);
    }
    if (closed) {
      response.destroy();
      return;
    }
    if (response.destroyed) return;

    writeScriptedResponse(response, queued.response, requestNumber);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    enqueue: (...responses) => {
      queue.push(...responses.map((response) => ({ response: copyResponse(response) })));
    },
    hold: (response) => {
      const started = deferred();
      const released = deferred();
      heldResponses.add(released);
      queue.push({ response: copyResponse(response), started, released });
      return {
        started: started.promise,
        release: released.resolve,
      };
    },
    waitForRequests: async (count, timeoutMs = 10_000) => {
      const deadline = Date.now() + timeoutMs;
      while (requests.length < count && Date.now() < deadline) {
        await delay(10);
      }
      if (requests.length < count) {
        throw new Error(`Timed out waiting for ${count} OpenAI fixture request(s)`);
      }
    },
    close: async () => {
      closed = true;
      for (const released of heldResponses) released.resolve();
      heldResponses.clear();
      await closeServer(server);
    },
  };
}

function writeScriptedResponse(
  response: ServerResponse,
  scripted: ScriptedOpenAiResponse,
  requestNumber: number,
): void {
  if (scripted.kind === "error") {
    writeJsonError(response, scripted.status, scripted.message, scripted.code);
    return;
  }

  response.writeHead(200, {
    "cache-control": "no-store",
    "content-type": "text/event-stream",
  });
  const id = `chatcmpl-integration-${requestNumber}`;
  if (scripted.kind === "text") {
    for (const content of scripted.chunks) {
      response.write(openAiChunk({
        id,
        model: "integration-model",
        choices: [{ delta: { content } }],
      }));
    }
    response.write(openAiChunk({
      id,
      model: "integration-model",
      choices: [{ delta: {}, finish_reason: "stop" }],
      usage: fixtureUsage(),
    }));
  } else {
    const calls = scripted.kind === "message"
      ? [{
          id: `message-integration-${requestNumber}`,
          name: "Message",
          arguments: { text: scripted.text },
        }]
      : scripted.calls;
    response.write(openAiChunk({
      id,
      model: "integration-model",
      choices: [{
        delta: {
          tool_calls: calls.map((call, index) => ({
            index,
            id: call.id,
            type: "function",
            function: {
              name: call.name,
              arguments: JSON.stringify(call.arguments),
            },
          })),
        },
      }],
    }));
    response.write(openAiChunk({
      id,
      model: "integration-model",
      choices: [{ delta: {}, finish_reason: "tool_calls" }],
      usage: fixtureUsage(),
    }));
  }
  response.end("data: [DONE]\n\n");
}

function writeJsonError(
  response: ServerResponse,
  status: number,
  message: string,
  code?: string,
): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json",
  });
  response.end(JSON.stringify({
    error: {
      message,
      type: "fixture_error",
      ...(code ? { code } : {}),
    },
  }));
}

function copyArray(value: unknown): unknown[] {
  return Array.isArray(value) ? structuredClone(value) : [];
}

function copyResponse(response: ScriptedOpenAiResponse): ScriptedOpenAiResponse {
  return structuredClone(response);
}

function deferred(): Deferred {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  let settled = false;
  return {
    promise,
    resolve: () => {
      if (settled) return;
      settled = true;
      resolvePromise();
    },
  };
}

function fixtureUsage(): Record<string, number> {
  return {
    prompt_tokens: 10,
    completion_tokens: 3,
    total_tokens: 13,
  };
}

function delay(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function openAiChunk(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  const closing = new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  server.closeAllConnections();
  await closing;
}
