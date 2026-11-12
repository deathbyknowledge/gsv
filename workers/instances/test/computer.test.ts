import { reset, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JsonValue } from "@humansandmachines/gsv/protocol";
import { ComputerInstance, computerName, type ComputerIdentity } from "../src/computer";
import type { Environment } from "../src/config";
import { InstancePolicy } from "../src/config";
import { InstanceStore } from "../src/store";

afterEach(async () => { vi.useRealTimers(); await reset(); vi.restoreAllMocks(); });

async function inComputer(work: (fixture: {
  computer: ComputerInstance; ctx: DurableObjectState; identity: ComputerIdentity;
  provider: { running: boolean; bootId: string; start: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> };
  peers: WebSocket[]; handshakeSignals: AbortSignal[];
}) => Promise<void>, options: { responseDelayMs?: number; stallHandshake?: boolean; reply?: (frame: { args: { start?: boolean; sessionId?: string; input?: string; background?: boolean } }) => JsonValue | undefined; execStatusFirst?: JsonValue } = {}) {
  const identity = { installationId: crypto.randomUUID(), instanceId: crypto.randomUUID(), targetId: "1234abcd", ownerUid: 1000, expiresAt: Date.now() + 300_000 };
  const peers: WebSocket[] = [];
  const handshakeSignals: AbortSignal[] = [];
  const responseTimers: ReturnType<typeof setTimeout>[] = [];
  const provider = {
    running: false, bootId: crypto.randomUUID(), images: { base: "registry.example.test/computer@sha256:test" },
    start: vi.fn(() => { provider.running = true; }),
    destroy: vi.fn(async () => { provider.running = false; for (const peer of peers) peer.close(1000); }),
    setInactivityTimeout: vi.fn(async () => {}),
    getTcpPort: () => ({ fetch: vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith("/health")) return Response.json({ protocol: 4, version: "test", targetId: identity.targetId, bootId: provider.bootId, implements: ["fs.*", "shell.exec", "shell.cancel", "net.fetch"] });
      if (new Headers(init.headers).get("X-GSV-Boot-Id") !== provider.bootId) return new Response("Boot changed", { status: 409 });
      const signal = init.signal;
      if (!signal) throw new Error("Computer handshake must have a deadline");
      handshakeSignals.push(signal);
      signal.throwIfAborted();
      if (options.stallHandshake) return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      const pair = new WebSocketPair(); pair[1].accept(); peers.push(pair[1]);
      // Workerd retains the fetch signal on the WebSocket after the 101 upgrade.
      const onAbort = () => { if (pair[1].readyState === WebSocket.OPEN) pair[1].close(1000, "Fetch aborted"); };
      signal.addEventListener("abort", onAbort, { once: true });
      pair[1].addEventListener("close", () => signal.removeEventListener("abort", onAbort), { once: true });
      pair[1].addEventListener("message", message => {
        // oxlint-disable-next-line anti-slop/no-runtime-typeof -- The fixture only answers WebSocket text frames.
        if (typeof message.data !== "string") return;
        const frame = JSON.parse(message.data);
        if (frame.type === "req") {
          // gsvd forwards exec events apart from responses, so one can arrive first.
          if (options.execStatusFirst) pair[1].send(JSON.stringify({ type: "sig", signal: "exec.status", payload: options.execStatusFirst }));
          const data = options.reply?.(frame) ?? { status: "completed", output: "ok", exitCode: 0 };
          const reply = () => { if (pair[1].readyState === WebSocket.OPEN) pair[1].send(JSON.stringify({ type: "res", id: frame.id, ok: true, data })); };
          if (options.responseDelayMs) responseTimers.push(setTimeout(reply, options.responseDelayMs));
          else reply();
        }
      });
      return new Response(null, { status: 101, webSocket: pair[0], headers: { "X-GSV-Boot-Id": provider.bootId } });
    }) }),
  };
  await runInDurableObject(env.COMPUTERS.getByName(computerName(identity.installationId, identity.instanceId)), async (_object, ctx) => {
    // Supply the actual container API boundary while keeping real DO storage and sockets.
    Object.defineProperty(ctx, "container", { value: provider, configurable: true });
    // SAFETY: Test Wrangler binds the same namespaces and the typed TestInstanceEvents service.
    const computer = new ComputerInstance(ctx, env as Environment);
    try { await work({ computer, ctx, identity, provider, peers, handshakeSignals }); }
    finally { for (const timer of responseTimers) clearTimeout(timer); await computer.stop(); }
  });
}

describe("cloud computer lifecycle", () => {
  it("keeps an established socket alive for shell responses beyond the handshake deadline", () => inComputer(async ({ computer, identity, peers, handshakeSignals }) => {
    await computer.provision(identity);
    await computer.status();
    const response = await computer.execute({ type: "req", id: "long-shell", call: "shell.exec", args: { input: "sleep 6", yieldMs: 10_000 } }, Date.now() + 15_000);
    expect(response).toMatchObject({ ok: true, data: { status: "completed", output: "ok", exitCode: 0 } });
    expect(peers).toHaveLength(1);
    expect(handshakeSignals[0]!.aborted).toBe(false);
  }, { responseDelayMs: 6000 }), 10_000);

  it("still aborts a stalled handshake and permits a fresh connection attempt", async () => {
    const options = { stallHandshake: true };
    await inComputer(async ({ computer, identity, handshakeSignals }) => {
      await computer.provision(identity);
      const startedAt = Date.now();
      expect(await computer.status()).toEqual({ state: "starting" });
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(4900);
      expect(handshakeSignals).toHaveLength(1);
      expect(handshakeSignals[0]!.aborted).toBe(true);
      options.stallHandshake = false;
      expect(await computer.status()).toEqual({ state: "ready" });
      expect(handshakeSignals).toHaveLength(2);
      expect(handshakeSignals[1]!.aborted).toBe(false);
    }, options);
  }, 10_000);

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

  it("moves a ready lease's expiry later, never earlier, and not after it stops", () => inComputer(async ({ computer, identity, ctx }) => {
    await computer.provision(identity); await computer.status();
    expect(await computer.extend(identity.expiresAt + 60_000)).toBe(true);
    expect(await computer.extend(identity.expiresAt)).toBe(true);
    expect(ctx.storage.kv.get<ComputerIdentity>("lease")?.expiresAt).toBe(identity.expiresAt + 60_000);
    vi.spyOn(Date, "now").mockReturnValue(identity.expiresAt + 1);
    expect(await computer.status()).toEqual({ state: "ready" });
    await computer.stop();
    expect(await computer.extend(identity.expiresAt + 120_000)).toBe(false);
  }));

  it("reports a detached command as busy until it ends or its own timeout passes", () => inComputer(async ({ computer, identity, peers }) => {
    await computer.provision(identity); await computer.status();
    const start = (sessionId: string, timeout: number) => computer.execute({ type: "req", id: sessionId, call: "shell.exec", args: { input: "make", sessionId, start: true, timeout } }, Date.now() + 5000);
    await start("build", 600_000);
    expect(await computer.status()).toEqual({ state: "ready", busy: true });
    peers[0]!.send(JSON.stringify({ type: "sig", signal: "exec.status", payload: { sessionId: "build", event: "finished", exitCode: 0 } }));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(await computer.status()).toEqual({ state: "ready" });
    await start("lost-end-event", 60_000);
    expect(await computer.status()).toEqual({ state: "ready", busy: true });
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_001);
    expect(await computer.status()).toEqual({ state: "ready" });
  }, { reply: frame => frame.args.start ? { status: "running", output: "", sessionId: frame.args.sessionId ?? "" } : undefined }));

  it("counts any command still running as use, without a poll resetting its deadline, and one without a timeout until it ends", () => inComputer(async ({ computer, identity }) => {
    await computer.provision(identity); await computer.status();
    const exec = (id: string, args: { input: string; sessionId?: string; timeout?: number; background?: boolean }) =>
      computer.execute({ type: "req", id, call: "shell.exec", args }, Date.now() + 5000);
    const startedAt = Date.now();
    // gsvd answers an ordinary command still running after its yield window.
    await exec("yielded", { input: "python train.py", timeout: 60_000 });
    expect(await computer.status()).toEqual({ state: "ready", busy: true });
    vi.spyOn(Date, "now").mockReturnValue(startedAt + 30_000);
    await exec("poll", { input: "", sessionId: "train" });
    vi.spyOn(Date, "now").mockReturnValue(startedAt + 60_001);
    expect(await computer.status()).toEqual({ state: "ready" });
    await exec("unbounded", { input: "serve", background: true, timeout: 0 });
    vi.spyOn(Date, "now").mockReturnValue(startedAt + 200_000);
    expect(await computer.status()).toEqual({ state: "ready", busy: true });
  }, { reply: frame => frame.args.input === "python train.py" || frame.args.sessionId === "train" ? { status: "running", output: "", sessionId: "train" }
    : frame.args.background ? { status: "running", output: "", sessionId: "serve" } : undefined }));

  it("does not count a command whose end overtakes its launch's answer", () => inComputer(async ({ computer, identity }) => {
    await computer.provision(identity); await computer.status();
    await computer.execute({ type: "req", id: "quick", call: "shell.exec", args: { input: "true", background: true, timeout: 0 } }, Date.now() + 5000);
    expect(await computer.status()).toEqual({ state: "ready" });
  }, { reply: () => ({ status: "running", output: "", sessionId: "quick" }), execStatusFirst: { sessionId: "quick", event: "finished", exitCode: 0 } }));

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

  it("checks a starting computer again within a second instead of on the next maintenance pass", async () => {
    vi.spyOn(InstancePolicy.prototype, "requireActive").mockResolvedValue();
    vi.spyOn(InstancePolicy.prototype, "computerLimits").mockResolvedValue({ enabled: true, concurrentInstances: 1, periodSeconds: 600, maxInstanceSeconds: 300 });
    vi.spyOn(ComputerInstance.prototype, "provision").mockResolvedValue();
    const status = vi.spyOn(ComputerInstance.prototype, "status").mockResolvedValueOnce({ state: "starting" }).mockResolvedValue({ state: "ready" });
    await runInDurableObject(env.INSTANCES.getByName(crypto.randomUUID()), async (object, ctx) => {
      const actor = { ownerUid: 1000, human: true };
      const { instance } = await object.start(actor, { requestId: "computer", templateId: "computer" });
      await ctx.storage.deleteAlarm();
      await object.alarm();
      expect(status).toHaveBeenCalledOnce();
      expect((await object.get(actor, { instanceId: instance.instanceId })).instance?.state).toBe("starting");
      expect(await ctx.storage.getAlarm()).toBeLessThanOrEqual(Date.now() + 1_000);
      await object.alarm();
      expect((await object.get(actor, { instanceId: instance.instanceId })).instance?.state).toBe("ready");
      expect(await ctx.storage.getAlarm()).toBeGreaterThan(Date.now() + 1_000);
    });
  });

  it("keeps a used computer up for 30 minutes after each command, within its maximum lifetime", async () => {
    const limits = { enabled: true, concurrentInstances: 1, periodSeconds: 36_000, maxInstanceSeconds: 3600 };
    vi.spyOn(InstancePolicy.prototype, "requireActive").mockResolvedValue();
    vi.spyOn(InstancePolicy.prototype, "computerLimits").mockResolvedValue(limits);
    const extend = vi.spyOn(ComputerInstance.prototype, "extend").mockResolvedValue(true);
    vi.spyOn(ComputerInstance.prototype, "execute").mockImplementation(async frame => ({ type: "res", id: frame.id, ok: true, data: { status: "completed", output: "", exitCode: 0 } }));
    await runInDurableObject(env.INSTANCES.getByName(crypto.randomUUID()), async (object, ctx) => {
      const actor = { ownerUid: 1000, human: true }, store = new InstanceStore(ctx.storage);
      const { instance } = await object.start(actor, { requestId: "computer", templateId: "computer" });
      store.update({ ...instance, state: "ready", readyAt: instance.createdAt });
      const run = (afterMs: number) => {
        vi.spyOn(Date, "now").mockReturnValue(instance.createdAt + afterMs);
        return object.execute(actor, instance.instanceId, { type: "req", id: `at-${afterMs}`, call: "shell.exec", args: { input: "true" } }, Date.now() + 10_000);
      };
      const expiry = async () => (await object.get(actor, { instanceId: instance.instanceId })).instance!.expiresAt - instance.createdAt;
      expect(await expiry()).toBe(1_800_000);
      await run(1_200_000);
      expect(await expiry()).toBe(3_000_000);
      expect(extend).toHaveBeenLastCalledWith(instance.createdAt + 3_000_000);
      await run(1_230_000);
      expect(extend).toHaveBeenCalledOnce();
      await run(2_400_000);
      expect(await expiry()).toBe(3_600_000);
      expect(store.usage(limits, Date.now(), "linux").reservedSeconds).toBe(3600);
      await run(3_000_000);
      expect(extend).toHaveBeenCalledTimes(2);
    });
  });

  it("never extends a computer past the period allowance", async () => {
    const limits = { enabled: true, concurrentInstances: 1, periodSeconds: 2400, maxInstanceSeconds: 3600 };
    vi.spyOn(InstancePolicy.prototype, "requireActive").mockResolvedValue();
    vi.spyOn(InstancePolicy.prototype, "computerLimits").mockResolvedValue(limits);
    vi.spyOn(ComputerInstance.prototype, "extend").mockResolvedValue(true);
    vi.spyOn(ComputerInstance.prototype, "execute").mockImplementation(async frame => ({ type: "res", id: frame.id, ok: true, data: { status: "completed", output: "", exitCode: 0 } }));
    await runInDurableObject(env.INSTANCES.getByName(crypto.randomUUID()), async (object, ctx) => {
      const actor = { ownerUid: 1000, human: true }, store = new InstanceStore(ctx.storage);
      const { instance } = await object.start(actor, { requestId: "computer", templateId: "computer" });
      store.update({ ...instance, state: "ready", readyAt: instance.createdAt });
      vi.spyOn(Date, "now").mockReturnValue(instance.createdAt + 1_200_000);
      await object.execute(actor, instance.instanceId, { type: "req", id: "near-allowance", call: "shell.exec", args: { input: "true" } }, Date.now() + 10_000);
      expect((await object.get(actor, { instanceId: instance.instanceId })).instance!.expiresAt).toBe(instance.createdAt + 2_400_000);
      expect(store.usage(limits, Date.now(), "linux").reservedSeconds).toBe(2400);
    });
  });

  it("keeps a computer with a running job up through maintenance, and only while the computer accepts", async () => {
    const limits = { enabled: true, concurrentInstances: 1, periodSeconds: 36_000, maxInstanceSeconds: 3600 };
    vi.spyOn(InstancePolicy.prototype, "requireActive").mockResolvedValue();
    vi.spyOn(InstancePolicy.prototype, "computerLimits").mockResolvedValue(limits);
    const status = vi.spyOn(ComputerInstance.prototype, "status").mockResolvedValue({ state: "ready", busy: true });
    const extend = vi.spyOn(ComputerInstance.prototype, "extend").mockResolvedValue(true);
    await runInDurableObject(env.INSTANCES.getByName(crypto.randomUUID()), async (object, ctx) => {
      const actor = { ownerUid: 1000, human: true }, store = new InstanceStore(ctx.storage);
      const { instance } = await object.start(actor, { requestId: "computer", templateId: "computer" });
      store.update({ ...instance, state: "ready", readyAt: instance.createdAt });
      const expiry = async () => (await object.get(actor, { instanceId: instance.instanceId })).instance!.expiresAt - instance.createdAt;
      vi.spyOn(Date, "now").mockReturnValue(instance.createdAt + 1_200_000);
      await object.alarm();
      expect(await expiry()).toBe(3_000_000);
      extend.mockResolvedValue(false);
      vi.spyOn(Date, "now").mockReturnValue(instance.createdAt + 1_500_000);
      await object.alarm();
      expect(await expiry()).toBe(3_000_000);
      status.mockResolvedValue({ state: "ready" });
      extend.mockResolvedValue(true);
      vi.spyOn(Date, "now").mockReturnValue(instance.createdAt + 1_800_000);
      await object.alarm();
      expect(await expiry()).toBe(3_000_000);
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
