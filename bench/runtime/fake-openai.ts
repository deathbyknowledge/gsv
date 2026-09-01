import { createServer, type ServerResponse } from "node:http";
import { jsonValueSchema } from "@humansandmachines/gsv/protocol";
import { z } from "zod";

const fakeRequestSchema = z.object({
  model: z.string(),
  messages: jsonValueSchema,
}).passthrough();

const port = parsePort(process.argv.slice(2));

const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true}\n');
    return;
  }
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    response.writeHead(404, { "content-type": "application/json" });
    response.end('{"error":"not found"}\n');
    return;
  }

  try {
    const payload = fakeRequestSchema.parse(JSON.parse(await readBody(request)));
    const transcript = JSON.stringify(payload.messages ?? []);
    const input = transcript.includes("[GSV EVENT]")
      ? "message send --message 'gpu-lab ready' && yield"
      : "targets list";
    writeToolCall(response, payload.model, input);
  } catch {
    response.writeHead(400, { "content-type": "application/json" });
    response.end('{"error":"invalid request"}\n');
  }
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`fake OpenAI server listening on 127.0.0.1:${port}\n`);
});

function parsePort(argv: string[]): number {
  const index = argv.indexOf("--port");
  const value = Number(argv[index + 1]);
  if (index === -1 || !Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error("Usage: fake-openai.ts --port PORT");
  }
  return value;
}

async function readBody(request: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function writeToolCall(
  response: ServerResponse,
  model: string,
  input: string,
): void {
  const id = input === "targets list" ? "inspect-targets" : "finish";
  const first = {
    id: `chatcmpl-${id}`,
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [{
      index: 0,
      delta: {
        role: "assistant",
        tool_calls: [{
          index: 0,
          id,
          type: "function",
          function: {
            name: "Shell",
            arguments: JSON.stringify({ input }),
          },
        }],
      },
      finish_reason: null,
    }],
  };
  const terminal = {
    id: `chatcmpl-${id}`,
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
  };
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  response.end(
    `data: ${JSON.stringify(first)}\n\ndata: ${JSON.stringify(terminal)}\n\ndata: [DONE]\n\n`,
  );
}
