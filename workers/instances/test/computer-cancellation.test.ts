import { reset, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InstanceTargetRequest, InstanceTargetResponse } from "@humansandmachines/gsv/services/instances";
import { ComputerInstance, computerName, type ComputerControl, type ComputerIdentity } from "../src/computer";
import type { ComputerConnection } from "../src/computer-connection";
import { ComputerRequest } from "../src/computer-request";
import { InstanceCoordinator } from "../src/coordinator";
import { InstancePolicy } from "../src/config";
import { InstanceStore } from "../src/store";

const actor = { ownerUid: 1000, human: true };
const limits = { enabled: true, concurrentInstances: 2, periodSeconds: 36000, maxInstanceSeconds: 1800 };
const frame: InstanceTargetRequest = { type: "req", id: "request", call: "fs.read", args: { path: "/workspace/file" } };
const response: InstanceTargetResponse = { type: "res", id: frame.id, ok: true, data: { size: 0 } };

afterEach(async () => {
  vi.useRealTimers();
  await reset();
  await vi.dynamicImportSettled();
  vi.restoreAllMocks();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(release => { resolve = release; });
  return { promise, resolve };
}

function connectionFixture(object: ComputerInstance, attached?: Promise<ComputerConnection>) {
  const execute = vi.fn(async (): Promise<InstanceTargetResponse> => response);
  const cancel = vi.fn();
  // SAFETY: These tests replace only the connection boundary used by execute and cancel.
  const connection = { execute, cancel, close: vi.fn() } as ComputerConnection;
  const attach = vi.fn().mockReturnValue(attached ?? Promise.resolve(connection));
  // Replace the transport only on this disposable fixture, without starting a physical container.
  Object.assign(object, { attach, connection });
  return { connection, execute, cancel, attach };
}

async function computerFixture(work: (object: ComputerInstance, ctx: DurableObjectState, identity: ComputerIdentity) => Promise<void>) {
  const identity = { installationId: crypto.randomUUID(), instanceId: crypto.randomUUID(), ownerUid: actor.ownerUid, targetId: "computer", expiresAt: Date.now() + 300_000 };
  await runInDurableObject(env.COMPUTERS.getByName(computerName(identity.installationId, identity.instanceId)), async (object, ctx) => {
    ctx.storage.kv.put("lease", { ...identity, state: "ready", attempted: true, secret: "test", bootId: crypto.randomUUID(), createdAt: Date.now() });
    await work(object, ctx, identity);
  });
}

async function coordinatorFixture(work: (object: InstanceCoordinator, id: string, control: ReturnType<typeof fakeControl>) => Promise<void>) {
  vi.spyOn(InstancePolicy.prototype, "requireActive").mockResolvedValue();
  await runInDurableObject(env.INSTANCES.getByName(crypto.randomUUID()), async (object, ctx) => {
    const store = new InstanceStore(ctx.storage);
    const value = store.admit(actor, { templateId: "computer", requestId: "start", lifetimeSeconds: 300 }, limits);
    store.update({ ...value, state: "ready", readyAt: Date.now() });
    const control = fakeControl();
    Object.assign(object, { computer: () => control });
    await work(object, value.instanceId, control);
  });
}

function fakeControl() {
  return {
    provision: vi.fn(async () => {}), status: vi.fn(async () => ({ state: "ready" as const })),
    execute: vi.fn(async (): Promise<InstanceTargetResponse> => response), cancel: vi.fn(async () => {}),
    stop: vi.fn(async () => {}), erase: vi.fn(async () => {}),
  } satisfies ComputerControl;
}

describe("computer cancellation ownership", () => {
  it("clears a recovered provider failure before an ordinary owner stop", () => coordinatorFixture(async (object, id, control) => {
    control.status.mockRejectedValueOnce(new Error("Temporary connection failure"));
    await object.alarm();
    expect((await object.get(actor, { instanceId: id })).instance?.diagnosticRef).toBeTruthy();
    await object.alarm();
    expect((await object.get(actor, { instanceId: id })).instance?.diagnosticRef).toBeUndefined();
    await object.stop(actor, { instanceId: id });
    await object.alarm();
    expect((await object.get(actor, { instanceId: id })).instance?.state).toBe("stopped");
  }));

  it("settles stop while a connection is still attaching and cleans cancellation receipts", () => computerFixture(async (object, ctx, identity) => {
    const attached = deferred<ComputerConnection>();
    const connection = connectionFixture(object, attached.promise);
    object.cancel("previous-request");
    const pending = object.execute(frame, identity.expiresAt);
    const stopped = expect(pending).rejects.toThrow("Computer stopped");
    await object.stop();
    await stopped;
    expect([...ctx.storage.kv.list({ prefix: "cancelled:" })]).toEqual([]);
    attached.resolve(connection.connection);
    await attached.promise;
    expect(connection.execute).not.toHaveBeenCalled();
  }));

  it("settles cancellation during attach and never dispatches when the connection arrives late", () => computerFixture(async (object, _ctx, identity) => {
    const attached = deferred<ComputerConnection>();
    const connection = connectionFixture(object, attached.promise);
    const cancelBody = vi.fn(() => new Promise<void>(() => {}));
    const pending = object.execute({ ...frame, body: { stream: new ReadableStream<Uint8Array>({ cancel: cancelBody }, { highWaterMark: 0 }) } }, identity.expiresAt);
    const cancelled = expect(pending).rejects.toThrow("cancelled");
    expect(connection.attach).toHaveBeenCalledOnce();
    object.cancel(frame.id);
    await cancelled;
    expect(cancelBody).toHaveBeenCalledOnce();
    attached.resolve(connection.connection);
    await attached.promise;
    expect(connection.execute).not.toHaveBeenCalled();
  }));

  it("retains early cancellation across a cold start for the same lease", () => computerFixture(async (object, ctx, identity) => {
    object.cancel(frame.id);
    expect(ctx.storage.kv.get(`cancelled:${frame.id}`)).toBe(identity.expiresAt);
    const cold = new ComputerInstance(ctx, env);
    const connection = connectionFixture(cold);
    await expect(cold.execute(frame, identity.expiresAt)).rejects.toThrow("cancelled");
    expect(connection.attach).not.toHaveBeenCalled();
    expect(await cold.execute({ ...frame, id: "fresh" }, identity.expiresAt)).toEqual(response);
  }));

  it.each(["deadline", "explicit cancellation"] as const)("propagates %s after lease expiry before a delayed alarm", mode => computerFixture(async (object, ctx, identity) => {
    vi.useFakeTimers();
    const connection = connectionFixture(object), child = deferred<InstanceTargetResponse>();
    connection.execute.mockReturnValue(child.promise);
    const alarm = vi.spyOn(object, "alarm"), stop = vi.spyOn(object, "stop");
    const remaining = identity.expiresAt - Date.now();
    const pending = object.execute(frame, identity.expiresAt + 60_000);
    const cancelled = expect(pending).rejects.toThrow(mode === "deadline" ? "deadline exceeded" : "request cancelled");
    await vi.advanceTimersByTimeAsync(0);
    expect(connection.execute).toHaveBeenCalledWith(frame, identity.expiresAt);
    if (mode === "deadline") await vi.advanceTimersByTimeAsync(remaining + 1);
    else {
      vi.setSystemTime(identity.expiresAt + 1);
      object.cancel(frame.id);
    }
    await cancelled;
    child.resolve(response);
    await child.promise;
    expect(connection.cancel).toHaveBeenCalledExactlyOnceWith(frame.id);
    expect(ctx.storage.kv.get(`cancelled:${frame.id}`)).toBeUndefined();
    expect(alarm).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  }));

  it("keeps child cancellation attached to an unread response body", () => computerFixture(async (object, _ctx, identity) => {
    const connection = connectionFixture(object);
    const cancelBody = vi.fn(() => new Promise<void>(() => {}));
    connection.execute.mockResolvedValue({ ...response, body: { stream: new ReadableStream<Uint8Array>({ cancel: cancelBody }, { highWaterMark: 0 }) } });
    const result = await object.execute(frame, identity.expiresAt);
    if (!result.ok || !result.body) throw new Error("Expected a streamed result");
    object.cancel(frame.id);
    await expect(result.body.stream.getReader().read()).rejects.toThrow("cancelled");
    expect(cancelBody).toHaveBeenCalledOnce();
    expect(connection.cancel).toHaveBeenCalledWith(frame.id);
  }));

  it("cancels before policy admission settles without dispatching a child request", () => coordinatorFixture(async (object, id, control) => {
    const policy = deferred<void>();
    vi.mocked(InstancePolicy.prototype.requireActive).mockReturnValue(policy.promise);
    const pending = object.execute(actor, id, frame, Date.now() + 10_000);
    await object.cancel(actor, id, frame.id);
    expect(await pending).toMatchObject({ ok: false, error: { code: 499 } });
    policy.resolve();
    await policy.promise;
    expect(control.execute).not.toHaveBeenCalled();
    expect(control.cancel).toHaveBeenCalledWith(frame.id);
  }));

  it("owns coordinator response bodies until consumption and rejects overlapping request ids", () => coordinatorFixture(async (object, id, control) => {
    const cancelBody = vi.fn();
    control.execute.mockResolvedValue({ ...response, body: { stream: new ReadableStream<Uint8Array>({ cancel: cancelBody }, { highWaterMark: 0 }) } });
    const result = await object.execute(actor, id, frame, Date.now() + 10_000);
    if (!result.ok || !result.body) throw new Error("Expected a streamed result");
    await expect(object.execute(actor, id, frame, Date.now() + 10_000)).rejects.toThrow("already running");
    await object.cancel(actor, id, frame.id);
    await expect(result.body.stream.getReader().read()).rejects.toThrow("cancelled");
    expect(cancelBody).toHaveBeenCalledOnce();
  }));

  it("cancels a late child response body after the coordinator request has settled", () => coordinatorFixture(async (object, id, control) => {
    const child = deferred<InstanceTargetResponse>();
    control.execute.mockReturnValue(child.promise);
    const pending = object.execute(actor, id, frame, Date.now() + 10_000);
    await vi.waitFor(() => expect(control.execute).toHaveBeenCalledOnce());
    await object.cancel(actor, id, frame.id);
    expect(await pending).toMatchObject({ ok: false, error: { code: 499 } });
    const cancelBody = vi.fn();
    child.resolve({ ...response, body: { stream: new ReadableStream<Uint8Array>({ cancel: cancelBody }, { highWaterMark: 0 }) } });
    await vi.waitFor(() => expect(cancelBody).toHaveBeenCalledOnce());
  }));

  it.each(["deadline", "consumed"] as const)("ends body ownership on %s", async outcome => {
    vi.useFakeTimers();
    const cancelled = vi.fn(), complete = vi.fn(), cancelBody = vi.fn();
    const request = new ComputerRequest(frame, Date.now() + 100, cancelled, complete);
    const result = await request.run(async () => ({ ...response, body: { stream: new ReadableStream<Uint8Array>({
      pull(controller) { if (outcome === "consumed") controller.close(); }, cancel: cancelBody,
    }, { highWaterMark: 0 }) } }));
    if (!result.ok || !result.body) throw new Error("Expected a streamed result");
    expect(complete).not.toHaveBeenCalled();
    if (outcome === "consumed") expect(await result.body.stream.getReader().read()).toEqual({ done: true, value: undefined });
    await vi.advanceTimersByTimeAsync(100);
    await request.done;
    expect(complete).toHaveBeenCalledOnce();
    if (outcome === "deadline") {
      await expect(result.body.stream.getReader().read()).rejects.toThrow("deadline");
      expect(cancelled).toHaveBeenCalledOnce();
      expect(cancelBody).toHaveBeenCalledOnce();
    } else {
      expect(cancelled).not.toHaveBeenCalled();
      expect(cancelBody).not.toHaveBeenCalled();
    }
  });
});
