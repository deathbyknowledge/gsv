import { GSVClient, GsvClientError } from "@humansandmachines/gsv";
import type {
  ConnectArgs,
  SysSetupArgs,
  SysSetupResult,
  SysTokenCreateResult,
} from "@humansandmachines/gsv/protocol";
import type { TestHarness } from "wrangler";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createGatewayTestHarness, webSocketUrl } from "./harness";

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
      client: clientInfo("user", "old-protocol"),
    })).rejects.toMatchObject({
      code: 102,
      message: "Unsupported protocol version",
    });

    await expect(connectOnce({
      protocol: 2,
      client: {
        ...clientInfo("user", "invalid-role"),
        role: "invalid" as ConnectArgs["client"]["role"],
      },
    })).rejects.toMatchObject({
      code: 103,
      message: "Invalid client role",
    });
  });

  it("authenticates users with passwords or scoped user tokens", async () => {
    await setup();

    await expect(connectOnce({
      protocol: 2,
      client: clientInfo("user", "missing-auth"),
    })).rejects.toMatchObject({ code: 401, message: "Authentication required" });

    await expect(connectOnce({
      protocol: 2,
      client: clientInfo("user", "unknown-user"),
      auth: { username: "nobody", token: "unknown-token" },
    })).rejects.toMatchObject({ code: 401 });

    await expect(connectOnce({
      protocol: 2,
      client: clientInfo("user", "wrong-token"),
      auth: { username: USERNAME, token: "wrong-token" },
    })).rejects.toMatchObject({ code: 401 });

    const user = createClient({
      username: USERNAME,
      password: PASSWORD,
      client: clientInfo("user", "password-user"),
    });
    const connected = await user.connect();
    expect(connected.identity).toMatchObject({
      role: "user",
      process: { uid: 1000, username: USERNAME },
    });
    expect(connected.identity.capabilities).toContain("proc.*");

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
      client: clientInfo("user", "token-user"),
    });
    await expect(tokenUser.connect()).resolves.toMatchObject({
      protocol: 2,
      identity: { role: "user", process: { uid: 1000 } },
    });

    await expect(connectOnce({
      protocol: 2,
      client: clientInfo("user", "ambiguous-auth"),
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

  it("requires a device-bound token and registers a capability-free driver", async () => {
    const setupResult = await setup({
      node: { deviceId: "integration-device", label: "Integration device" },
    });
    if (!setupResult.nodeToken) {
      throw new Error("sys.setup returned no node token");
    }

    await expect(connectOnce({
      protocol: 2,
      client: clientInfo("driver", "integration-device"),
      auth: { username: USERNAME, token: setupResult.nodeToken.token },
    })).rejects.toMatchObject({
      code: 103,
      message: "Driver role requires implements list",
    });

    await expect(connectOnce({
      protocol: 2,
      client: clientInfo("driver", "integration-device"),
      driver: { implements: ["not valid!"] },
      auth: { username: USERNAME, token: setupResult.nodeToken.token },
    })).rejects.toMatchObject({ code: 103, message: expect.stringContaining("Invalid implements") });

    await expect(connectOnce({
      protocol: 2,
      client: clientInfo("driver", "other-device"),
      driver: { implements: ["fs.*"] },
      auth: { username: USERNAME, token: setupResult.nodeToken.token },
    })).rejects.toMatchObject({ code: 401 });

    await expect(connectOnce({
      protocol: 2,
      client: clientInfo("driver", "integration-device"),
      driver: { implements: ["fs.*"] },
      auth: { username: USERNAME, password: PASSWORD },
    })).rejects.toMatchObject({
      code: 401,
      message: "Token required for machine connections",
    });

    const root = createClient({
      username: "root",
      password: ROOT_PASSWORD,
      client: clientInfo("user", "machine-auth-configurator"),
    });
    await root.connect();
    await root.call("sys.config.set", {
      key: "config/auth/allow_machine_password",
      value: "true",
    });
    await expect(connectOnce({
      protocol: 2,
      client: clientInfo("driver", "integration-device"),
      driver: { implements: ["fs.*"] },
      auth: { username: USERNAME, password: PASSWORD },
    })).rejects.toMatchObject({
      code: 401,
      message: "Token required for machine connections",
    });

    const driver = createClient({
      username: USERNAME,
      token: setupResult.nodeToken.token,
      client: clientInfo("driver", "integration-device"),
      driver: { implements: ["fs.*", "shell.exec"] },
    });
    const connected = await driver.connect();
    expect(connected).toMatchObject({
      identity: {
        role: "driver",
        process: { uid: 1000, username: USERNAME },
        device: "integration-device",
        implements: ["fs.*", "shell.exec"],
        capabilities: [],
      },
      syscalls: [],
      signals: expect.arrayContaining(["device.status", "device.pong"]),
    });

    const user = createClient({
      username: USERNAME,
      password: PASSWORD,
      client: clientInfo("user", "device-observer"),
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

  it("requires a root-issued service token and channel", async () => {
    await setup();
    const root = createClient({
      username: "root",
      password: ROOT_PASSWORD,
      client: clientInfo("user", "root-token-issuer"),
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

    await expect(connectOnce({
      protocol: 2,
      client: clientInfo("service", "service-without-channel"),
      auth: { username: "root", token: issued.token.token },
    })).rejects.toMatchObject({
      code: 103,
      message: "Service role requires channel field",
    });

    const service = createClient({
      username: "root",
      token: issued.token.token,
      client: {
        ...clientInfo("service", "integration-service"),
        channel: "integration",
      },
    });
    const connected = await service.connect();
    expect(connected).toMatchObject({
      identity: {
        role: "service",
        channel: "integration",
        capabilities: ["adapter.*"],
      },
      syscalls: ["adapter.*"],
      signals: [],
    });
  });

  it("recovers credentials, configuration, and process records after Kernel eviction", async () => {
    await setup();
    const user = createClient({
      username: USERNAME,
      password: PASSWORD,
      client: clientInfo("user", "pre-eviction-user"),
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
      client: clientInfo("user", "pre-eviction-root"),
    });
    await root.connect();
    await root.call("sys.config.set", {
      key: "config/test/kernel_eviction",
      value: "persisted",
    });

    user.close();
    root.close();
    await harness.getWorker("gsv").evictDurableObject("KERNEL", {
      name: "singleton",
      webSockets: "close",
    });

    const reconnectedUser = createClient({
      username: USERNAME,
      token: issued.token.token,
      client: clientInfo("user", "post-eviction-user"),
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
      client: clientInfo("user", "post-eviction-root"),
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

  function createClient(options: ConstructorParameters<typeof GSVClient>[0]): GSVClient {
    const client = new GSVClient({
      url: webSocketUrl(baseUrl),
      ...options,
    });
    clients.add(client);
    return client;
  }

  function connectOnce(args: ConnectArgs): Promise<unknown> {
    const client = new GSVClient();
    return client.requestOnce(webSocketUrl(baseUrl), "sys.connect", args)
      .catch((error: unknown) => {
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

function clientInfo(
  role: ConnectArgs["client"]["role"],
  id: string,
): ConnectArgs["client"] {
  return {
    id,
    version: "1.0.0",
    platform: role === "service" ? "worker" : "node",
    role,
  };
}
