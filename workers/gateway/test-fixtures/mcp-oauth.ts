import { z } from "zod";

/** An isolated OAuth issuer and MCP resource; all credentials are fixture-only. */
export function createMcpOAuthFixture(origin: string) {
  let generation = 0;
  let refreshAllowed = true;
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
          if (!refreshAllowed) return Response.json({ error: "invalid_grant" }, { status: 400 });
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
        return Response.json({
          access_token: `fixture-access-${generation}`,
          refresh_token: `fixture-refresh-${generation}`,
          token_type: "Bearer",
        });
      }
      if (url.pathname !== "/mcp") return new Response(null, { status: 404 });
      if (request.method === "GET") return new Response(null, { status: 405 });
      if (request.method === "DELETE") return new Response(null, { status: 200 });
      if (fixture.forbidden) return new Response("Forbidden", { status: 403 });
      if (request.headers.get("authorization") !== `Bearer fixture-access-${generation}`) {
        return new Response(null, {
          status: 401,
          headers: { "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` },
        });
      }
      const message = z.object({
        id: z.union([z.number(), z.string()]).optional(), method: z.string(),
      }).parse(await request.json());
      if (message.id === undefined) return new Response(null, { status: 202 });
      let result: unknown;
      if (message.method === "initialize") {
        result = { protocolVersion: "2025-11-25", capabilities: { tools: { listChanged: true } }, serverInfo: { name: "fixture", version: "1" } };
      } else if (message.method === "tools/list") {
        result = { tools: [{ name: "operate", inputSchema: { type: "object" } }] };
      } else if (message.method === "tools/call") {
        fixture.calls += 1;
        result = { content: [{ type: "text", text: fixture.toolError ? "OAuthReconnectRequired" : "ok" }], isError: fixture.toolError };
      } else {
        return Response.json({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
      }
      return Response.json({ jsonrpc: "2.0", id: message.id, result });
    },
  };
  return fixture;
}
