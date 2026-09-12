import { WorkerEntrypoint } from "cloudflare:workers";
import { z } from "zod";
import { timingSafeEqual } from "node:crypto";
import type { DelayedControl, DelayScope, DelayProcess } from "./relay.ts";
import { inspectPhysicalResources, physicalRequestSchema, type PhysicalEnvironment } from "./physical-probe.ts";

type Environment = PhysicalEnvironment & {
  CONTROL: Service<DelayedControl>;
  CONTROL_SECRET: string;
  CONTROL_ORIGIN: string;
  DELAY_INSTALLATION_ID: string;
  DELAY_PROCESS_ID: string;
  LEASE_TIMEOUT_MS: number;
};

const headers = { "cache-control": "no-store", "content-type": "application/json" };

/** A separate authenticated HTTP request owns the lease, independently of Process. */
export default class DelayedController extends WorkerEntrypoint<Environment> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const expected = `Bearer ${this.env.CONTROL_SECRET}`;
    const provided = request.headers.get("authorization") ?? "";
    if (url.origin !== this.env.CONTROL_ORIGIN || !/^[a-f0-9]{64}$/.test(this.env.CONTROL_SECRET)
      || !/^Bearer [a-f0-9]{64}$/.test(provided) || !timingSafeEqual(new TextEncoder().encode(provided), new TextEncoder().encode(expected))) {
      return new Response(null, { status: 403, headers });
    }
    if (request.method !== "POST" || !["/inspect", "/lease", "/status", "/release", "/physical"].includes(url.pathname)
      || request.headers.get("origin") !== this.env.CONTROL_ORIGIN) return new Response(null, { status: 400, headers });
    let scope: DelayScope | DelayProcess;
    try {
      if (!request.body) throw new Error("Missing scope");
      const reader = request.body.getReader();
      let text = "";
      let length = 0;
      const decoder = new TextDecoder("utf-8", { fatal: true });
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          length += part.value.byteLength;
          if (length > 4096) throw new Error("Oversized scope");
          text += decoder.decode(part.value, { stream: true });
        }
        text += decoder.decode();
      } catch (error) { await reader.cancel().catch(() => {}); throw error; }
      finally { reader.releaseLock(); }
      if (!this.env.DELAY_INSTALLATION_ID || !this.env.DELAY_PROCESS_ID) throw new Error("Fixture is not selected");
      if (url.pathname === "/physical") {
        try { return Response.json(await inspectPhysicalResources(this.env, physicalRequestSchema.parse(JSON.parse(text))), { headers }); }
        catch { return new Response(null, { status: 409, headers }); }
      }
      const installationId = z.literal(this.env.DELAY_INSTALLATION_ID);
      scope = url.pathname === "/inspect"
        ? z.strictObject({ installationId, processId: z.literal(this.env.DELAY_PROCESS_ID) }).parse(JSON.parse(text))
        : z.strictObject({ installationId, logicalRequestId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/) }).parse(JSON.parse(text));
    } catch { return new Response(null, { status: 400, headers }); }
    try {
      if ("processId" in scope) return Response.json(await this.env.CONTROL.inspect(scope), { headers });
      if (url.pathname === "/status") return Response.json(await this.env.CONTROL.status(scope), { headers });
      if (url.pathname === "/release") return Response.json(await this.env.CONTROL.release(scope), { headers });
      const timeout = this.env.LEASE_TIMEOUT_MS;
      if (!Number.isSafeInteger(timeout) || timeout < 1000 || timeout > 660000) throw new Error("Invalid lease deadline");
      const body = await this.env.CONTROL.arm(scope);
      return new Response(body.pipeThrough(new TransformStream(), { signal: AbortSignal.timeout(timeout) }), {
        headers: { "cache-control": "no-store", "content-type": "application/octet-stream" },
      });
    } catch { return new Response(null, { status: 409, headers }); }
  }
}
