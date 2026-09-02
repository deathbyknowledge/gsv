import {
  bodyFromText,
  bodyToText,
  GSVClient,
  GsvClientError,
} from "@humansandmachines/gsv";
import type { TestHarness } from "wrangler";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createGatewayTestHarness, webSocketUrl } from "./harness";

const USERNAME = "harness-user";
const PASSWORD = "integration-test-password";

describe("gateway integration", () => {
  let harness: TestHarness;
  let baseUrl: URL;

  beforeAll(async () => {
    harness = createGatewayTestHarness();
  });

  beforeEach(async () => {
    ({ url: baseUrl } = await harness.listen());
  });

  afterEach(async () => {
    await harness.reset();
  });

  afterAll(async () => {
    await harness.close();
  });

  it("routes Worker-owned HTTP endpoints ahead of the production SPA", async () => {
    const health = await harness.fetch("/health");
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({ status: "healthy" });

    const metadata = await harness.fetch("/.well-known/oauth-client/gsv.json");
    expect(metadata.status).toBe(200);
    expect(metadata.headers.get("cache-control")).toBe("no-store");
    expect(metadata.headers.get("access-control-allow-origin")).toBe("*");
    await expect(metadata.json()).resolves.toMatchObject({
      client_id: `${baseUrl.origin}/.well-known/oauth-client/gsv.json`,
      redirect_uris: [`${baseUrl.origin}/oauth/callback`],
      code_challenge_methods_supported: ["S256"],
    });
  });

  it("serves the production SPA and leaves removed public assets missing", async () => {
    const root = await harness.fetch("/");
    expect(root.status).toBe(200);
    expect(root.headers.get("content-type")).toContain("text/html");
    expect(await root.text()).toContain("<div id=\"app\"></div>");

    const removedCliAsset = await harness.fetch("/public/gsv/downloads/cli/install.sh");
    expect(removedCliAsset.status).toBe(404);
    await expect(removedCliAsset.text()).resolves.toBe("Not Found");
  });

  it("runs setup, authentication, process lifecycle, and adapter RPC through real boundaries", async () => {
    const wsUrl = webSocketUrl(baseUrl);
    const oneShot = new GSVClient();
    const connectArgs = {
      protocol: 3 as const,
      peer: {
        id: "gateway-integration",
        version: "1.0.0",
        platform: "node",
      },
      auth: { username: USERNAME, password: PASSWORD },
    };

    const setupRequired = oneShot.requestOnce(wsUrl, "sys.connect", connectArgs);
    await expect(setupRequired).rejects.toBeInstanceOf(GsvClientError);
    await expect(setupRequired).rejects.toMatchObject({
      code: 425,
      message: "Setup required",
      details: { setupMode: true, next: "sys.setup" },
    });

    const setup = await oneShot.requestOnce(wsUrl, "sys.setup", {
      username: USERNAME,
      password: PASSWORD,
      agentName: "harness-agent",
      timezone: "Europe/Amsterdam",
    });
    expect(setup.user).toMatchObject({
      username: USERNAME,
      uid: 1000,
      home: `/home/${USERNAME}`,
      cwd: `/home/${USERNAME}`,
    });
    expect(setup.bootstrap).toMatchObject({
      repo: "root/gsv-manual",
      ref: "main",
      changed: true,
    });

    await expect(oneShot.requestOnce(wsUrl, "proc.list", {})).rejects.toMatchObject({
      code: 403,
      message: "Must call sys.connect first",
    });
    await expect(oneShot.requestOnce(wsUrl, "sys.setup", {
      username: "second-user",
      password: PASSWORD,
    })).rejects.toMatchObject({
      code: 409,
      message: "System already initialized",
    });
    await expect(oneShot.requestOnce(wsUrl, "sys.connect", {
      ...connectArgs,
      auth: { username: USERNAME, password: "wrong-password" },
    })).rejects.toMatchObject({ code: 401 });

    const client = new GSVClient({
      url: wsUrl,
      username: USERNAME,
      password: PASSWORD,
      peer: connectArgs.peer,
    });

    try {
      const connected = await client.connect();
      expect(connected.peer).toMatchObject({
        principal: {
          kind: "human",
          account: { username: USERNAME, uid: 1000 },
        },
      });
      expect(connected.peer.grant.calls).toContain("proc.*");

      const aiModels = await client.sys.config.get({ key: "config/ai/models" });
      expect(aiModels.entries).toHaveLength(1);
      expect(JSON.parse(aiModels.entries[0]!.value)).toMatchObject({
        version: 1,
        models: [
          { provider: "workers-ai", model: expect.any(String) },
          { provider: "workers-ai", model: expect.any(String) },
        ],
      });

      expect((await client.account.list()).accounts).toEqual(expect.arrayContaining([
        expect.objectContaining({
          uid: 1000,
          username: USERNAME,
          relation: "self",
        }),
        expect.objectContaining({
          uid: 1001,
          username: "harness-agent",
          displayName: "Harness Agent",
          relation: "personal-agent",
          runnable: true,
        }),
      ]));

      const written = await client.fs.write({
        path: "/tmp/integration-roundtrip.txt",
        content: "hello through the gateway",
      });
      expect(written).toEqual({
        ok: true,
        path: "/tmp/integration-roundtrip.txt",
        size: 25,
      });
      const read = await client.request("fs.read", { path: "/tmp/integration-roundtrip.txt" });
      expect(read.data).toMatchObject({
        ok: true,
        path: "/tmp/integration-roundtrip.txt",
        kind: "text",
        contentType: "text/plain",
        size: 25,
      });
      if (!read.body) {
        throw new Error("fs.read returned no body");
      }
      await expect(bodyToText(read.body)).resolves.toBe("hello through the gateway");

      const uploadContent = "streamed through websocket frames";
      const received = await client.request("fs.transfer.receive", {
        path: "/tmp/integration-upload.txt",
        contentType: "text/plain",
      }, {
        body: bodyFromText(uploadContent),
      });
      expect(received.data).toEqual({
        ok: true,
        path: "/tmp/integration-upload.txt",
        bytesWritten: new TextEncoder().encode(uploadContent).byteLength,
        contentType: "text/plain",
      });
      const sent = await client.request("fs.transfer.send", {
        path: "/tmp/integration-upload.txt",
      });
      expect(sent.data).toMatchObject({
        ok: true,
        path: "/tmp/integration-upload.txt",
        size: new TextEncoder().encode(uploadContent).byteLength,
        contentType: "text/plain",
      });
      if (!sent.body) {
        throw new Error("fs.transfer.send returned no body");
      }
      await expect(bodyToText(sent.body)).resolves.toBe(uploadContent);

      const beforeSpawn = await client.proc.list();
      const spawned = await client.proc.spawn({
        label: "integration child",
        interactive: true,
      });
      if (!spawned.ok) {
        throw new Error(spawned.error);
      }
      expect(spawned.cwd).toBe("/home/harness-agent");

      const afterSpawn = await client.proc.list();
      expect(afterSpawn.processes).toHaveLength(beforeSpawn.processes.length + 1);
      expect(afterSpawn.processes).toContainEqual(expect.objectContaining({
        pid: spawned.pid,
        username: "harness-agent",
        label: "integration child",
        interactive: true,
        cwd: "/home/harness-agent",
      }));

      const history = await client.proc.history({ pid: spawned.pid });
      expect(history).toMatchObject({
        ok: true,
        pid: spawned.pid,
        messages: [],
        messageCount: 0,
      });

      const reset = await client.proc.reset({ pid: spawned.pid });
      expect(reset).toEqual({
        ok: true,
        pid: spawned.pid,
        archivedMessages: 0,
        archives: [],
      });
      expect((await client.proc.list()).processes.some(({ pid }) => pid === spawned.pid)).toBe(true);

      const killed = await client.proc.kill({ pid: spawned.pid, archive: false });
      expect(killed).toMatchObject({ ok: true, pid: spawned.pid, archivedMessages: 0 });
      expect((await client.proc.list()).processes.some(({ pid }) => pid === spawned.pid)).toBe(false);

      const adapters = await client.adapter.list();
      expect(adapters.adapters).toEqual(expect.arrayContaining([
        expect.objectContaining({
          adapter: "discord",
          available: true,
          supportsConnect: true,
          supportsDisconnect: true,
          supportsStatus: true,
        }),
        expect.objectContaining({ adapter: "telegram", available: true }),
      ]));

      const adapterConnected = await client.adapter.connect({
        adapter: "discord",
        accountId: "integration",
        config: { token: "fixture-only" },
      });
      expect(adapterConnected).toMatchObject({
        ok: true,
        adapter: "discord",
        accountId: "integration",
        connected: true,
        authenticated: true,
        message: "connected by integration fixture",
      });
      expect(await client.adapter.status({ adapter: "discord", accountId: "integration" }))
        .toMatchObject({
          adapter: "discord",
          accounts: [expect.objectContaining({
            accountId: "integration",
            connected: true,
            authenticated: true,
          })],
        });

      const adapterDisconnected = await client.adapter.disconnect({
        adapter: "discord",
        accountId: "integration",
      });
      expect(adapterDisconnected).toMatchObject({
        ok: true,
        adapter: "discord",
        accountId: "integration",
        message: "disconnected by integration fixture",
      });
      expect(await client.adapter.status({ adapter: "discord", accountId: "integration" }))
        .toMatchObject({
          accounts: [expect.objectContaining({
            accountId: "integration",
            connected: false,
            authenticated: false,
          })],
        });
    } finally {
      client.close();
    }
  });
});
