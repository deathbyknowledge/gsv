import { WorkerEntrypoint } from "cloudflare:workers";
import * as z from "zod/mini";
import { InferenceExecutor as PublicExecutor, type InferenceServiceEnvironment } from "@humansandmachines/gsv-inference/executor";
export { default, StandaloneInferenceDirectoryEntrypoint } from "../index";

let calls = 0;
let textDispatch: { url: string; model: string } | null = null;
export class NativeCalls extends WorkerEntrypoint {
  async count(): Promise<number> { return calls; }
  async dispatch(): Promise<{ url: string; model: string } | null> { return textDispatch; }
}

/** Only native AI is synthetic; the executor and its self-bound admission are real. */
export class InferenceExecutor extends PublicExecutor {
  constructor(ctx: DurableObjectState, env: InferenceServiceEnvironment) {
    super(ctx, { ...env, AI: {
      aiGatewayLogId: null,
      async fetch(input, init) {
        const request = new Request(input, init);
        const payload = z.object({ model: z.string() }).parse(await request.json());
        textDispatch = { url: request.url, model: payload.model };
        calls++;
        const chunks = [
          { id: "fixture-response", choices: [{ index: 0, delta: { content: "fixture reply" } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } },
        ].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("");
        return new Response(`${chunks}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
      },
      async run() { calls++; return { text: "fixture transcription" }; },
    } });
  }
}
