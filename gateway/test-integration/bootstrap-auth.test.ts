import { GSVClient, GsvClientError } from "@humansandmachines/gsv";
import type { GsvRequestArguments } from "@humansandmachines/gsv";
import type {
  ConnectArgs,
  SysSetupArgs,
  SysSetupResult,
  SysTokenCreateResult,
} from "@humansandmachines/gsv/protocol";
import type { TestHarness } from "wrangler";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createGatewayTestHarness, webSocketUrl } from "./harness";
import { SINGLETON_INSTALLATION_ID } from "../src/installation/identity";

const USERNAME = "auth-user";
const PASSWORD = "integration-auth-password";
const ROOT_PASSWORD = "integration-root-password";

describe("gateway authentication integration", () => {
  let harness: TestHarness;
  let baseUrl: URL;
  const clients = new Set<GSVClient>();

  beforeAll(async () => {
    harness = createGatewayTestHarness();
    ({ url: baseUrl } = await harness.listen());
  });

  afterEach(async () => {
    for (const client of clients) {
      client.close();
    }
    clients.clear();
    await harness.reset();
    ({ url: baseUrl } = await harness.listen());
  });

  afterAll(async () => {
    await harness.close();
  });

  it("rejects invalid handshakes before setup", async () => {
    await expect(connectOnce({
      protocol: 1,
      peer: peerInfo("old-protocol"),
    })).rejects.toMatchObject({
      code: 102,
      message: "Unsupported protocol version",
    });

    await expect(connectOnce({
      protocol: 3,
      peer: { ...peerInfo("invalid-peer"), implements: [42] },
    })).rejects.toMatchObject({
      code: 400,
      message: "Invalid sys.connect arguments",
    });
  });

  it("authenticates users with passwords or scoped user tokens", async () => {
    await setup();

    await expect(connectOnce({
      protocol: 3,
      peer: peerInfo("missing-auth"),
    })).rejects.toMatchObject({ code: 401, message: "Authentication required" });

    await expect(connectOnce({
      protocol: 3,
      peer: peerInfo("unknown-user"),
      auth: { username: "nobody", token: "unknown-token" },
    })).rejects.toMatchObject({ code: 401 });

    await expect(connectOnce({
      protocol: 3,
      peer: peerInfo("wrong-token"),
      auth: { username: USERNAME, token: "wrong-token" },
    })).rejects.toMatchObject({ code: 401 });

    const user = createClient({
      username: USERNAME,
      password: PASSWORD,
      peer: peerInfo("password-user"),
    });
    const connected = await user.connect();
    expect(connected.peer).toMatchObject({
      id: "password-user",
      principal: { kind: "human", account: { uid: 1000, username: USERNAME } },
    });
    expect(connected.peer.grant.calls).toContain("proc.*");

    const issued = await user.call<SysTokenCreateResult>("sys.token.create", {
      kind: "user",
      label: "integration user token",
    });
    expect(issued.token).toMatchObject({
      uid: 1000,
      kind: "user",
      allowedRole: "user",
      allowedDeviceId: null,
    });

    const tokenUser = createClient({
      username: USERNAME,
      token: issued.token.token,
      peer: peerInfo("token-user"),
    });
    await expect(tokenUser.connect()).resolves.toMatchObject({
      protocol: 3,
      peer: { principal: { kind: "human", account: { uid: 1000 } } },
    });

    await expect(connectOnce({
      protocol: 3,
      peer: peerInfo("ambiguous-auth"),
      auth: {
        username: USERNAME,
        password: PASSWORD,
        token: issued.token.token,
      },
    })).rejects.toMatchObject({
      code: 401,
      message: "Provide either password or token",
    });
  });

  it("infers machine authority from a device-bound token and registers its implementations", async () => {
    const setupResult = await setup({
      node: { deviceId: "integration-device", label: "Integration device" },
    });
    if (!setupResult.nodeToken) {
      throw new Error("sys.setup returned no node token");
    }

    await expect(connectOnce({
      protocol: 3,
      peer: peerInfo("integration-device"),
      auth: { username: USERNAME, token: setupResult.nodeToken.token },
    })).rejects.toMatchObject({
      code: 103,
      message: "Machine peers require an implements list",
    });

    await expect(connectOnce({
      protocol: 3,
      peer: peerInfo("integration-device", ["not valid!"]),
      auth: { username: USERNAME, token: setupResult.nodeToken.token },
    })).rejects.toMatchObject({ code: 103, message: expect.stringContaining("Invalid implements") });

    await expect(connectOnce({
      protocol: 3,
      peer: peerInfo("other-device", ["fs.*"]),
      auth: { username: USERNAME, token: setupResult.nodeToken.token },
    })).rejects.toMatchObject({ code: 401 });

    const humanEndpoint = createClient({
      username: USERNAME,
      password: PASSWORD,
      peer: peerInfo("browser-endpoint", ["fs.read"]),
    });
    await expect(humanEndpoint.connect()).resolves.toMatchObject({
      peer: {
        principal: { kind: "human" },
        grant: { implements: ["fs.read"] },
      },
    });

    const driver = createClient({
      username: USERNAME,
      token: setupResult.nodeToken.token,
      peer: peerInfo("integration-device", ["fs.*", "shell.exec"]),
    });
    const connected = await driver.connect();
    expect(connected).toMatchObject({
      peer: {
        id: "integration-device",
        principal: { kind: "machine", account: { uid: 1000, username: USERNAME } },
        grant: {
          calls: [],
          implements: ["fs.*", "shell.exec"],
          signals: expect.arrayContaining(["device.status", "peer.pong"]),
        },
      },
    });

    const user = createClient({
      username: USERNAME,
      password: PASSWORD,
      peer: peerInfo("device-observer"),
    });
    await user.connect();
    expect((await user.call("sys.device.list", {})).devices).toContainEqual(
      expect.objectContaining({
        deviceId: "integration-device",
        ownerUid: 1000,
        online: true,
        implements: ["fs.*", "shell.exec"],
      }),
    );
  });

  it("infers service authority from a root-issued service token", async () => {
    await setup();
    const root = createClient({
      username: "root",
      password: ROOT_PASSWORD,
      peer: peerInfo("root-token-issuer"),
    });
    await root.connect();
    const issued = await root.call<SysTokenCreateResult>("sys.token.create", {
      kind: "service",
      label: "integration service",
    });
    expect(issued.token).toMatchObject({
      uid: 0,
      kind: "service",
      allowedRole: "service",
    });

    const service = createClient({
      username: "root",
      token: issued.token.token,
      peer: peerInfo("integration-service"),
    });
    const connected = await service.connect();
    expect(connected).toMatchObject({
      peer: {
        id: "integration-service",
        principal: { kind: "service" },
        grant: { calls: ["adapter.*"], signals: [], implements: [] },
      },
    });
  });

  it("recovers credentials, configuration, and process records after Kernel eviction", async () => {
    await setup();
    const user = createClient({
      username: USERNAME,
      password: PASSWORD,
      peer: peerInfo("pre-eviction-user"),
    });
    await user.connect();
    const issued = await user.call<SysTokenCreateResult>("sys.token.create", {
      kind: "user",
      label: "survives Kernel eviction",
    });
    const spawned = await user.proc.spawn({
      label: "durable process record",
      interactive: true,
    });
    if (!spawned.ok) {
      throw new Error(spawned.error);
    }

    const root = createClient({
      username: "root",
      password: ROOT_PASSWORD,
      peer: peerInfo("pre-eviction-root"),
    });
    await root.connect();
    await root.call("sys.config.set", {
      key: "config/test/kernel_eviction",
      value: "persisted",
    });

    user.close();
    root.close();
    await harness.getWorker("gsv").evictDurableObject("KERNEL", {
      name: SINGLETON_INSTALLATION_ID,
      webSockets: "close",
    });

    const reconnectedUser = createClient({
      username: USERNAME,
      token: issued.token.token,
      peer: peerInfo("post-eviction-user"),
    });
    await reconnectedUser.connect();
    expect((await reconnectedUser.proc.list()).processes).toContainEqual(
      expect.objectContaining({
        pid: spawned.pid,
        label: "durable process record",
      }),
    );

    const reconnectedRoot = createClient({
      username: "root",
      password: ROOT_PASSWORD,
      peer: peerInfo("post-eviction-root"),
    });
    await reconnectedRoot.connect();
    expect(await reconnectedRoot.call("sys.config.get", {
      key: "config/test/kernel_eviction",
    })).toEqual({
      entries: [{ key: "config/test/kernel_eviction", value: "persisted" }],
    });
    expect((await reconnectedRoot.call("sys.token.list", { uid: 1000 })).tokens)
      .toContainEqual(expect.objectContaining({
        tokenId: issued.token.tokenId,
        uid: 1000,
        revokedAt: null,
      }));
  });

  it("keeps an authenticated socket usable across Kernel hibernation", async () => {
    await setup();
    const user = createClient({
      username: USERNAME,
      password: PASSWORD,
      peer: peerInfo("hibernating-user"),
    });
    await user.connect();
    const before = await user.proc.list();

    await harness.getWorker("gsv").evictDurableObject("KERNEL", {
      name: SINGLETON_INSTALLATION_ID,
      webSockets: "hibernate",
    });

    await expect(user.proc.list()).resolves.toEqual(before);
  });

  function createClient(options: ConstructorParameters<typeof GSVClient>[0]): GSVClient {
    const client = new GSVClient({
      url: webSocketUrl(baseUrl),
      ...options,
    });
    clients.add(client);
    return client;
  }

  function connectOnce(args: GsvRequestArguments): Promise<never> {
    const client = new GSVClient();
    const call: string = "sys.connect";
    return client.requestOnce(webSocketUrl(baseUrl), call, args)
      .then(() => {
        throw new Error("expected connection to fail");
      })
      .catch((error: Error) => {
        expect(error).toBeInstanceOf(GsvClientError);
        throw error;
      });
  }

  async function setup(overrides: Partial<SysSetupArgs> = {}): Promise<SysSetupResult> {
    const client = new GSVClient();
    return await client.requestOnce(webSocketUrl(baseUrl), "sys.setup", {
      username: USERNAME,
      password: PASSWORD,
      rootPassword: ROOT_PASSWORD,
      agentName: "auth-agent",
      timezone: "Europe/Amsterdam",
      ...overrides,
    });
  }
});

function peerInfo(id: string, implementsList: string[] = []): ConnectArgs["peer"] {
  return {
    id,
    version: "1.0.0",
    platform: "test",
    implements: implementsList,
  };
}
