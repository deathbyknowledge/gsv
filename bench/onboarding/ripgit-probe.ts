/**
 * Sits on the gateway's RIPGIT binding and forwards to the real ripgit worker.
 * It reports every call to the recording proxy, so a run can count how many
 * ripgit round trips each model step costs. RIPGIT_LATENCY_MS adds an artificial
 * delay per call, to test how sensitive a step is to a slower storage hop.
 */
import { WorkerEntrypoint } from "cloudflare:workers";

type Env = { REAL: Fetcher; LOG_URL: string; RIPGIT_LATENCY_MS: string };

export default class RipgitProbe extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    const startedAt = Date.now();
    const url = new URL(request.url);
    const delay = Number(this.env.RIPGIT_LATENCY_MS || 0);
    if (delay > 0) await scheduler.wait(delay);
    const response = await this.env.REAL.fetch(request);
    const record = { at: startedAt, method: request.method, path: url.pathname, query: url.search, status: response.status, ms: Date.now() - startedAt };
    this.ctx.waitUntil(fetch(this.env.LOG_URL, { method: "POST", body: JSON.stringify(record) }).catch(() => undefined));
    return response;
  }
}
