import { RpcTarget } from "cloudflare:workers";
import type { InferenceTransport } from "@humansandmachines/gsv/services/inference-execution";
import { ownInferenceBody } from "./owned-body";

/** An invocation-scoped capability wrapping an already-authorized routed fetch. */
export class RoutedInferenceTransport extends RpcTarget implements InferenceTransport {
  readonly #fetch: typeof fetch;
  readonly #requests = new Map<string, AbortController>();
  readonly #seen = new Set<string>();
  #closed = false;

  constructor(fetch: typeof globalThis.fetch) {
    super();
    this.#fetch = fetch;
  }

  async fetch(requestId: string, request: Request): Promise<Response> {
    if (this.#closed || this.#seen.has(requestId)) {
      await request.body?.cancel().catch(() => {});
      throw new Error("Inference transport request is closed");
    }
    if (!/^[\w-]{1,128}$/.test(requestId) || this.#seen.size >= 256) {
      await request.body?.cancel().catch(() => {});
      throw new Error("Inference transport request limit exceeded");
    }
    this.#seen.add(requestId);
    const controller = new AbortController();
    this.#requests.set(requestId, controller);
    const cleanup = () => this.#requests.delete(requestId);
    try {
      const response = await this.#fetch(request, { signal: controller.signal });
      if (controller.signal.aborted || this.#closed) {
        await response.body?.cancel().catch(() => {});
        throw new Error("Inference transport request was cancelled");
      }
      if (!response.body) {
        cleanup();
        return response;
      }
      const body = ownInferenceBody(response.body, controller.signal,
        (reason) => controller.abort(reason), cleanup);
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      cleanup();
      controller.abort(error);
      throw error;
    }
  }

  async abort(requestId: string): Promise<void> {
    // An abort may overtake its fetch RPC; remember it for this capability's lifetime.
    if (!/^[\w-]{1,128}$/.test(requestId)) throw new Error("Invalid inference transport request");
    if (!this.#seen.has(requestId) && this.#seen.size >= 256) {
      this.close();
      return;
    }
    this.#seen.add(requestId);
    this.#requests.get(requestId)?.abort(new Error("Inference transport request was cancelled"));
  }

  close(): void {
    this.#closed = true;
    for (const controller of this.#requests.values()) controller.abort();
    this.#requests.clear();
  }

  [Symbol.dispose](): void {
    this.close();
  }
}
