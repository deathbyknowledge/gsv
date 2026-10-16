import { reset, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComputerInstance, computerName, type ComputerIdentity } from "../src/computer";
import type { Environment } from "../src/config";
import { InstancePolicy } from "../src/config";
import { InstanceStore } from "../src/store";

afterEach(async () => { vi.useRealTimers(); await reset(); vi.restoreAllMocks(); });

async function inComputer(work: (fixture: {
  computer: ComputerInstance; ctx: DurableObjectState; identity: ComputerIdentity;
  provider: { running: boolean; bootId: string; start: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> };
  peers: WebSocket[];
}) => Promise<void>) {
  const identity = { installationId: crypto.randomUUID(), instanceId: crypto.randomUUID(), targetId: "1234abcd", ownerUid: 1000, expiresAt: Date.now() + 300_000 };
  const peers: WebSocket[] = [];
  const provider = {
    running: false, bootId: crypto.randomUUID(), images: { base: "registry.example.test/computer@sha256:test" },
    start: vi.fn(() => { provider.running = true; }),
    destroy: vi.fn(async () => { provider.running = false; for (const peer of peers) peer.close(1000); }),
    setInactivityTimeout: vi.fn(async () => {}),
    getTcpPort: () => ({ fetch: vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith("/health")) return Response.json({ protocol: 4, version: "test", targetId: identity.targetId, bootId: provider.bootId, implements: ["fs.*", "shell.exec", "shell.cancel", "net.fetch"] });
      if (new Headers(init.headers).get("X-GSV-Boot-Id") !== provider.bootId) return new Response("Boot changed", { status: 409 });
      const pair = new WebSocketPair(); pair[1].accept(); peers.push(pair[1]);
      pair[1].addEventListener("message", message => {
        // oxlint-disable-next-line anti-slop/no-runtime-typeof -- The fixture only answers WebSocket text frames.
        if (typeof message.data !== "string") return;
        const frame = JSON.parse(message.data);
        if (frame.type === "req") pair[1].send(JSON.stringify({ type: "res", id: frame.id, ok: true, data: { status: "completed", output: "ok", exitCode: 0 } }));
      });
      return new Response(null, { status: 101, webSocket: pair[0], headers: { "X-GSV-Boot-Id": provider.bootId } });
    }) }),
  };
  await runInDurableObject(env.COMPUTERS.getByName(computerName(identity.installationId, identity.instanceId)), async (_object, ctx) => {
    // Supply the actual container API boundary while keeping real DO storage and sockets.
    Object.defineProperty(ctx, "container", { value: provider, configurable: true });
    // SAFETY: Test Wrangler binds the same namespaces and the typed TestInstanceEvents service.
    const computer = new ComputerInstance(ctx, env as Environment);
    try { await work({ computer, ctx, identity, provider, peers }); }
    finally { await computer.stop(); }
  });
}

describe("cloud computer lifecycle", () => {
  it("keeps erasure final when it overlaps a pending stop", () => inComputer(async ({ computer, identity, provider, ctx }) => {
    await computer.provision(identity); await computer.status();
    let release!: () => void;
    const destroyed = new Promise<void>(resolve => { release = resolve; });
    provider.destroy.mockImplementation(async () => { await destroyed; provider.running = false; });
    const stop = computer.stop();
    const erase = computer.erase();
    expect(provider.destroy).toHaveBeenCalledOnce();
    release();
    await Promise.all([stop, erase]);
    expect([...ctx.storage.kv.list()]).toEqual([["tombstone", { installationId: identity.installationId, instanceId: identity.instanceId }]]);
  }));

  it("starts one immutable boot and never restarts a lost computer", () => inComputer(async ({ computer, identity, provider }) => {
    await computer.provision(identity);
    expect(await computer.status()).toEqual({ state: "ready" });
    expect(provider.start).toHaveBeenCalledOnce();
    await computer.provision(identity);
    await computer.status();
    expect(provider.start).toHaveBeenCalledOnce();
    provider.running = false;
    await expect(computer.status()).rejects.toThrow("stopped unexpectedly");
    expect(provider.start).toHaveBeenCalledOnce();
  }));

  it("fences a delayed start after a stop that arrived before provisioning", () => inComputer(async ({ computer, identity, provider }) => {
    await computer.stop(identity);
    await expect(computer.provision(identity)).rejects.toThrow("erased");
    expect(provider.start).not.toHaveBeenCalled();
  }));

  it("rejects a replacement daemon on reconnect before executing a request", () => inComputer(async ({ computer, identity, provider, peers }) => {
    await computer.provision(identity);
    await computer.status();
    peers[0]!.close(1000);
    await new Promise(resolve => setTimeout(resolve, 10));
    provider.bootId = crypto.randomUUID();
    await expect(computer.execute({ type: "req", id: "execute", call: "shell.exec", args: { input: "echo should-not-run" } }, Date.now() + 5000)).rejects.toThrow("connection failed");
    expect(peers).toHaveLength(1);
    await expect(computer.status()).rejects.toThrow("identity or protocol changed");
  }));

  it("expires and erases the computer without retaining credentials or reopening its identity", () => inComputer(async ({ computer, identity, provider, ctx }) => {
    await computer.provision(identity); await computer.status();
    vi.spyOn(Date, "now").mockReturnValue(identity.expiresAt + 1);
    await computer.alarm();
    expect(provider.destroy).toHaveBeenCalledOnce();
    expect(await computer.status()).toEqual({ state: "stopped" });
    await computer.erase();
    expect([...ctx.storage.kv.list()]).toEqual([["tombstone", { installationId: identity.installationId, instanceId: identity.instanceId }]]);
    await expect(computer.provision({ ...identity, expiresAt: identity.expiresAt + 60_000 })).rejects.toThrow("erased");
  }));
});

describe("computer admission", () => {
  it("separates browser and computer reservations, never reuses a computer, and preserves exact retries", async () => {
    const limits = { enabled: true, concurrentInstances: 1, periodSeconds: 600, maxInstanceSeconds: 300 };
    const browserLimits = { ...limits, savedProfiles: 1, profileStorageBytes: 1024 };
    await runInDurableObject(env.INSTANCES.getByName(crypto.randomUUID()), (_object, ctx) => {
      const store = new InstanceStore(ctx.storage), actor = { ownerUid: 1000, human: false };
      const browser = store.admit(actor, { requestId: "browser", templateId: "browser", lifetimeSeconds: 300 }, browserLimits);
      const args = { requestId: "computer", templateId: "computer", lifetimeSeconds: 300 };
      const computer = store.admit(actor, args, limits);
      expect(computer.kind).toBe("linux");
      expect(store.admit(actor, args, limits).instanceId).toBe(computer.instanceId);
      expect(() => store.admit(actor, { ...args, requestId: "another" }, limits)).toThrow("concurrency");
      const stoppedAt = Date.now();
      store.update({ ...computer, state: "ready", readyAt: stoppedAt - 30_000 });
      store.terminal(computer.instanceId, false, stoppedAt);
      expect(store.usage(limits, Date.now(), "linux")).toMatchObject({ usedSeconds: 30, reservedSeconds: 0, activeInstances: 0 });
      expect(store.usage(browserLimits)).toMatchObject({ usedSeconds: 0, reservedSeconds: 300, activeInstances: 1 });
      expect(store.admit(actor, args, limits).state).toBe("stopped");
      expect(store.admit(actor, { ...args, requestId: "new" }, limits).instanceId).not.toBe(computer.instanceId);
      expect(store.admit(actor, { requestId: "reuse-browser", templateId: "browser", lifetimeSeconds: 300 }, browserLimits).instanceId).toBe(browser.instanceId);
    });
  });

  it("lists both kinds but does not expose browser profiles on computers", async () => {
    vi.spyOn(InstancePolicy.prototype, "requireActive").mockResolvedValue();
    vi.spyOn(InstancePolicy.prototype, "computerLimits").mockResolvedValue({ enabled: true, concurrentInstances: 1, periodSeconds: 600, maxInstanceSeconds: 300 });
    await runInDurableObject(env.INSTANCES.getByName(crypto.randomUUID()), async (object, ctx) => {
      const actor = { ownerUid: 1000, human: true };
      expect((await object.catalog(actor)).templates.map(value => value.kind)).toEqual(["browser", "linux"]);
      await expect(object.start(actor, { requestId: "profile", templateId: "computer", profileId: "browser-profile" })).rejects.toThrow("only to browser");
      const start = await object.start(actor, { requestId: "computer", templateId: "computer" });
      expect(start.instance.profileId).toBeUndefined();
      const store = new InstanceStore(ctx.storage);
      store.update({ ...start.instance, state: "ready", readyAt: Date.now() });
      await expect(object.saveProfile(actor, start.instance.instanceId)).rejects.toThrow("requires a browser");
      await expect(object.requestHandoff(actor, { instanceId: start.instance.instanceId, requestId: "handoff", tabId: 1, purpose: "Sign in" })).rejects.toThrow("requires a browser");
      await object.stop(actor, { instanceId: start.instance.instanceId });
      await object.alarm();
      expect((await object.get(actor, { instanceId: start.instance.instanceId })).instance?.state).toBe("stopped");
    });
  });
});
