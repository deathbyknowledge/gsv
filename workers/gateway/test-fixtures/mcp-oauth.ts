import type { CallToolResult, InitializeResult, ListPromptsResult, ListResourcesResult, ListResourceTemplatesResult, ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

/** An isolated OAuth issuer and MCP resource; all credentials are fixture-only. */
export function createMcpOAuthFixture(origin: string, transport: "streamable-http" | "sse" = "streamable-http") {
  let generation = 0;
  let refreshAllowed = true;
  let refreshToken = "";
  let issuedTokens = 0;
  let events: ReadableStreamDefaultController<Uint8Array> | undefined;
  const codes = new Map<string, string>();
  const fixture = {
    refreshes: 0,
    exchanges: 0,
    calls: 0,
    forbidden: false,
    toolError: false,
    expire(refreshable = false): void {
      generation += 1;
      refreshAllowed = refreshable;
    },
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname.includes("oauth-protected-resource")) {
        return Response.json({ resource: `${origin}/mcp`, authorization_servers: [origin] });
      }
      if (url.pathname.includes("oauth-authorization-server")) {
        return Response.json({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      }
      if (url.pathname === "/register") {
        const metadata = z.record(z.string(), z.json()).parse(await request.json());
        return Response.json({ ...metadata, client_id: "fixture-client" }, { status: 201 });
      }
      if (url.pathname === "/authorize") {
        const code = `fixture-code-${codes.size}`;
        codes.set(code, url.searchParams.get("code_challenge")!);
        const callback = new URL(url.searchParams.get("redirect_uri")!);
        callback.searchParams.set("state", url.searchParams.get("state")!);
        callback.searchParams.set("code", code);
        return Response.redirect(callback.href, 302);
      }
      if (url.pathname === "/token") {
        const params = new URLSearchParams(new TextDecoder().decode(await request.arrayBuffer()));
        if (params.get("grant_type") === "refresh_token") {
          fixture.refreshes += 1;
          if (!refreshAllowed || params.get("refresh_token") !== refreshToken) {
            return Response.json({ error: "invalid_grant" }, { status: 400 });
          }
        } else {
          const digest = new Uint8Array(await crypto.subtle.digest(
            "SHA-256", new TextEncoder().encode(params.get("code_verifier")!),
          ));
          const challenge = btoa(String.fromCharCode(...digest))
            .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
          if (codes.get(params.get("code")!) !== challenge) {
            return Response.json({ error: "invalid_grant" }, { status: 400 });
          }
          fixture.exchanges += 1;
          refreshAllowed = true;
        }
        refreshToken = `fixture-refresh-${++issuedTokens}`;
        return Response.json({
          access_token: `fixture-access-${generation}`,
          refresh_token: refreshToken,
          token_type: "Bearer",
        });
      }
      if (url.pathname !== "/mcp" && !(transport === "sse" && url.pathname === "/messages")) {
        return new Response(null, { status: 404 });
      }
      if (request.method === "GET" && transport !== "sse") return new Response(null, { status: 405 });
      if (request.method === "DELETE") return new Response(null, { status: 200 });
      if (fixture.forbidden) return new Response("Forbidden", { status: 403 });
      if (request.headers.get("authorization") !== `Bearer fixture-access-${generation}`) {
        return new Response(null, {
          status: 401,
          headers: { "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` },
        });
      }
      if (request.method === "GET") {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            events = controller;
            controller.enqueue(new TextEncoder().encode("event: endpoint\ndata: /messages\n\n"));
            request.signal.addEventListener("abort", () => {
              if (events === controller) events = undefined;
              controller.close();
            }, { once: true });
          },
          cancel() { events = undefined; },
        });
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      }
      const message = z.object({
        id: z.union([z.number(), z.string()]).optional(), method: z.string(),
      }).parse(await request.json());
      if (message.id === undefined) return new Response(null, { status: 202 });
      let result: InitializeResult | ListToolsResult | ListResourcesResult | ListResourceTemplatesResult | ListPromptsResult | CallToolResult;
      if (message.method === "initialize") {
        result = { protocolVersion: "2025-11-25", capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} }, serverInfo: { name: "fixture", version: "1" } };
      } else if (message.method === "tools/list") {
        result = { tools: [{ name: "operate", inputSchema: { type: "object" } }] };
      } else if (message.method === "resources/list") {
        result = { resources: [] };
      } else if (message.method === "resources/templates/list") {
        result = { resourceTemplates: [] };
      } else if (message.method === "prompts/list") {
        result = { prompts: [] };
      } else if (message.method === "tools/call") {
        fixture.calls += 1;
        result = { content: [{ type: "text", text: fixture.toolError ? "OAuthReconnectRequired" : "ok" }], isError: fixture.toolError };
      } else {
        return Response.json({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
      }
      const reply = { jsonrpc: "2.0", id: message.id, result };
      if (transport === "sse") {
        if (!events) throw new Error("SSE fixture connection missing");
        events.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(reply)}\n\n`));
        return new Response(null, { status: 202 });
      }
      return Response.json(reply, { headers: { "mcp-session-id": "fixture-session" } });
    },
  };
  return fixture;
}
