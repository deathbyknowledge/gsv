import { afterEach, describe, expect, it, vi } from "vitest";
import { bodyFromBytes, bodyToBytes } from "@humansandmachines/gsv/protocol";
import type { InstallationInstances } from "@humansandmachines/gsv/services/instances";
import type { CloudInstance } from "@humansandmachines/gsv/protocol";
import type { KernelContext } from "./context";
import type { TargetDescriptor } from "./targets";
import { discoverInstanceTargets, requestInstanceTarget } from "./instance-targets";
import { handleInstanceRequest, type InstanceRequest } from "./sys/instance";
import { testPeer } from "../test-support/peers";
import { openFsSource } from "../drivers/native/fs";
import { dispatch, type DispatchDeps } from "./dispatch";
import { ShellSessionStore } from "./shell-sessions";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import { handleSysTargetDelete } from "./sys/target";
import * as processTransport from "../shared/utils";
import { DEFAULT_TOOL_APPROVAL_POLICY, resolveToolApproval } from "../process/approval";

afterEach(() => { vi.restoreAllMocks(); });

function context(service: Partial<InstallationInstances>, processId?: string) {
  const dispose = vi.fn(), deferred: Promise<unknown>[] = [];
  const getInstallation = vi.fn(async () => ({ ...service, [Symbol.dispose]: dispose }));
  const ledger = { append: vi.fn(), complete: vi.fn() };
  const partial = {
    installationId: "trusted-installation", env: { INSTANCES: { getInstallation } },
    peer: testPeer({ account: { uid: processId ? 2000 : 1000, username: processId ? "crew" : "owner", gids: [] }, calls: ["*"] }),
    processId, procs: { getOwnerUid: () => 1000 }, auth: { getPasswdByUid: () => ({ username: "owner" }) },
    targets: { canAccess: () => false, get: () => null },
    adapters: { identityLinks: { list: () => [] } },
    ledger,
    defer: (promise: Promise<unknown>) => { deferred.push(promise); },
  };
  // SAFETY: The instance handlers tested here only access the supplied context services.
  const ctx = partial as KernelContext;
  return { ctx, dispose, getInstallation, deferred, ledger };
}
const target: TargetDescriptor = {
  targetId: "browser", route: { kind: "instance", instanceId: "instance" },
  ownerUid: 1000, ownerUsername: "owner", label: "Browser", description: "Test browser", platform: "browser", version: "1",
  online: true, implements: ["shell.exec", "fs.read"], firstSeenAt: 0, lastSeenAt: 0, connectedAt: 0, disconnectedAt: null,
};
const browserInstance: CloudInstance = {
  instanceId: "instance", targetId: "browser", startRequestId: "start", ownerUid: 1000,
  templateId: "browser", templateRevision: "1", kind: "browser", implements: [], label: "Browser",
  state: "ready", revision: 1, createdAt: 0, expiresAt: 60000,
};

describe("instance gateway boundary", () => {
  it("classifies the actual cloud route for nested approval and binds automatic approval to that instance", async () => {
    await runWithRealKernelSql(async sql => {
      const instance = { ...browserInstance, implements: ["shell.exec"], expiresAt: Date.now() + 60000 };
      const list = async () => ({ instances: [instance], handoffs: [], usage: {
        periodStartsAt: 0, periodEndsAt: 1, usedSeconds: 0, reservedSeconds: 60, limitSeconds: 3600, activeInstances: 1, concurrentLimit: 2,
      } });
      const execute = vi.fn<InstallationInstances["execute"]>(async (_actor, _id, frame) => ({ type: "res", id: frame.id, ok: true, data: {} }));
      const { ctx } = context({ list, execute }, "crew-process");
      ctx.toolOwner = { runId: "run", requestId: "shell" };
      const approve = vi.spyOn(processTransport, "sendFrameToProcess").mockImplementation(async (_installation, _pid, frame) => {
        if (frame.type !== "req" || frame.call !== "proc.tool.authorize") throw new Error("Unexpected callback");
        const args = frame.args;
        return { type: "res", id: frame.id, ok: true, data: {
          approved: resolveToolApproval(DEFAULT_TOOL_APPROVAL_POLICY, args.syscall, args.args, args.targetKind).action === "auto",
        } };
      });
      // SAFETY: An instance route uses only the durable session store from these dependencies.
      const deps = { shellSessions: new ShellSessionStore(sql) } as DispatchDeps;
      const request = () => dispatch({ type: "req", id: crypto.randomUUID(), call: "shell.exec", args: { target: "browser", input: "page snapshot" } },
        { type: "process", id: "crew-process" }, ctx, deps);
      ctx.approvedTarget = { kind: "cloud-browser", instanceId: "instance" };
      expect(await request()).toMatchObject({ response: { ok: true } });
      expect(approve).toHaveBeenCalledWith("trusted-installation", "crew-process", expect.objectContaining({
        args: expect.objectContaining({ syscall: "shell.exec", targetKind: "cloud-browser" }),
      }));
      expect(execute).toHaveBeenCalledOnce();

      ctx.approvedTarget = { kind: "other" };
      expect(await request()).toMatchObject({ response: { ok: false, error: { code: 403 } } });
      expect(execute).toHaveBeenCalledOnce();
      ctx.approvedTarget = { kind: "cloud-browser", instanceId: "instance" };
      instance.instanceId = "replacement";
      expect(await request()).toMatchObject({ response: { ok: false, error: { code: 403 } } });
      expect(approve).toHaveBeenCalledOnce();
      expect(execute).toHaveBeenCalledOnce();

      ctx.targets.canAccess = () => true;
      ctx.targets.get = () => ({
        target_id: "browser", owner_uid: 1000, label: "Browser", description: "Personal browser", platform: "browser", version: "1",
        implements: ["shell.exec"], online: true, first_seen_at: 0, last_seen_at: 0, connected_at: 0, disconnected_at: null,
      });
      expect(await request()).toMatchObject({ response: { ok: false, error: { code: 403 } } });
      expect(execute).toHaveBeenCalledOnce();
      delete ctx.approvedTarget;
      expect(await request()).toMatchObject({ response: { ok: false, error: { code: 403 } } });
      expect(approve).toHaveBeenLastCalledWith("trusted-installation", "crew-process", expect.objectContaining({
        args: expect.objectContaining({ targetKind: undefined }),
      }));
    });
  });

  it("rejects a named start before dispatch and permits a fresh attempt without reusing the reserved ID", async () => {
    await runWithRealKernelSql(async sql => {
      const instance: CloudInstance = { ...browserInstance, implements: ["shell.exec"], expiresAt: Date.now() + 60000 };
      const list = async () => ({ instances: [instance], handoffs: [], usage: {
        periodStartsAt: 0, periodEndsAt: 1, usedSeconds: 0, reservedSeconds: 60, limitSeconds: 3600, activeInstances: 1, concurrentLimit: 2,
      } });
      const execute = vi.fn<InstallationInstances["execute"]>(async (_actor, _id, frame) => ({ type: "res", id: frame.id, ok: true, data: {} }));
      const { ctx, getInstallation } = context({ list, execute });
      const acquire = getInstallation.getMockImplementation()!;
      getInstallation.mockImplementationOnce(acquire).mockRejectedValueOnce(new Error("Service acquisition failed"));
      const shellSessions = new ShellSessionStore(sql);
      // SAFETY: Instance dispatch uses only the durable session store from these dependencies.
      const deps = { shellSessions } as DispatchDeps;
      const sessionId = crypto.randomUUID();
      const start = (id: string) => dispatch({ type: "req", id: crypto.randomUUID(), call: "shell.exec",
        args: { input: "page snapshot", target: "browser", start: true, sessionId: id } }, { type: "app", id: "app" }, ctx, deps);
      expect(await start(sessionId)).toMatchObject({ handled: true, response: { ok: false,
        error: { code: 503, message: "Service acquisition failed", details: { shellStart: "rejected" } } } });
      expect(shellSessions.get(sessionId)).toMatchObject({ targetId: "browser" });
      expect(execute).not.toHaveBeenCalled();
      expect(await start(sessionId)).toMatchObject({ response: { ok: false, error: { code: 409 } } });
      expect(await start(crypto.randomUUID())).toMatchObject({ response: { ok: true } });
      expect(execute).toHaveBeenCalledOnce();
    });
  });

  it.each(["cancel", "timeout"] as const)("marks %s during acquisition as rejected and disposes a late capability", async outcome => {
    let deliver!: (service: Awaited<ReturnType<ReturnType<typeof context>["getInstallation"]>>) => void;
    const execute = vi.fn<InstallationInstances["execute"]>();
    const { ctx, getInstallation, dispose } = context({ execute });
    getInstallation.mockImplementationOnce(() => new Promise(resolve => { deliver = resolve; }));
    const cancel = vi.fn(), pull = vi.fn();
    const abort = new AbortController(); ctx.requestSignal = abort.signal;
    const pending = requestInstanceTarget({ type: "req", id: "start", call: "shell.exec",
      args: { input: "page snapshot", start: true, sessionId: crypto.randomUUID() },
      body: { stream: new ReadableStream<Uint8Array>({ cancel, pull }, { highWaterMark: 0 }) } }, target,
      Date.now() + (outcome === "timeout" ? 20 : 10000), ctx);
    if (outcome === "cancel") abort.abort(new Error("Cancelled before dispatch"));
    expect(await pending).toMatchObject({ ok: false, error: { code: outcome === "cancel" ? 499 : 504, details: { shellStart: "rejected" } } });
    expect(cancel).toHaveBeenCalledOnce();
    expect(pull).not.toHaveBeenCalled();
    deliver({ execute, [Symbol.dispose]: dispose });
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not mark a lost execute response as a rejected start", async () => {
    const { ctx } = context({ execute: async () => { throw new Error("Response lost after dispatch"); } });
    await expect(requestInstanceTarget({ type: "req", id: "start", call: "shell.exec", args: {
      input: "page click button", start: true, sessionId: crypto.randomUUID(),
    } }, target, Date.now() + 10000, ctx)).rejects.toThrow("Response lost after dispatch");
  });

  it("cancels an unexpected browser-watch upload before acquiring its response", async () => {
    const pull = vi.fn(), cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
    const bytes = new Uint8Array([1, 2, 3]);
    const { ctx, dispose, getInstallation } = context({
      watch: async () => ({ data: { watchId: "watch", version: 1 }, body: bodyFromBytes(bytes) }),
    });
    const acquire = getInstallation.getMockImplementation()!;
    getInstallation.mockImplementation(async () => { expect(cancel).toHaveBeenCalledOnce(); return acquire(); });
    const response = await handleInstanceRequest({ type: "req", id: "image", call: "sys.browser.watch", args: { instanceId: "instance" }, body: { stream } }, ctx);
    if (!response.ok || !response.body) throw new Error("Missing image response");
    expect(await bodyToBytes(response.body)).toEqual(bytes);
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it.each(["sys.browser.watch", "sys.browser.input"] as const)("cancels the %s body when service acquisition fails", async call => {
    const pull = vi.fn(), cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
    const { ctx, getInstallation } = context({});
    getInstallation.mockRejectedValueOnce(new Error("Provider unavailable"));
    await expect(handleInstanceRequest({ type: "req", id: "failed", call, args: { instanceId: "instance", tabId: 1, documentId: "document" }, body: { stream } }, ctx)).rejects.toThrow("Provider unavailable");
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("cancels stalled browser input when the service deadline expires", async () => {
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const pull = vi.fn(), cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
    const input = vi.fn<InstallationInstances["input"]>(async () => ({ accepted: true }));
    const { ctx, dispose } = context({ input });
    const request: InstanceRequest = { type: "req", id: "stalled", call: "sys.browser.input", args: { instanceId: "instance", tabId: 1, documentId: "document" }, body: { stream } };
    const pending = handleInstanceRequest(request, ctx);
    const rejected = expect(pending).rejects.toThrow("Deadline expired");
    await vi.waitFor(() => expect(pull).toHaveBeenCalledOnce());
    deadline.abort(new Error("Deadline expired"));
    await rejected;
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
    expect(dispose).toHaveBeenCalledOnce();
    expect(input).not.toHaveBeenCalled();
  });

  it("requires the instance-stop grant when deleting a cloud browser target", async () => {
    const instance: CloudInstance = {
      instanceId: "instance", targetId: "browser", startRequestId: "start", ownerUid: 1000,
      templateId: "browser", templateRevision: "1", kind: "browser", implements: ["shell.exec"], label: "Browser",
      state: "ready", revision: 1, createdAt: Date.now(), expiresAt: Date.now() + 60000,
    };
    const list = async () => ({ instances: [instance], handoffs: [], usage: { periodStartsAt: 0, periodEndsAt: 1, usedSeconds: 0, reservedSeconds: 60, limitSeconds: 3600, activeInstances: 1, concurrentLimit: 2 } });
    const stop = vi.fn(async () => ({ instance: { ...instance, state: "stopping" as const } }));
    const { ctx } = context({ list, stop });
    ctx.peer = testPeer({ account: { uid: 1000, username: "owner", gids: [] }, calls: ["sys.target.delete"] });
    await expect(handleSysTargetDelete({ targetId: "browser" }, ctx)).rejects.toThrow("permission denied: sys.instance.stop");
    expect(stop).not.toHaveBeenCalled();
    ctx.peer = testPeer({ account: { uid: 1000, username: "owner", gids: [] }, calls: ["sys.target.delete", "sys.instance.stop"] });
    expect(await handleSysTargetDelete({ targetId: "browser" }, ctx)).toMatchObject({ deleted: false, targetId: "browser" });
    expect(stop).toHaveBeenCalledOnce();
  });

  it.each(["deny", "cancel", "approve"] as const)("honors %s of a target deletion's nested instance-stop approval", async outcome => {
    const instance: CloudInstance = {
      instanceId: "instance", targetId: "browser", startRequestId: "start", ownerUid: 1000,
      templateId: "browser", templateRevision: "1", kind: "browser", implements: ["shell.exec"], label: "Browser",
      state: "ready", revision: 1, createdAt: Date.now(), expiresAt: Date.now() + 60000,
    };
    const list = async () => ({ instances: [instance], handoffs: [], usage: { periodStartsAt: 0, periodEndsAt: 1, usedSeconds: 0, reservedSeconds: 60, limitSeconds: 3600, activeInstances: 1, concurrentLimit: 2 } });
    const stop = vi.fn(async () => ({ instance }));
    const { ctx } = context({ list, stop }, "crew-process");
    const controller = new AbortController();
    ctx.requestSignal = controller.signal;
    ctx.toolOwner = { runId: "run", requestId: "shell" };
    const approve = vi.spyOn(processTransport, "sendFrameToProcess").mockImplementation(async () => {
      if (outcome === "cancel") controller.abort(new Error("stop cancelled"));
      return { type: "res", id: "approval", ok: true, data: { approved: outcome !== "deny" } };
    });
    const deleting = handleSysTargetDelete({ targetId: "browser" }, ctx);
    if (outcome === "approve") await deleting;
    else await expect(deleting).rejects.toThrow(outcome === "deny" ? "not approved" : "stop cancelled");
    expect(approve).toHaveBeenCalledWith("trusted-installation", "crew-process", expect.objectContaining({
      call: "proc.tool.authorize", args: expect.objectContaining({ ...ctx.toolOwner, syscall: "sys.instance.stop", args: { instanceId: "instance" } }),
    }));
    expect(stop).toHaveBeenCalledTimes(outcome === "approve" ? 1 : 0);
  });

  it("resolves named shell follow-ups through the owner's current instance inventory", async () => {
    await runWithRealKernelSql(async sql => {
      const instance: CloudInstance = {
        instanceId: "instance", targetId: "browser", startRequestId: "start", ownerUid: 1000,
        templateId: "browser", templateRevision: "1", kind: "browser", implements: ["shell.exec"], label: "Browser",
        state: "ready", revision: 1, createdAt: Date.now(), expiresAt: Date.now() + 60000,
      };
      const inventory = { instances: [instance], handoffs: [], usage: { periodStartsAt: 0, periodEndsAt: 1, usedSeconds: 0, reservedSeconds: 60, limitSeconds: 3600, activeInstances: 1, concurrentLimit: 2 } };
      const list = vi.fn(async () => inventory);
      const execute = vi.fn<InstallationInstances["execute"]>(async (_actor, _id, frame) => ({
        type: "res", id: frame.id, ok: true, data: { status: "failed", output: "", error: "Browser commands are foreground-only" },
      }));
      const { ctx } = context({ list, execute });
      const sessionId = crypto.randomUUID();
      const shellSessions = new ShellSessionStore(sql);
      shellSessions.rememberDeviceSession(sessionId, "browser");
      // SAFETY: An instance route only uses the session store from the dispatch dependencies.
      const deps = { shellSessions } as DispatchDeps;
      const poll = () => dispatch({ type: "req", id: "poll", call: "shell.exec", args: { sessionId, input: "" } }, { type: "app", id: "app" }, ctx, deps);
      expect(await poll()).toMatchObject({ handled: true, response: { ok: true, data: { status: "failed", error: "Browser commands are foreground-only" } } });
      expect(list).toHaveBeenCalledWith({ ownerUid: 1000, human: true }, { includeTerminal: true });
      expect(execute).toHaveBeenCalledOnce();
      expect(execute).toHaveBeenCalledWith({ ownerUid: 1000, human: true }, "instance", expect.objectContaining({ call: "shell.exec", args: { sessionId, input: "" } }), expect.any(Number));

      list.mockResolvedValue({ ...inventory, instances: [] });
      expect(await poll()).toMatchObject({ handled: true, response: { ok: false, error: { code: 403 } } });
      expect(execute).toHaveBeenCalledOnce();
    });
  });

  it("opens owned browser artifacts through the same target discovery as direct calls", async () => {
    const instance: CloudInstance = {
      instanceId: "instance", targetId: "browser", startRequestId: "start", ownerUid: 1000,
      templateId: "browser", templateRevision: "1", kind: "browser", implements: ["fs.transfer.stat", "fs.transfer.send"], label: "Browser",
      state: "ready", revision: 1, createdAt: Date.now(), expiresAt: Date.now() + 60000,
    };
    const list = vi.fn(async () => ({ instances: [instance], handoffs: [], usage: { periodStartsAt: 0, periodEndsAt: 1, usedSeconds: 0, reservedSeconds: 60, limitSeconds: 3600, activeInstances: 1, concurrentLimit: 2 } }));
    const { ctx } = context({ list }, "crew-process");
    const bytes = new Uint8Array([0x89, 0x50, 0, 0xff]);
    const requestTarget = vi.fn(async (_id: string, call: string) => ({
      type: "res" as const, id: call, ok: true as const,
      data: { ok: true as const, path: "/tmp/shot.png", size: bytes.byteLength, isFile: true, isDirectory: false, contentType: "image/png" },
      body: call === "fs.transfer.send" ? bodyFromBytes(bytes) : undefined,
    }));
    const opened = await openFsSource({ target: "browser", path: "/tmp/shot.png" }, ctx, { transport: { requestTarget } });
    expect(await bodyToBytes(opened.body)).toEqual(bytes);
    expect(list).toHaveBeenCalledWith({ ownerUid: 1000, human: false, processId: "crew-process" }, { includeTerminal: true });

    requestTarget.mockClear();
    instance.implements = ["fs.read"];
    await expect(openFsSource({ target: "browser", path: "/tmp/shot.png" }, ctx, { transport: { requestTarget } })).rejects.toThrow("does not implement fs.transfer.stat");
    expect(requestTarget).not.toHaveBeenCalled();

    list.mockResolvedValue({ ...(await list()), instances: [] });
    await expect(openFsSource({ target: "browser", path: "/tmp/shot.png" }, ctx, { transport: { requestTarget } })).rejects.toThrow("Access denied to target");
    expect(requestTarget).not.toHaveBeenCalled();
  });

  it("derives owner and installation scope and rejects human input from processes before acquiring a service", async () => {
    const { ctx, getInstallation } = context({}, "crew-process");
    for (const call of ["sys.browser.handoff.open", "sys.browser.handoff.finish", "sys.browser.watch", "sys.browser.input"] as const) {
      await expect(handleInstanceRequest({ type: "req", id: "private-input", call, args: call === "sys.browser.input" ? { instanceId: "instance", tabId: 1, documentId: "document" } : { instanceId: "instance", requestId: "login" } }, ctx)).rejects.toThrow("human owner");
    }
    expect(getInstallation).not.toHaveBeenCalled();
    const instance: CloudInstance = {
      instanceId: "instance", targetId: "browser", startRequestId: "persisted", ownerUid: 1000,
      templateId: "browser", templateRevision: "1", kind: "browser", implements: target.implements, label: "Browser",
      state: "starting", revision: 1, createdAt: 0, expiresAt: 10000,
    };
    const start = vi.fn(async () => ({ instance, disposition: "created" as const }));
    const owned = context({ start }, "crew-process");
    await handleInstanceRequest({ type: "req", id: "start", call: "sys.instance.start", args: { requestId: "persisted", templateId: "browser" } }, owned.ctx);
    expect(owned.getInstallation).toHaveBeenCalledWith("trusted-installation");
    expect(start).toHaveBeenCalledWith({ ownerUid: 1000, human: false, processId: "crew-process" }, { requestId: "persisted", templateId: "browser" });
  });

  it("retains the provider capability until the response stream finishes", async () => {
    const { ctx, dispose } = context({ execute: async () => ({ type: "res", id: "read", ok: true, data: {}, body: bodyFromBytes(new Uint8Array([7, 8])) }) });
    const response = await requestInstanceTarget({ type: "req", id: "read", call: "fs.read", args: { path: "/tmp/file" } }, target, Date.now() + 10000, ctx);
    expect(dispose).not.toHaveBeenCalled();
    if (!response.ok) throw new Error("Expected a response body");
    expect(await bodyToBytes(response.body!)).toEqual(new Uint8Array([7, 8]));
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("streams a human browser view until its consumer cancels, then releases the capability", async () => {
    const cancelled = vi.fn();
    const watch = vi.fn(async () => ({ data: { watchId: "watch", version: 1 as const }, body: {
      delivery: "realtime" as const, stream: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array([1])); }, cancel: cancelled }),
    } }));
    const { ctx, dispose } = context({ watch });
    const response = await handleInstanceRequest({ type: "req", id: "view", call: "sys.browser.watch", args: { instanceId: "instance" } }, ctx);
    expect(dispose).not.toHaveBeenCalled();
    if (!response.ok) throw new Error("Expected a view body");
    expect(response.body?.delivery).toBe("realtime");
    const reader = response.body!.stream.getReader();
    expect((await reader.read()).value).toEqual(new Uint8Array([1]));
    await reader.cancel();
    expect(cancelled).toHaveBeenCalledOnce(); expect(dispose).toHaveBeenCalledOnce();
    expect(watch).toHaveBeenCalledWith({ ownerUid: 1000, human: true }, { instanceId: "instance" });
    const process = context({}, "crew-process");
    await expect(handleInstanceRequest({ type: "req", id: "view", call: "sys.browser.watch", args: { instanceId: "instance" } }, process.ctx)).rejects.toThrow("human owner");
    expect(process.getInstallation).not.toHaveBeenCalled();
  });

  it("cancels a view admitted after the caller disconnects", async () => {
    let resolve!: (result: Awaited<ReturnType<InstallationInstances["watch"]>>) => void;
    const { ctx, dispose, deferred } = context({ watch: () => new Promise(done => { resolve = done; }) });
    const abort = new AbortController(); ctx.requestSignal = abort.signal;
    const response = handleInstanceRequest({ type: "req", id: "view", call: "sys.browser.watch", args: { instanceId: "instance" } }, ctx);
    const rejected = expect(response).rejects.toThrow("closed");
    await vi.waitFor(() => expect(resolve).toBeDefined());
    abort.abort(new Error("closed")); await rejected;
    expect(dispose).not.toHaveBeenCalled();
    const cancelled = vi.fn();
    resolve({ data: { watchId: "late", version: 1 }, body: { stream: new ReadableStream({ cancel: cancelled }) } });
    await Promise.all(deferred);
    expect(cancelled).toHaveBeenCalledOnce(); expect(dispose).toHaveBeenCalledOnce();
  });

  it("cancels once and consumes a late response before releasing its capability", async () => {
    let resolve!: (response: Awaited<ReturnType<InstallationInstances["execute"]>>) => void;
    const cancel = vi.fn(async () => {});
    const { ctx, dispose, deferred } = context({ execute: () => new Promise(done => { resolve = done; }), cancel });
    const controller = new AbortController(); ctx.requestSignal = controller.signal;
    const pending = requestInstanceTarget({ type: "req", id: "command", call: "shell.exec", args: { input: "page click button" } }, target, Date.now() + 10000, ctx);
    const rejected = expect(pending).rejects.toThrow("cancelled");
    await vi.waitFor(() => expect(resolve).toBeDefined());
    controller.abort(new Error("cancelled")); await rejected;
    expect(dispose).not.toHaveBeenCalled(); expect(cancel).toHaveBeenCalledTimes(1);
    const cancelledBody = vi.fn();
    resolve({ type: "res", id: "command", ok: true, data: {}, body: { stream: new ReadableStream({ cancel: cancelledBody }) } });
    await Promise.all(deferred);
    expect(cancelledBody).toHaveBeenCalledTimes(1); expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("reports incomplete discovery when the optional provider is unavailable", async () => {
    const { ctx, ledger } = context({ list: async () => { throw new Error("service unavailable"); } }, "crew-process");
    expect(await discoverInstanceTargets(ctx, {})).toEqual({ targets: [], complete: false });
    expect(ledger.append).toHaveBeenCalledWith(expect.objectContaining({ uid: 2000, ownerUid: 1000, pid: "crew-process", call: "sys.instance.list" }));
    expect(ledger.complete).toHaveBeenCalledWith(ledger.append.mock.calls[0][0].requestId, { outcome: "failed", error: expect.stringContaining("service unavailable") });
  });
});
