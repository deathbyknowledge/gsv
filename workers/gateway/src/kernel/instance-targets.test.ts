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
import { createBrowserStorageBackend } from "./browser-storage";
import { dispatch, type DispatchDeps } from "./dispatch";
import { ShellSessionStore } from "./shell-sessions";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import { handleSysTargetDelete } from "./sys/target";
import * as processTransport from "../shared/utils";

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
const frameData: Awaited<ReturnType<InstallationInstances["frame"]>>["data"] = {
  instance: {
    instanceId: "instance", targetId: "browser", startRequestId: "start", ownerUid: 1000,
    templateId: "browser", templateRevision: "1", kind: "browser", implements: [], label: "Browser",
    state: "ready", revision: 1, createdAt: 0, expiresAt: 60000,
  },
  tabId: 1, documentId: "document", tabs: [], width: 1280, height: 800, contentType: "image/jpeg",
};

describe("instance gateway boundary", () => {
  it.each(["sys.browser.frame", "sys.browser.watch"] as const)("cancels an unexpected %s upload before acquiring its response", async call => {
    const pull = vi.fn(), cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
    const bytes = new Uint8Array([1, 2, 3]);
    const { ctx, dispose, getInstallation } = context({
      frame: async () => ({ data: frameData, body: bodyFromBytes(bytes) }),
      watch: async () => ({ data: { watchId: "watch", version: 1 }, body: bodyFromBytes(bytes) }),
    });
    const acquire = getInstallation.getMockImplementation()!;
    getInstallation.mockImplementation(async () => { expect(cancel).toHaveBeenCalledOnce(); return acquire(); });
    const response = await handleInstanceRequest({ type: "req", id: "image", call, args: { instanceId: "instance" }, body: { stream } }, ctx);
    if (!response.ok || !response.body) throw new Error("Missing image response");
    expect(await bodyToBytes(response.body)).toEqual(bytes);
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it.each(["sys.browser.frame", "sys.browser.watch", "sys.browser.input"] as const)("cancels the %s body when service acquisition fails", async call => {
    const pull = vi.fn(), cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
    const { ctx, getInstallation } = context({});
    getInstallation.mockRejectedValueOnce(new Error("Provider unavailable"));
    await expect(handleInstanceRequest({ type: "req", id: "failed", call, args: { instanceId: "instance", tabId: 1, documentId: "document" }, body: { stream } }, ctx)).rejects.toThrow("Provider unavailable");
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each(["sys.browser.frame", "sys.browser.input"] as const)("cancels a stalled %s body when the service deadline expires", async call => {
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const pull = vi.fn(), cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
    const input = vi.fn<InstallationInstances["input"]>(async () => ({ accepted: true }));
    const { ctx, dispose } = context({ frame: async () => ({ data: frameData, body: { stream } }), input });
    const request: InstanceRequest = { type: "req", id: "stalled", call, args: { instanceId: "instance", tabId: 1, documentId: "document" } };
    if (call === "sys.browser.input") request.body = { stream };
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

  it("keeps filesystem browser storage owner-scoped and cannot bypass syscall grants", async () => {
    const saved = { profileId: "saved", ownerUid: 1000, label: "Browser", state: "active" as const, saveStatus: "saved" as const, createdAt: 1, savedAt: 2, storedBytes: 3, revision: 1 };
    const listProfiles = vi.fn(async () => ({ profiles: [saved] }));
    const readProfileState = vi.fn(async () => ({ body: bodyFromBytes(new Uint8Array([1, 2, 3])), size: 3 }));
    const deleteProfile = vi.fn(async () => ({ profile: saved }));
    const { ctx, dispose } = context({ listProfiles, readProfileState, deleteProfile });
    ctx.peer = testPeer({ account: { uid: 1000, username: "owner", gids: [] }, calls: ["*"] });
    const mount = createBrowserStorageBackend(ctx)!;
    const opened = await mount.openFile("/var/lib/gsv/browser/owner/state.enc");
    expect(readProfileState).toHaveBeenCalledWith({ ownerUid: 1000, human: true }, "saved");
    const before = dispose.mock.calls.length;
    await opened!.body!.cancel();
    expect(dispose).toHaveBeenCalledTimes(before + 1);
    ctx.peer = testPeer({ account: { uid: 1000, username: "owner", gids: [] }, calls: ["fs.*"] });
    await expect(mount.readFile("/var/lib/gsv/browser/owner/status.json")).rejects.toThrow("sys.browser.profile.list");
    await expect(mount.rm("/var/lib/gsv/browser/owner/state.enc")).rejects.toThrow("sys.browser.profile.list");
    ctx.peer = testPeer({ account: { uid: 1000, username: "owner", gids: [] }, calls: ["fs.*", "sys.browser.profile.list", "sys.browser.profile.get"] });
    await expect(mount.rm("/var/lib/gsv/browser/owner/state.enc")).rejects.toThrow("sys.browser.profile.delete");
    expect(deleteProfile).not.toHaveBeenCalled();
  });
  it("owns a snapshot arriving after a filesystem read is cancelled", async () => {
    const saved = { profileId: "saved", ownerUid: 1000, label: "Browser", state: "active" as const, saveStatus: "saved" as const, createdAt: 1, savedAt: 2, revision: 1 };
    let deliver!: (result: Awaited<ReturnType<InstallationInstances["readProfileState"]>>) => void;
    const readProfileState = vi.fn(() => new Promise<Awaited<ReturnType<InstallationInstances["readProfileState"]>>>(resolve => { deliver = resolve; }));
    const { ctx, dispose, deferred } = context({ listProfiles: async () => ({ profiles: [saved] }), readProfileState });
    ctx.peer = testPeer({ account: { uid: 1000, username: "owner", gids: [] }, calls: ["*"] });
    const abort = new AbortController(); ctx.requestSignal = abort.signal;
    const reading = createBrowserStorageBackend(ctx)!.openFile("/var/lib/gsv/browser/owner/state.enc");
    const rejected = expect(reading).rejects.toThrow("Cancelled");
    await vi.waitFor(() => expect(deliver).toBeDefined());
    const before = dispose.mock.calls.length;
    abort.abort(new Error("Cancelled")); await rejected;
    expect(dispose).toHaveBeenCalledTimes(before);
    const cancel = vi.fn();
    deliver({ body: { stream: new ReadableStream<Uint8Array>({ cancel }) }, size: 1 });
    await Promise.all(deferred);
    expect(cancel).toHaveBeenCalledOnce(); expect(dispose).toHaveBeenCalledTimes(before + 1);
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
    for (const call of ["sys.browser.handoff.open", "sys.browser.handoff.finish", "sys.browser.frame", "sys.browser.input"] as const) {
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
