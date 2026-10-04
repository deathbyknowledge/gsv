import { afterEach, describe, expect, it, vi } from "vitest";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import { testPeer } from "../test-support/peers";
import { KernelConnection, type KernelConnectionState } from "./connection";
import { SHIP_CLIENT_IDLE_MS, ShipReplies } from "./ship-replies";
import { RunRouteStore } from "./run-routes";
import { ProcessOutput } from "./process-output";
import type { Kernel } from "./do";
import { Transport } from "./transport";

function humanConnection(id: string, uid = 1000) {
  return new KernelConnection<KernelConnectionState>(new WebSocketPair()[0], id, "https://space.example/ws", {
    step: "connected" as const,
    peer: testPeer({ kind: "human", account: { uid, gid: uid, gids: [uid], username: "person", home: "/home/person", cwd: "/home/person" }, calls: ["conversation.send"] }).peer,
  });
}

describe("Ship reply preference", () => {
  afterEach(() => vi.restoreAllMocks());

  it("accepts activity only from the authenticated human connection with current credentials", async () => {
    await runWithRealKernelSql((_sql, storage) => {
      const shipReplies = new ShipReplies(storage);
      const record = vi.spyOn(shipReplies, "recordClient");
      // SAFETY: activity admission touches only these authenticated connection collaborators.
      const host = { shipReplies, auth: { isAccountDisabled: () => false, credentialEpoch: () => 1 } } as Kernel;
      const transport = new Transport(host);
      const human = humanConnection("human");
      human.setState({ ...human.state, credentialEpoch: 1 });
      transport.handleSig(human, { type: "sig", signal: "client.activity" });
      expect(record).toHaveBeenCalledExactlyOnceWith(1000, human.id);
      transport.handleSig(human, { type: "sig", signal: "client.activity", payload: { uid: 2000 } });
      human.setState({ ...human.state, credentialEpoch: 0 });
      transport.handleSig(human, { type: "sig", signal: "client.activity" });
      for (const kind of ["machine", "service"] as const) {
        const connection = humanConnection(kind);
        connection.setState({ ...connection.state, credentialEpoch: 1,
          peer: { ...connection.state.peer!, principal: { ...connection.state.peer!.principal, kind } } });
        transport.handleSig(connection, { type: "sig", signal: "client.activity" });
      }
      expect(record).toHaveBeenCalledTimes(1);
    });
  });

  it("remembers the latest client across reconstruction, allows reporting grace, and ignores other owners", async () => {
    await runWithRealKernelSql((_sql, storage) => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
      const replies = new ShipReplies(storage);
      const web = humanConnection("web");
      const desktop = humanConnection("desktop");
      const connections = new Map([[web.id, web], [desktop.id, desktop]]);
      expect(replies.activeConnection(1000, connections)).toBeNull();
      replies.recordClient(1000, web.id);
      expect(new ShipReplies(storage).activeConnection(1000, connections)).toBe(web.id);
      expect(replies.activeConnection(2000, connections)).toBeNull();
      replies.recordClient(1000, desktop.id);
      expect(replies.activeConnection(1000, connections)).toBe(desktop.id);
      clock.mockReturnValue(1_000 + 5 * 60 * 1000);
      expect(replies.activeConnection(1000, connections)).toBe(desktop.id);
      clock.mockReturnValue(1_000 + SHIP_CLIENT_IDLE_MS - 1);
      expect(replies.activeConnection(1000, connections)).toBe(desktop.id);
      clock.mockReturnValue(1_000 + SHIP_CLIENT_IDLE_MS);
      expect(replies.activeConnection(1000, connections)).toBeNull();
      replies.recordClient(1000, desktop.id);
      connections.delete(desktop.id);
      expect(replies.activeConnection(1000, connections)).toBeNull();
      connections.set(desktop.id, humanConnection(desktop.id, 2000));
      expect(replies.activeConnection(1000, connections)).toBeNull();
      replies.recordAdapter(1000);
      expect(replies.activeConnection(1000, connections)).toBeNull();
    });
  });

  it("orders overlapping client and adapter inputs without allowing a replay to reclaim the destination", async () => {
    await runWithRealKernelSql((sql, storage) => {
      const replies = new ShipReplies(storage);
      const routes = new RunRouteStore(sql);
      const web = humanConnection("web");
      const connections = new Map([[web.id, web]]);
      const earlier = replies.reserveOrder(1000);
      const later = replies.reserveOrder(1000);
      replies.recordClientMessage(1000, web.id, "client-input", earlier, routes);
      replies.recordAdapter(1000, later);
      expect(replies.activeConnection(1000, connections)).toBeNull();
      replies.recordClientMessage(1000, web.id, "client-input", replies.reserveOrder(1000), routes);
      expect(replies.activeConnection(1000, connections)).toBeNull();
      replies.recordClient(1000, web.id);
      new ShipReplies(storage).recordAdapter(1000, later);
      expect(replies.activeConnection(1000, connections)).toBe(web.id);
    });
  });

  it("carries Ship replies across runs and switches endpoints without changing explicit routes or retry destinations", async () => {
    await runWithRealKernelSql(async (sql, storage) => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
      const shipReplies = new ShipReplies(storage);
      const runRoutes = new RunRouteStore(sql);
      const web = humanConnection("web");
      const connections = new Map([[web.id, web]]);
      const destination = { kind: "adapter" as const, adapter: "whatsapp", accountId: "managed", actorId: "person", surface: { kind: "dm" as const, id: "private" } };
      let fallbackDestination: typeof destination | null = destination;
      const adapterSetActivity = vi.fn(async () => ({ ok: true }));
      const pending: Promise<unknown>[] = [];
      // SAFETY: this fixture supplies the complete route-selection boundary; stores and connection identity are real.
      const host = {
        shipReplies, runRoutes, connections,
        installationId: "inst-replies",
        bindings: { CHANNEL_WHATSAPP: { adapterSetActivity } },
        ctx: { waitUntil: (promise: Promise<unknown>) => pending.push(promise) },
        procs: { get: (pid: string) => ({ ownerUid: 1000, isPersonalController: pid === "ship" }) },
        adapterDelivery: { materializePersonalAdapterFallback: (processId: string, runId: string, uid: number) =>
          fallbackDestination ? runRoutes.setAdapterRoute({ processId, runId, uid, followsShip: true, destination: fallbackDestination }) : null },
      } as Kernel;
      const output = new ProcessOutput(host);
      shipReplies.recordClient(1000, web.id);
      expect(output.resolveRunRoute("ship", "first", 1000)).toMatchObject({ kind: "connection", connectionId: "web" });
      runRoutes.delete("first");
      expect(output.resolveRunRoute("ship", "followup", 1000)).toMatchObject({ kind: "connection", connectionId: "web" });
      const chosen = runRoutes.pinMessageRoute("committed", () => output.resolveRunRoute("ship", "followup", 1000));
      clock.mockReturnValue(1_000 + SHIP_CLIENT_IDLE_MS);
      expect(output.resolveRunRoute("ship", "followup", 1000)).toMatchObject({ kind: "adapter", destination });
      expect(runRoutes.pinMessageRoute("committed", () => output.resolveRunRoute("ship", "followup", 1000))).toEqual(chosen);
      shipReplies.recordClient(1000, web.id);
      expect(output.resolveRunRoute("ship", "followup", 1000)).toMatchObject({ kind: "connection", connectionId: "web" });
      await Promise.all(pending);
      expect(adapterSetActivity).toHaveBeenCalledExactlyOnceWith(
        { installationId: "inst-replies" }, "managed", destination.surface, { kind: "typing", active: false },
      );
      shipReplies.recordAdapter(1000);
      expect(output.resolveRunRoute("ship", "followup", 1000)).toMatchObject({ kind: "adapter", destination });
      shipReplies.recordClient(1000, web.id);
      connections.delete(web.id);
      expect(output.resolveRunRoute("ship", "followup", 1000)).toMatchObject({ kind: "adapter", destination });
      expect(adapterSetActivity).toHaveBeenCalledTimes(1);
      fallbackDestination = { ...destination, surface: { kind: "dm", id: "another-private" } };
      output.resolveRunRoute("ship", "followup", 1000);
      fallbackDestination = null;
      expect(output.resolveRunRoute("ship", "followup", 1000)).toBeNull();
      await Promise.all(pending);
      expect(adapterSetActivity).toHaveBeenCalledTimes(3);
      expect(adapterSetActivity).toHaveBeenLastCalledWith(
        { installationId: "inst-replies" }, "managed", { kind: "dm", id: "another-private" }, { kind: "typing", active: false },
      );
      for (const kind of ["dm", "group"] as const) {
        const exact = runRoutes.setAdapterRoute({ runId: kind, processId: "ship", uid: 1000, destination: { ...destination, surface: { kind, id: "explicit" } } });
        expect(output.resolveRunRoute("ship", kind, 1000)).toEqual(exact);
      }
      expect(output.resolveRunRoute("work", "unrouted", 1000)).toBeNull();
    });
  });

  it("keeps a partial stream and its abort on the starting client after Ship moves to another client", async () => {
    await runWithRealKernelSql(async (sql, storage) => {
      const shipReplies = new ShipReplies(storage);
      const runRoutes = new RunRouteStore(sql);
      const web = humanConnection("web");
      const desktop = humanConnection("desktop");
      const sendSignalToConnection = vi.fn();
      // SAFETY: these are the complete collaborators for stream routing; route persistence is real.
      const host = {
        shipReplies, runRoutes, connections: new Map([[web.id, web], [desktop.id, desktop]]),
        procs: { get: () => ({ ownerUid: 1000, isPersonalController: true }) },
        connectionRuntime: { sendSignalToConnection },
      } as Kernel;
      const output = new ProcessOutput(host);
      const payload = { pid: "ship", runId: "streaming", messageId: "draft:streaming:send", timestamp: 1 };
      shipReplies.recordClient(1000, web.id);
      await output.deliverProcessMessageStream("ship", {
        type: "sig", signal: "proc.message.stream", payload: { ...payload, phase: "started" },
      });
      shipReplies.recordClient(1000, desktop.id);
      expect(output.resolveRunRoute("ship", payload.runId, 1000)).toMatchObject({ connectionId: desktop.id });
      host.runRoutes = new RunRouteStore(sql);
      for (const phase of ["delta", "aborted", "delta"] as const) {
        await new ProcessOutput(host).deliverProcessMessageStream("ship", {
          type: "sig", signal: "proc.message.stream", payload: { ...payload, phase, delta: "text" },
        });
      }
      expect(sendSignalToConnection.mock.calls.map(([connection, signal]) => [connection, signal])).toEqual([
        [web.id, "message.started"], [web.id, "message.delta"], [web.id, "message.aborted"],
      ]);
      expect(runRoutes.getMessageRoute(payload.messageId)).toBeUndefined();
      expect(runRoutes.pinMessageRoute("committed", () => output.resolveRunRoute("ship", payload.runId, 1000)))
        .toMatchObject({ connectionId: desktop.id });
    });
  });
});
