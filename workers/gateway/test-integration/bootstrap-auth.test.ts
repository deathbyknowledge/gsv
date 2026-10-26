import { GSVClient, GsvClientError } from "@humansandmachines/gsv";
import type { GsvRequestArguments, GsvWebSocketConstructor } from "@humansandmachines/gsv";
import type {
  ConnectArgs,
  SysSetupArgs,
  SysSetupResult,
  SysTokenCreateResult,
} from "@humansandmachines/gsv/protocol";
import { createPairingCredential, createPairingSecret, decodeDevicePairingCode } from "@humansandmachines/gsv/protocol";
import type { TestHarness } from "wrangler";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createGatewayTestHarness, webSocketUrl } from "./harness";
const INTEGRATION_INSTALLATION_ID = "inst_integration_default";

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

  it("rejects invalid handshakes for an active installation", async () => {
    await setup();
    await expect(connectOnce({
      protocol: 1,
      peer: peerInfo("old-protocol"),
    })).rejects.toMatchObject({
      code: 102,
      message: expect.stringContaining("requires protocol 4"),
      details: { requestedProtocol: 1, supportedProtocol: 4 },
    });

    await expect(connectOnce({
      protocol: 4,
      peer: { ...peerInfo("invalid-peer"), implements: [42] },
    })).rejects.toMatchObject({
      code: 400,
      message: "Invalid sys.connect arguments",
    });
  });

  it("authenticates users with passwords or scoped user tokens", async () => {
    await setup();

    const retiredClient = new GSVClient();
    await expect(retiredClient.requestOnce(webSocketUrl(baseUrl), "account.passkey.authenticate.begin", { username: USERNAME }))
      .rejects.toMatchObject({ code: 400, message: "Invalid account.passkey.authenticate.begin arguments" });

    await expect(connectOnce({
      protocol: 4,
      peer: peerInfo("missing-auth"),
    })).rejects.toMatchObject({ code: 401, message: "Authentication required" });

    await expect(connectOnce({
      protocol: 4,
      peer: peerInfo("unknown-user"),
      auth: { username: "nobody", token: "unknown-token" },
    })).rejects.toMatchObject({ code: 401 });

    await expect(connectOnce({
      protocol: 4,
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

    await expect(user.call("account.passkey.register.begin", { label: "retired" }))
      .rejects.toMatchObject({ code: 400, message: "Invalid account.passkey.register.begin arguments" });

    const issued = await user.call<SysTokenCreateResult>("sys.token.create", {
      kind: "human",
      label: "integration user token",
    });
    expect(issued.token).toMatchObject({
      uid: 1000,
      kind: "human",
      peerId: null,
    });

    const tokenUser = createClient({
      username: USERNAME,
      token: issued.token.token,
      peer: peerInfo("token-user"),
    });
    await expect(tokenUser.connect()).resolves.toMatchObject({
      protocol: 4,
      peer: { principal: { kind: "human", account: { uid: 1000 } } },
    });

    await expect(connectOnce({
      protocol: 4,
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

  it("waits after repeated wrong passwords from one address, refusing even the right one there, while other addresses, signed-in sessions and tokens keep working", async () => {
    await setup();
    const signedIn = createClient({ username: USERNAME, password: PASSWORD, peer: peerInfo("signed-in-before") });
    await signedIn.connect();
    const issued = await signedIn.call<SysTokenCreateResult>("sys.token.create", { kind: "human", label: "pacing token" });

    const answers: unknown[] = [];
    for (let attempt = 0; attempt < 8; attempt++) {
      answers.push(await connectOnce({
        protocol: 4,
        peer: peerInfo(`wrong-${attempt}`),
        auth: { username: USERNAME, password: `wrong-${attempt}` },
      }).catch((error: GsvClientError) => ({ code: error.code, message: error.message })));
    }
    const waiting = { code: 429, message: "Too many sign-in attempts. Try again in 1 minute." };
    expect(answers).toEqual([
      ...Array(5).fill({ code: 401, message: "Authentication failed" }),
      ...Array(3).fill(waiting),
    ]);
    await expect(connectOnce({
      protocol: 4,
      peer: peerInfo("right-while-waiting"),
      auth: { username: USERNAME, password: PASSWORD },
    })).rejects.toMatchObject({ ...waiting, details: { retryAfterMs: expect.any(Number) } });

    await expect(signedIn.proc.list()).resolves.toBeDefined();
    const tokenUser = createClient({ username: USERNAME, token: issued.token.token, peer: peerInfo("token-while-waiting") });
    await expect(tokenUser.connect()).resolves.toMatchObject({ peer: { principal: { kind: "human", account: { uid: 1000 } } } });
    const elsewhere = createClient({ username: USERNAME, password: PASSWORD, peer: peerInfo("right-from-elsewhere"), WebSocket: socketFrom("198.51.100.20") });
    await expect(elsewhere.connect()).resolves.toMatchObject({ peer: { principal: { kind: "human", account: { uid: 1000 } } } });
  });

  it("gives one address twenty wrong passwords an hour across the Ship's accounts, counting an IPv6 /64 as one address", async () => {
    await setup();
    const tries = [...Array<string>(4).fill(USERNAME), ...Array<string>(4).fill("root"), ...Array<string>(12).fill("nobody")];
    for (const [attempt, username] of tries.entries()) {
      await expect(connectOnce({
        protocol: 4,
        peer: peerInfo(`address-${attempt}`),
        auth: { username, password: `wrong-${attempt}` },
      }, attempt % 2 === 0 ? "2001:db8:1:2::a" : "2001:db8:1:2::b")).rejects.toMatchObject({ code: 401 });
    }
    await expect(connectOnce({
      protocol: 4,
      peer: peerInfo("address-right"),
      auth: { username: USERNAME, password: PASSWORD },
    }, "2001:db8:1:2::c")).rejects.toMatchObject({ code: 429, message: expect.stringContaining("Too many sign-in attempts") });
    const otherNetwork = createClient({ username: USERNAME, password: PASSWORD, peer: peerInfo("other-network"), WebSocket: socketFrom("2001:db8:1:3::a") });
    await expect(otherNetwork.connect()).resolves.toMatchObject({ peer: { principal: { kind: "human", account: { uid: 1000 } } } });
  });

  it("enrolls an exact device through a resumable invitation without exposing a human credential", async () => {
    await setup();
    const user = createClient({ username: USERNAME, password: PASSWORD, peer: peerInfo("pairing-human") });
    await user.connect();
    const invitation = { id: crypto.randomUUID(), secret: createPairingSecret(), label: "My macbook", targetId: "my-macbook" };
    const invalid = { ...invitation, targetId: "gsv" };
    await expect(user.sys.pair.create(invalid)).rejects.toMatchObject({ code: 400, details: { pairingCreate: "rejected" } });
    const pending = await user.sys.pair.create(invitation);
    expect(await user.sys.pair.create(invitation)).toEqual(pending);
    expect((await user.sys.token.list({})).tokens).toHaveLength(0);
    const ledger = await user.sys.ledger.list({ limit: 50 });
    expect(JSON.stringify(ledger)).not.toContain(invitation.secret);

    const credential = createPairingCredential();
    const redemption = { id: invitation.id, secret: invitation.secret, credential };
    const oneShot = new GSVClient();
    const receipt = await oneShot.requestOnce(webSocketUrl(baseUrl), "sys.pair.redeem", redemption);
    await harness.getWorker("gsv").evictDurableObject("KERNEL", { name: INTEGRATION_INSTALLATION_ID, webSockets: "hibernate" });
    expect(await oneShot.requestOnce(webSocketUrl(baseUrl), "sys.pair.redeem", redemption)).toEqual(receipt);
    await expect(oneShot.requestOnce(webSocketUrl(baseUrl), "sys.pair.redeem", { ...redemption, credential: createPairingCredential() })).rejects.toMatchObject({ details: { pairing: "used" } });
    expect((await user.sys.pair.cancel({ id: invitation.id })).pairing.state).toBe("paired");
    expect((await user.sys.token.list({})).tokens).toHaveLength(1);
    await expect(connectOnce({ protocol: 4, peer: peerInfo("wrong-device", ["fs.*"]), auth: { username: USERNAME, token: credential } })).rejects.toMatchObject({ code: 401 });
    const machine = createClient({ username: USERNAME, token: credential, peer: peerInfo("my-macbook", ["fs.*"]) });
    expect((await machine.connect()).peer.principal.kind).toBe("machine");
    expect((await user.sys.target.list({})).targets).toContainEqual(expect.objectContaining({ targetId: "my-macbook", label: "My macbook", online: true }));
    await expect(machine.sys.pair.create({ ...invitation, id: crypto.randomUUID(), targetId: "another" })).rejects.toBeInstanceOf(GsvClientError);
    await user.sys.target.update({ targetId: "my-macbook", label: "Edited name" });
    machine.close();
    const reconnect = createClient({ username: USERNAME, token: credential, peer: peerInfo("my-macbook", ["fs.*"]) });
    await reconnect.connect();
    expect((await user.sys.target.list({})).targets).toContainEqual(expect.objectContaining({ targetId: "my-macbook", label: "Edited name" }));
    await user.sys.target.delete({ targetId: "my-macbook" });
    await expect(connectOnce({ protocol: 4, peer: peerInfo("my-macbook", ["fs.*"]), auth: { username: USERNAME, token: credential } })).rejects.toMatchObject({ code: 401 });
  });

  it("redeems a native-shell invitation and exposes the connected browser target", async () => {
    const origin = new URL(baseUrl);
    origin.hostname = "localhost";
    expect((await harness.getWorker("gsv-test-dependencies").fetch("http://gsv-test-dependencies/__test/default-origin", { method: "POST", body: origin.origin })).status).toBe(204);
    await setup();
    const user = createClient({ username: USERNAME, password: PASSWORD, peer: peerInfo("pairing-shell") });
    await user.connect();
    const created = await user.shell.exec({ target: "gsv", input: "targets pair --name 'My browser' --platform browser" });
    if (created.status === "running") throw new Error("Native pairing did not finish");
    expect(created.exitCode, created.stderr).toBe(0);
    const { code, extensionUrl } = JSON.parse(created.stdout ?? "");
    expect(extensionUrl).toBe("https://ship.space/browser?release=dev");
    const invite = decodeDevicePairingCode(code);
    expect(invite).toMatchObject({ username: USERNAME, targetId: "my-browser", label: "My browser" });
    const credential = createPairingCredential();
    await new GSVClient().requestOnce(invite.gatewayUrl, "sys.pair.redeem", { id: invite.id, secret: invite.secret, credential });
    const browser = createClient({ username: USERNAME, token: credential, peer: { ...peerInfo(invite.targetId, ["shell.exec"]), platform: "browser" } });
    await browser.connect();
    const shown = await user.shell.exec({ target: "gsv", input: "targets show my-browser --json" });
    if (shown.status === "running") throw new Error("Native target lookup did not finish");
    expect(shown.exitCode, shown.stderr).toBe(0);
    expect(JSON.parse(shown.stdout ?? "")).toMatchObject({ id: "my-browser", label: "My browser", platform: "browser", online: true });
  });

  it("infers machine authority from a device-bound token and registers its implementations", async () => {
    const setupResult = await setup({
      machine: { peerId: "integration-device", label: "Integration device" },
    });
    if (!setupResult.machineToken) {
      throw new Error("sys.setup returned no machine token");
    }

    await expect(connectOnce({
      protocol: 4,
      peer: peerInfo("integration-device"),
      auth: { username: USERNAME, token: setupResult.machineToken.token },
    })).rejects.toMatchObject({
      code: 103,
      message: "Machine peers require an implements list",
    });

    await expect(connectOnce({
      protocol: 4,
      peer: peerInfo("integration-device", ["not valid!"]),
      auth: { username: USERNAME, token: setupResult.machineToken.token },
    })).rejects.toMatchObject({ code: 103, message: expect.stringContaining("Invalid implements") });

    await expect(connectOnce({
      protocol: 4,
      peer: peerInfo("other-device", ["fs.*"]),
      auth: { username: USERNAME, token: setupResult.machineToken.token },
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
      token: setupResult.machineToken.token,
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
          signals: expect.arrayContaining(["target.status", "peer.pong"]),
        },
      },
    });

    const user = createClient({
      username: USERNAME,
      password: PASSWORD,
      peer: peerInfo("device-observer"),
    });
    await expect(driver.request("shell.exec", { target: "integration-device", sessionId: crypto.randomUUID(), start: true, input: "must not run" })).rejects.toMatchObject({
      code: 403,
      details: { shellStart: "rejected" },
    });
    await user.connect();
    expect((await user.call("sys.target.list", {})).targets).toContainEqual(
      expect.objectContaining({
        targetId: "integration-device",
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
      kind: "human",
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
      name: INTEGRATION_INSTALLATION_ID,
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
      name: INTEGRATION_INSTALLATION_ID,
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

  function connectOnce(args: GsvRequestArguments, address?: string): Promise<never> {
    const client = new GSVClient(address ? { WebSocket: socketFrom(address) } : undefined);
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
    return await client.requestOnce(webSocketUrl(baseUrl), "sys.setup", { onboardingToken: "integration-onboarding-default",
      username: USERNAME,
      password: PASSWORD,
      rootPassword: ROOT_PASSWORD,
      agentName: "auth-agent",
      timezone: "Europe/Amsterdam",
      ...overrides,
    });
  }
});

// SAFETY: Node's WebSocket also takes an init object with headers in place of protocols.
const NodeWebSocket = WebSocket as new (url: string, init?: string | string[] | { headers: Record<string, string> }) => WebSocket;

/** Sockets that Cloudflare would report as coming from `address`. */
function socketFrom(address: string): GsvWebSocketConstructor {
  return class extends NodeWebSocket {
    constructor(url: string | URL) {
      super(String(url), { headers: { "CF-Connecting-IP": address } });
    }
  };
}

function peerInfo(id: string, implementsList: string[] = []): ConnectArgs["peer"] {
  return {
    id,
    version: "1.0.0",
    platform: "test",
    implements: implementsList,
  };
}
