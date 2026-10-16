import type { ArgsOf, ResultOf, SyscallName, SiteAuthorization, SiteResult } from "@humansandmachines/gsv/protocol";
import type { TestHarness } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGatewayTestHarness } from "./harness";

type Worker = ReturnType<TestHarness["getWorker"]>;
type Socket = NonNullable<Awaited<ReturnType<Worker["fetch"]>>["webSocket"]>;

async function rpc<C extends SyscallName>(socket: Socket, call: C, args: ArgsOf<C>): Promise<ResultOf<C>> {
  const id = crypto.randomUUID();
  const response = new Promise<ResultOf<C>>((resolve, reject) => {
    const listener = (event: { data: unknown }) => {
      // SAFETY: Test-owned sockets receive Gateway response frames; ID correlation retains the syscall result type.
      const frame = JSON.parse(String(event.data)) as { type: string; id: string; ok: boolean; data: ResultOf<C>; error?: { message: string } };
      if (frame.type !== "res" || frame.id !== id) return;
      clearTimeout(timer); socket.removeEventListener("message", listener);
      if (frame.ok) resolve(frame.data);
      else reject(new Error(frame.error?.message ?? "Request failed"));
    };
    const timer = setTimeout(() => { socket.removeEventListener("message", listener); reject(new Error(`Timed out waiting for ${call}`)); }, 10_000);
    socket.addEventListener("message", listener);
  });
  socket.send(JSON.stringify({ type: "req", id, call, args }));
  return response;
}

describe("owner-authorized published app", () => {
  let harness: TestHarness;
  const sockets: Socket[] = [];
  beforeAll(async () => { harness = createGatewayTestHarness({ sites: true }); await harness.listen(); });
  afterAll(async () => { sockets.forEach(socket => socket.close(1000)); await harness.close(); });

  async function open(handle: "first" | "second", origin: string): Promise<Socket> {
    const response = await harness.getWorker("gsv").fetch(`https://${handle}.gsv.space/ws`, { headers: { upgrade: "websocket", origin } });
    expect(response.status).toBe(101);
    if (!response.webSocket) throw new Error("Missing Gateway socket");
    response.webSocket.accept(); sockets.push(response.webSocket);
    return response.webSocket;
  }
  const connect = (socket: Socket, auth: { password?: string; token?: string }) => rpc(socket, "sys.connect", {
    protocol: 4, peer: { id: crypto.randomUUID(), version: "1", platform: "browser" }, auth,
  });
  async function setup(handle: "first" | "second") {
    await harness.getWorker("gsv-test-dependencies").fetch(`https://fixture/__test/provisioning?handle=${handle}`, { method: "POST" });
    const owner = await open(handle, `https://${handle}.gsv.space`);
    await rpc(owner, "sys.setup", { username: "site-owner", password: "test-owner-password", rootPassword: "test-root-password", onboardingToken: `integration-onboarding-${handle}` });
    await connect(owner, { password: "test-owner-password" });
    return owner;
  }

  it("keeps calls and updates within the publishing owner and revokes an active app", async () => {
    const owner = await setup("first");
    await setup("second");
    const created: SiteResult = await rpc(owner, "site.create", { slug: "plans" });
    const content = "<h1>My plans</h1>", bytes = new TextEncoder().encode(content);
    const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(byte => byte.toString(16).padStart(2, "0")).join("");
    await rpc(owner, "fs.write", { path: "/tmp/site/index.html", content });
    await rpc(owner, "site.publish", { siteId: created.site.id, expectedRevision: 0, releaseId: crypto.randomUUID(), outputPath: "/tmp/site",
      manifest: { version: 1, entry: "index.html", routing: "static", title: "My plans", description: "An owner-only plan board",
        source: { repo: "site-owner/demo", revision: "a".repeat(40) }, files: [{ path: "index.html", size: bytes.length, sha256 }] } });
    const authorization: SiteAuthorization = await rpc(owner, "site.authorize", { siteId: created.site.id });
    expect(authorization).toMatchObject({ installationId: "inst_integration_first", siteOrigin: created.site.origin,
      gatewayOrigin: "https://first.gsv.space", calls: ["r12y.list", "r12y.get"], signals: ["r12y.changed"] });

    const app = await open("first", created.site.origin);
    const connected = await connect(app, { token: authorization.token });
    expect(connected.peer.grant).toEqual({ calls: ["r12y.list", "r12y.get"], signals: ["r12y.changed"], implements: [] });
    const changes: string[] = [];
    app.addEventListener("message", event => { if (String(event.data).includes('"r12y.changed"')) changes.push(String(event.data)); });
    const { responsibility } = await rpc(owner, "r12y.create", { title: "Plan a weekend trip", details: { description: "Synthetic test details" } });
    expect((await rpc(app, "r12y.list", {})).responsibilities.some(item => item.id === responsibility.id)).toBe(true);
    expect((await rpc(app, "r12y.get", { id: responsibility.id })).responsibility?.details).toEqual({ description: "Synthetic test details" });
    await expect.poll(() => changes.length).toBeGreaterThan(0);
    await expect(rpc(app, "fs.read", { path: "/etc/passwd" })).rejects.toThrow(/denied|does not allow/i);
    await expect(rpc(app, "r12y.create", { title: "Unauthorized write" })).rejects.toThrow(/denied|does not allow/i);
    await expect(rpc(app, "site.authorize", { siteId: created.site.id })).rejects.toThrow(/denied|does not allow/i);
    await expect(rpc(app, "sys.token.create", { kind: "human" })).rejects.toThrow(/denied|does not allow/i);
    const wrongOrigin = await open("first", "https://wrong.content.example");
    await expect(connect(wrongOrigin, { token: authorization.token })).rejects.toThrow();
    const otherSpace = await open("second", created.site.origin);
    await expect(connect(otherSpace, { token: authorization.token })).rejects.toThrow();

    let closed = false;
    app.addEventListener("close", () => { closed = true; });
    expect(await rpc(owner, "sys.token.revoke", { tokenId: authorization.tokenId })).toMatchObject({ revoked: true });
    await expect.poll(() => closed).toBe(true);
    const reconnect = await open("first", created.site.origin);
    await expect(connect(reconnect, { token: authorization.token })).rejects.toThrow();
  });
});
