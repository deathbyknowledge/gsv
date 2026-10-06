import { describe, expect, it, vi } from "vitest";
import { bodyFromBytes, bodyToBytes } from "@humansandmachines/gsv/protocol";
import type { InstallationInstances } from "@humansandmachines/gsv/services/instances";
import type { CloudInstance } from "@humansandmachines/gsv/protocol";
import type { KernelContext } from "./context";
import type { TargetDescriptor } from "./targets";
import { discoverInstanceTargets, requestInstanceTarget } from "./instance-targets";
import { handleInstanceRequest } from "./sys/instance";
import { testPeer } from "../test-support/peers";
import { openFsSource } from "../drivers/native/fs";

function context(service: Partial<InstallationInstances>, processId?: string) {
  const dispose = vi.fn(), deferred: Promise<unknown>[] = [];
  const getInstallation = vi.fn(async () => ({ ...service, [Symbol.dispose]: dispose }));
  const ledger = { append: vi.fn(), complete: vi.fn() };
  const partial = {
    installationId: "trusted-installation", env: { INSTANCES: { getInstallation } },
    peer: testPeer({ account: { uid: processId ? 2000 : 1000, username: processId ? "crew" : "owner", gids: [] } }),
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

describe("instance gateway boundary", () => {
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
    const start = vi.fn(async () => ({ instance }));
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
