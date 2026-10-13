import { createServer, type Server } from "node:http";
import { GSVClient } from "@humansandmachines/gsv";
import type { TestHarness } from "wrangler";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createMcpOAuthFixture } from "../test-fixtures/mcp-oauth";
import { createGatewayTestHarness, webSocketUrl } from "./harness";

let harness: TestHarness;
let server: Server;
let origin: string;
let fixture: ReturnType<typeof createMcpOAuthFixture>;

beforeAll(async () => {
  server = createServer(async (incoming, outgoing) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      const result = await fixture.fetch(new Request(`${origin}${incoming.url}`, {
        method: incoming.method,
        headers,
        body: chunks.length ? Buffer.concat(chunks).toString("utf8") : undefined,
      }));
      outgoing.writeHead(result.status, Object.fromEntries(result.headers));
      outgoing.end(Buffer.from(await result.arrayBuffer()));
    } catch (error) {
      outgoing.writeHead(500).end(String(error));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture address missing");
  origin = `http://127.0.0.1:${address.port}`;
  fixture = createMcpOAuthFixture(origin);
  harness = createGatewayTestHarness();
});

afterAll(async () => {
  await harness?.close();
  server?.closeAllConnections();
  if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

it("recovers OAuth discovery and tool calls on the same server in a clean installation", async () => {
  const { url } = await harness.listen();
  const username = "mcp-owner";
  const password = "integration-test-password";
  await new GSVClient().requestOnce(webSocketUrl(url), "sys.setup", {
    onboardingToken: "integration-onboarding-default", username, password,
  });
  const client = new GSVClient({ url: webSocketUrl(url), username, password });
  try {
    await client.connect();
    const { server: added } = await client.sys.mcp.add({ name: "fixture", url: `${origin}/mcp` });
    expect(added.state).toBe("authenticating");
    const serverId = added.serverId;

    async function signIn(authUrl: string | null) {
      if (!authUrl) throw new Error("sign-in URL missing");
      const authorization = await fetch(authUrl, { redirect: "manual" });
      expect(authorization.status).toBe(302);
      const callback = new URL(authorization.headers.get("location")!);
      const response = await harness.fetch(callback.href);
      expect(response.status, await response.text()).toBe(200);
      await vi.waitFor(async () => {
        const { servers } = await client.sys.mcp.list({});
        expect(servers).toHaveLength(1);
        expect(servers[0]).toMatchObject({ serverId, state: "ready", authUrl: null, error: null });
      });
    }

    await signIn(added.authUrl);
    fixture.expire(true);
    expect((await client.sys.mcp.refresh({ serverId })).server?.state).toBe("ready");
    expect(fixture.refreshes).toBe(1);

    fixture.expire();
    const { server: expired } = await client.sys.mcp.refresh({ serverId });
    expect(expired).toMatchObject({ serverId, state: "authenticating", error: null });
    expect((await client.sys.mcp.refresh({ serverId })).server?.authUrl).toBe(expired?.authUrl);
    await signIn(expired!.authUrl);

    fixture.expire();
    await expect(client.sys.mcp.call({ serverId, name: "operate" })).rejects.toThrow("Unauthorized");
    const { servers } = await client.sys.mcp.list({});
    expect(servers[0]).toMatchObject({ serverId, state: "authenticating", error: null });
    await signIn(servers[0].authUrl);
    expect(fixture.calls).toBe(0);
    await expect(client.sys.mcp.call({ serverId, name: "operate" })).resolves.toMatchObject({ isError: false });
    expect(fixture.calls).toBe(1);
    expect(fixture.exchanges).toBe(3);
  } finally {
    client.close();
  }
});
