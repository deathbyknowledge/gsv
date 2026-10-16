import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CloudInstance } from "@humansandmachines/gsv/protocol";
import type { InstallationInstances } from "@humansandmachines/gsv/services/instances";
import * as nativeTarget from "../drivers/native/target";
import type { NativeShellCommandOptions } from "../drivers/native/shell/commands";
import type { RequestFrame } from "../protocol/frames";
import * as processTransport from "../shared/utils";
import { testPeer } from "../test-support/peers";
import type { KernelContext } from "./context";
import type { Kernel } from "./do";

afterEach(() => { vi.restoreAllMocks(); });

const computer: CloudInstance = {
  instanceId: "builder-instance", targetId: "cloud-builder", startRequestId: "computer-start", ownerUid: 1000,
  templateId: "linux", templateRevision: "1", kind: "linux", implements: ["shell.exec", "shell.cancel"],
  label: "Builder", state: "ready", revision: 1, createdAt: 0, expiresAt: Date.now() + 3_600_000,
};

async function fixture(kernel: Kernel) {
  const abort = new AbortController();
  const peer = testPeer({ account: { uid: 1000, gid: 1000, gids: [], username: "owner", home: "/home/owner" }, calls: ["shell.*"] });
  const ctx = kernel.buildKernelContext({ peer, callerOwnerUid: 1000, processId: "builder-process", processRunId: "build-run", requestSignal: abort.signal });
  const defer = vi.fn(ctx.defer);
  ctx.defer = defer;
  const execute = vi.fn<InstallationInstances["execute"]>(async (_actor, _id, frame) => {
    if (frame.call === "shell.exec") return { type: "res", id: frame.id, ok: true, data: { status: "running", sessionId: frame.args.sessionId, output: "" } };
    if (frame.call === "shell.cancel") return { type: "res", id: frame.id, ok: true, data: { sessionId: frame.args.sessionId, cancelled: true } };
    throw new Error(`Unexpected target call: ${frame.call}`);
  });
  const list = vi.fn(async () => ({ instances: [computer], handoffs: [], usage: {
    periodStartsAt: 0, periodEndsAt: 1, usedSeconds: 0, reservedSeconds: 60, limitSeconds: 3600, activeInstances: 1, concurrentLimit: 2,
  } }));
  // SAFETY: This isolated instance service implements the discovery and execution methods exercised here.
  ctx.env = { ...ctx.env, INSTANCES: { getInstallation: async () => ({ list, execute, cancel: vi.fn(async () => {}), [Symbol.dispose]: () => {} }) } } as KernelContext["env"];
  vi.spyOn(kernel.manual, "ensureCurrent").mockResolvedValue();
  const approve = vi.spyOn(processTransport, "sendFrameToProcess").mockImplementation(async (_installation, _pid, frame) => {
    if (frame.type !== "req" || frame.call !== "proc.tool.authorize") throw new Error("Unexpected Process callback");
    return { type: "res", id: frame.id, ok: true, data: { approved: true } };
  });
  const requests = vi.spyOn(kernel, "requestDispatchedFrame");
  let options: NativeShellCommandOptions | undefined;
  vi.spyOn(nativeTarget, "dispatchGsvTarget").mockImplementation(async (frame, _ctx, nativeOptions) => {
    options = nativeOptions;
    return { type: "res", id: frame.id, ok: true, data: { status: "completed", output: "", exitCode: 0 } };
  });
  await kernel.requestDispatchedFrame({ type: "req", id: crypto.randomUUID(), call: "shell.exec", args: { input: "owned build", target: "gsv" } }, ctx);
  const request = options?.request, cancel = options?.cancelOwnedShellSession;
  if (!request || !cancel) throw new Error("Native request ownership support is missing");
  const start = (sessionId = crypto.randomUUID()) => {
    const frame: RequestFrame<"shell.exec"> = { type: "req", id: crypto.randomUUID(), call: "shell.exec", args: {
      target: computer.targetId, sessionId, start: true, input: "npm run build",
    } };
    return { sessionId, pending: request(frame) };
  };
  return { abort, peer, ctx, execute, list, approve, requests, request, cancel, start, defer };
}

describe("native operation shell cleanup", () => {
  it("stops its admitted session after parent abort through ordinary dispatch and retains attribution", async () => {
    await runInDurableObject(env.KERNEL.getByName(crypto.randomUUID()), async (kernel: Kernel) => {
      const f = await fixture(kernel);
      const { sessionId, pending } = f.start();
      expect(await pending).toMatchObject({ ok: true });
      f.abort.abort(new Error("Owner cancelled"));
      f.approve.mockClear();
      f.defer.mockClear();
      let finish!: () => void;
      const blocked = new Promise<void>(resolve => { finish = resolve; });
      f.execute.mockImplementationOnce(async (_actor, _id, frame) => {
        await blocked;
        return { type: "res", id: frame.id, ok: true, data: { sessionId, cancelled: true } };
      });
      const cleanup = f.cancel(sessionId, AbortSignal.timeout(1000));
      const retained = f.defer.mock.calls.at(-1)?.[0];
      if (!retained) throw new Error("Cleanup I/O was not retained after the outer request ended");
      let deferredFinished = false;
      void retained.then(() => { deferredFinished = true; });
      await Promise.resolve();
      expect(deferredFinished).toBe(false);
      finish();
      await expect(cleanup).resolves.toBeUndefined();
      await retained;
      expect(f.execute).toHaveBeenLastCalledWith({ ownerUid: 1000, human: false, processId: "builder-process" }, computer.instanceId,
        expect.objectContaining({ call: "shell.cancel", args: { sessionId } }), expect.any(Number));
      expect(f.requests).toHaveBeenLastCalledWith(expect.objectContaining({ call: "shell.cancel", args: { sessionId } }),
        expect.objectContaining({ peer: f.peer, processId: "builder-process", processRunId: undefined, toolOwner: undefined, requestSignal: expect.any(AbortSignal) }), expect.any(AbortSignal));
      expect(f.approve).not.toHaveBeenCalled();
      const ledger = vi.spyOn(kernel.ledger, "append");
      await f.cancel(sessionId, AbortSignal.timeout(1000));
      expect(ledger).toHaveBeenCalledWith(expect.objectContaining({ call: "shell.cancel", pid: "builder-process", ownerUid: 1000, target: computer.targetId }));
      await expect(f.request({ type: "req", id: crypto.randomUUID(), call: "shell.exec", args: { target: computer.targetId, input: "must not run" } }, AbortSignal.timeout(1000)))
        .rejects.toThrow("Owner cancelled");
      expect(f.execute).toHaveBeenCalledTimes(3);
    });
  });

  it("retains ownership when cancellation loses the start response after admission", async () => {
    await runInDurableObject(env.KERNEL.getByName(crypto.randomUUID()), async (kernel: Kernel) => {
      const f = await fixture(kernel);
      f.execute.mockImplementationOnce(async () => { f.abort.abort(new Error("Owner cancelled")); throw new Error("Start response lost"); });
      const { sessionId, pending } = f.start();
      await expect(pending).rejects.toThrow("Owner cancelled");
      expect(kernel.shellSessions.get(sessionId)?.targetId).toBe(computer.targetId);
      await expect(f.cancel(sessionId, AbortSignal.timeout(1000))).resolves.toBeUndefined();
      expect(f.execute).toHaveBeenLastCalledWith(expect.anything(), computer.instanceId, expect.objectContaining({ call: "shell.cancel", args: { sessionId } }), expect.any(Number));
    });
  });

  it("cannot adopt foreign, duplicate, or denied starts", async () => {
    await runInDurableObject(env.KERNEL.getByName(crypto.randomUUID()), async (kernel: Kernel) => {
      const f = await fixture(kernel);
      const foreign = crypto.randomUUID();
      kernel.shellSessions.rememberDeviceSession(foreign, computer.targetId);
      expect(await f.start(foreign).pending).toMatchObject({ ok: false, error: { code: 409 } });
      await expect(f.cancel(foreign, AbortSignal.timeout(1000))).rejects.toThrow("not owned");
      await expect(f.cancel(crypto.randomUUID(), AbortSignal.timeout(1000))).rejects.toThrow("not owned");
      f.peer.peer.grant.calls = ["shell.cancel"];
      const denied = f.start();
      expect(await denied.pending).toMatchObject({ ok: false, error: { code: 403 } });
      await expect(f.cancel(denied.sessionId, AbortSignal.timeout(1000))).rejects.toThrow("not owned");
      expect(f.execute).not.toHaveBeenCalled();
    });
  });

  it("gives only the winning native operation cleanup authority when starts race", async () => {
    await runInDurableObject(env.KERNEL.getByName(crypto.randomUUID()), async (kernel: Kernel) => {
      const first = await fixture(kernel), second = await fixture(kernel);
      const sessionId = crypto.randomUUID();
      const results = await Promise.all([first.start(sessionId).pending, second.start(sessionId).pending]);
      expect(results.filter(result => result.ok)).toHaveLength(1);
      first.abort.abort();
      second.abort.abort();
      const winner = results[0].ok ? first : second, loser = results[0].ok ? second : first;
      await expect(loser.cancel(sessionId, AbortSignal.timeout(1000))).rejects.toThrow("not owned");
      await expect(winner.cancel(sessionId, AbortSignal.timeout(1000))).resolves.toBeUndefined();
    });
  });

  it.each(["grant", "target", "record", "deadline"] as const)("retains the %s check during cleanup", async reason => {
    await runInDurableObject(env.KERNEL.getByName(crypto.randomUUID()), async (kernel: Kernel) => {
      const f = await fixture(kernel);
      const { sessionId, pending } = f.start();
      await pending;
      f.abort.abort();
      if (reason === "grant") f.peer.peer.grant.calls = ["shell.exec"];
      if (reason === "target") f.list.mockResolvedValue({ ...(await f.list()), instances: [] });
      if (reason === "record") {
        const original = kernel.shellSessions.get.bind(kernel.shellSessions);
        vi.spyOn(kernel.shellSessions, "get").mockImplementation(id => {
          const record = original(id);
          return record && id === sessionId ? { ...record, targetId: "replacement" } : record;
        });
      }
      const signal = reason === "deadline" ? AbortSignal.abort(new Error("Cleanup expired")) : AbortSignal.timeout(1000);
      await expect(f.cancel(sessionId, signal)).rejects.toThrow(reason === "grant" ? "Permission denied: shell.cancel"
        : reason === "target" ? "Access denied" : reason === "record" ? "original target" : "Cleanup expired");
      expect(f.execute).toHaveBeenCalledOnce();
    });
  });
});
