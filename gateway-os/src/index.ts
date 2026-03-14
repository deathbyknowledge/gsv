import { WorkerEntrypoint } from "cloudflare:workers";
import { isWebSocketRequest } from "./shared//utils";
import type {
  GatewayAdapterInterface,
} from "./adapter-interface";
import type { Frame } from "./protocol/frames";
import { getAgentByName } from "agents";

export { Kernel } from "./kernel/do";
export { Process } from "./process/do";

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ status: "healthy" });
    }

    if (url.pathname === "/ws" && isWebSocketRequest(request)) {
      const kernel = await getAgentByName(env.KERNEL, "singleton");
      return kernel.fetch(request);
    }

    // Serve media files from R2
    // /media/{uuid}.{ext}
    // TODO: either remove or auth this
    const mediaMatch = url.pathname.match(
      /^\/media\/([a-f0-9-]+\.[a-z0-9]+)$/i,
    );
    if (mediaMatch && request.method === "GET") {
      const key = `media/${mediaMatch[1]}`;
      const object = await env.STORAGE.get(key);

      if (!object) {
        return new Response("Not Found", { status: 404 });
      }

      // Check if expired
      const expiresAt = object.customMetadata?.expiresAt;
      if (expiresAt && parseInt(expiresAt, 10) < Date.now()) {
        // Clean up expired file
        await env.STORAGE.delete(key);
        return new Response("Expired", { status: 410 });
      }

      const headers = new Headers();
      headers.set(
        "Content-Type",
        object.httpMetadata?.contentType || "application/octet-stream",
      );
      headers.set("Cache-Control", "private, max-age=3600");
      // Allow cross-origin for LLM APIs
      headers.set("Access-Control-Allow-Origin", "*");

      return new Response(object.body, { headers });
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

/**
 * Gateway Entrypoint for Service Binding RPC
 *
 * Adapter workers call these methods via Service Bindings.
 * This provides a secure, type-safe interface for adapters to deliver
 * inbound messages to the Gateway.
 */
export class GatewayEntrypoint
  extends WorkerEntrypoint<Env>
  implements GatewayAdapterInterface
{
  async serviceFrame(frame: Frame): Promise<Frame | null> {
    try {
      const kernel = await getAgentByName(this.env.KERNEL, "singleton");
      return await kernel.serviceFrame(frame);
    } catch (e) {
      console.error("[GatewayEntrypoint] serviceFrame failed:", e);
      return null;
    }
  }
}
