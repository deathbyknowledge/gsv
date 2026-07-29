import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export const INTEGRATION_REPLY = "deterministic integration reply";

export type RecordedGenerationRequest = {
  path: string;
  usesFixtureCredential: boolean;
  model: string | undefined;
  stream: boolean;
  messageCount: number;
  toolCount: number;
};

export type OpenAiFixture = {
  baseUrl: string;
  requests: RecordedGenerationRequest[];
  close(): Promise<void>;
};

export async function startOpenAiFixture(): Promise<OpenAiFixture> {
  const requests: RecordedGenerationRequest[] = [];
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end("Not Found");
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    requests.push({
      path: request.url,
      usesFixtureCredential: request.headers.authorization === "Bearer fixture-only",
      model: typeof body.model === "string" ? body.model : undefined,
      stream: body.stream === true,
      messageCount: Array.isArray(body.messages) ? body.messages.length : 0,
      toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
    });

    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": "text/event-stream",
    });
    setTimeout(() => {
      response.write(openAiChunk({
        id: `chatcmpl-integration-${requests.length}`,
        model: "integration-model",
        choices: [{ delta: { content: INTEGRATION_REPLY } }],
      }));
      response.write(openAiChunk({
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 3,
          total_tokens: 13,
        },
      }));
      response.end("data: [DONE]\n\n");
    }, 25);
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
    close: () => closeServer(server),
  };
}

function openAiChunk(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
