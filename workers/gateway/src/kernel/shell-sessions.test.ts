import { afterEach, describe, expect, it, vi } from "vitest";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import { ShellSessionStore } from "./shell-sessions";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { Kernel } from "./do";
import { KernelConnection, type KernelConnectionState } from "./connection";
import { testPeer } from "../test-support/peers";

describe("ShellSessionStore", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("remembers the owning device for a running session", async () => {
    await runWithRealKernelSql((sql) => {
      vi.spyOn(Date, "now").mockReturnValue(1_000);
      const store = new ShellSessionStore(sql);

      store.rememberDeviceSession("sh_1", "macbook");

      expect(store.get("sh_1")).toMatchObject({
        sessionId: "sh_1",
        targetId: "macbook",
        status: "running",
      });
    });
  });

  it("rejects expired sessions during lookup", async () => {
    await runWithRealKernelSql((sql) => {
      const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
      const store = new ShellSessionStore(sql);
      store.rememberDeviceSession("sh_1", "macbook", "running", { ttlMs: 10 });

      now.mockReturnValue(1_010);

      expect(store.get("sh_1")).toBeNull();
      expect(store.get("sh_1")).toBeNull();
    });
  });

  it("keeps session ownership and terminal state when events and responses arrive out of order", async () => {
    await runWithRealKernelSql(sql => {
      const store = new ShellSessionStore(sql);
      store.recordEvent("cloud:linux", { sessionId: "shell", event: "failed", exitCode: 143, signal: "SIGTERM" });
      store.recordResult("cloud:linux", { sessionId: "shell", status: "running", output: "" });
      store.recordEvent("cloud:linux", { sessionId: "shell", event: "started" });
      store.recordResult("other-target", { sessionId: "shell", status: "completed", output: "", exitCode: 0 });
      store.recordEvent("other-target", { sessionId: "shell", event: "finished", exitCode: 0 });
      expect(store.get("shell")).toMatchObject({ targetId: "cloud:linux", status: "failed", exitCode: 143, error: "SIGTERM" });
      store.recordResult("cloud:linux", { sessionId: "shell", status: "failed", output: "", exitCode: 143, error: "Cancelled" });
      expect(store.get("shell")).toMatchObject({ status: "failed", exitCode: 143, error: "Cancelled" });
    });
  });

  it("records ordinary machine results and terminal signals through the same store", async () => {
    await runInDurableObject(env.KERNEL.getByName(crypto.randomUUID()), (kernel: Kernel) => {
      const peer = testPeer({ kind: "machine", peerId: "macbook", account: { uid: 1000, username: "owner", gids: [] } }).peer;
      peer.grant.implements = ["shell.exec"];
      const connection = new KernelConnection<KernelConnectionState>(new WebSocketPair()[0], "device-connection", "https://example.test/ws", { step: "connected", peer });
      const deliver = vi.spyOn(kernel.transport, "deliverToOrigin").mockImplementation(() => {});
      const origin = { type: "connection" as const, id: "app" };
      kernel.routes.register("start", "shell.exec", origin, "macbook", connection.id);
      kernel.transport.handleRes(connection, { type: "res", id: "start", ok: true, data: { status: "running", sessionId: "machine-shell", output: "" } });
      expect(kernel.shellSessions.get("machine-shell")).toMatchObject({ targetId: "macbook", status: "running" });
      kernel.transport.handleSig(connection, { type: "sig", signal: "exec.status", payload: { sessionId: "machine-shell", event: "finished", exitCode: 0 } });
      kernel.routes.register("poll", "shell.exec", origin, "macbook", connection.id);
      kernel.transport.handleRes(connection, { type: "res", id: "poll", ok: true, data: { status: "running", sessionId: "machine-shell", output: "" } });
      expect(kernel.shellSessions.get("machine-shell")).toMatchObject({ targetId: "macbook", status: "completed", exitCode: 0 });
      expect(deliver).toHaveBeenCalledTimes(2);
    });
  });

  it("retains a disconnected device session so a new connection can check it", async () => {
    const stub = env.KERNEL.get(env.KERNEL.idFromName(crypto.randomUUID()));
    await runInDurableObject(stub, async (kernel: Kernel) => {
      kernel.shellSessions.rememberDeviceSession("sh_1", "macbook");
      kernel.transport.failRoutesForTarget("macbook");
      expect(kernel.shellSessions.get("sh_1")).toMatchObject({ status: "running", error: null });
    });
  });
});
