import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { cancelBinaryBody, DEFAULT_SHELL_EXEC_TIMEOUT_MS, type JsonValue } from "@humansandmachines/gsv/protocol";
import { instanceExecChangeSchema, type InstanceExecChange, type InstanceTargetRequest, type InstanceTargetResponse } from "@humansandmachines/gsv/services/instances";
import { COMPUTER_IMPLEMENTATIONS, type Environment } from "./config";
import { ComputerConnection } from "./computer-connection";
import { ComputerRequest } from "./computer-request";
import { within } from "./browser-operation";
import { restoreWorkspace, saveWorkspace, WORKSPACE_TIMEOUT_MS, type WorkspaceAddress, type WorkspaceSave } from "./computer-workspace";

export type ComputerIdentity = {
  installationId: string; instanceId: string; targetId: string; ownerUid: number; expiresAt: number;
  /** Where this computer saves its /workspace when its lifetime expires. */
  workspace?: WorkspaceAddress;
  /** An earlier computer's saved /workspace, restored before this one is ready. */
  restore?: WorkspaceAddress;
};
type Lease = ComputerIdentity & {
  state: "starting" | "ready" | "stopping" | "stopped"; secret: string; attempted: boolean; bootId?: string; createdAt: number;
  /** A stop that owes a workspace save, and the time by which the save must finish. */
  saveBy?: number;
};
type Tombstone = { installationId: string; instanceId: string };
export type ComputerStatus = { state: Lease["state"]; busy?: true; restoreError?: string };
/** A computer saving its workspace is still stopping; its reservation is held until it reports stopped. */
export type ComputerStop = { state: "stopping" } | { state: "stopped"; workspace?: WorkspaceSave };
export interface ComputerControl {
  provision(identity: ComputerIdentity): Promise<void>;
  /** `busy` reports a detached command that is still running. */
  status(): Promise<ComputerStatus>;
  extend(expiresAt: number): Promise<boolean>;
  execute(frame: InstanceTargetRequest, deadlineAt: number): Promise<InstanceTargetResponse>;
  cancel(requestId: string): void | Promise<void>;
  /** `expired` reports that the coordinator ended the lifetime, which saves the workspace like the computer's own expiry. */
  stop(identity?: Tombstone, expired?: boolean): Promise<ComputerStop>;
  erase(): Promise<void>;
}
// One retry after an eviction still fits before the save is abandoned.
const SAVE_WINDOW_MS = 2 * WORKSPACE_TIMEOUT_MS;
const healthSchema = z.object({ protocol: z.literal(4), version: z.string(), targetId: z.string(), bootId: z.string().uuid(), implements: z.array(z.string()) });
const execSchema = instanceExecChangeSchema.pick({ sessionId: true, event: true, exitCode: true, signal: true }).strip();
const sessionResultSchema = z.object({ status: z.enum(["completed", "running", "failed"]), sessionId: z.string().optional() });
const START_TIMEOUT_MS = 120_000;

export const computerName = (installationId: string, instanceId: string): string => JSON.stringify([installationId, instanceId]);

/** Owns one physical computer for its entire lifetime. A lost computer is never recreated. */
export class ComputerInstance extends DurableObject<Environment> {
  private connection: ComputerConnection | undefined;
  private connecting: Promise<ComputerConnection> | undefined;
  private publishing: Promise<void> | undefined;
  private stopping: Promise<void> | undefined;
  private restoring: Promise<void> | undefined;
  private readonly requests = new Map<string, ComputerRequest>();

  constructor(ctx: DurableObjectState, env: Environment) {
    super(ctx, env);
    if (ctx.container?.running) ctx.waitUntil(ctx.container.setInactivityTimeout(60_000));
  }

  async provision(identity: ComputerIdentity): Promise<void> {
    if (this.ctx.id.name !== computerName(identity.installationId, identity.instanceId)) throw new Error("Computer identity mismatch");
    if (this.ctx.storage.kv.get("tombstone")) throw new Error("Computer has been erased");
    const previous = this.ctx.storage.kv.get<Lease>("lease");
    if (previous) {
      if (previous.targetId !== identity.targetId || previous.ownerUid !== identity.ownerUid || previous.expiresAt !== identity.expiresAt) throw new Error("Computer lease is immutable");
      return;
    }
    if (identity.expiresAt <= Date.now()) throw new Error("Computer lease has expired");
    const secret = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, "0")).join("");
    this.ctx.storage.kv.put<Lease>("lease", { ...identity, state: "starting", secret, attempted: false, createdAt: Date.now() });
    await this.ctx.storage.setAlarm(Date.now() + 1);
  }

  async status(): Promise<ComputerStatus> {
    let lease = this.lease();
    if (lease.state === "stopped") {
      const restoreError = this.ctx.storage.kv.get<string>("restore_error");
      return restoreError ? { state: lease.state, restoreError } : { state: lease.state };
    }
    if (lease.state === "stopping" || lease.expiresAt <= Date.now()) return { state: (await this.stop()).state };
    const container = this.ctx.container;
    if (!container) throw new Error("Computer container binding is unavailable");
    if (!lease.attempted) {
      this.ctx.storage.kv.put("lease", { ...lease, attempted: true });
      // Persist before starting. An uncertain allocation must never replay a machine's work.
      container.start({ image: container.images.base, instance: "standard-1", enableInternet: true,
        entrypoint: ["/usr/local/bin/gsvd", "--container", "--listen", "0.0.0.0:8788", "--id", lease.targetId, "--workspace", "/workspace"],
        env: { GSV_INSTANCE_SECRET: lease.secret },
      });
    } else if (!container.running) throw new Error("Computer stopped unexpectedly; create a new instance");
    await container.setInactivityTimeout(60_000);
    lease = this.liveLease();
    try {
      const response = await container.getTcpPort(8788).fetch("http://computer/health", {
        headers: { Authorization: `Bearer ${lease.secret}` }, signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) { await response.body?.cancel(); throw new Error(`Computer health returned ${response.status}`); }
      const health = healthSchema.parse(await response.json());
      const current = this.liveLease();
      if (health.targetId !== current.targetId || (current.bootId && health.bootId !== current.bootId)
        || COMPUTER_IMPLEMENTATIONS.some(call => !health.implements.some(pattern => pattern === call || (pattern.endsWith(".*") && call.startsWith(pattern.slice(0, -1)))))) throw new Error("Computer identity or protocol changed");
      if (current.restore) {
        // The alarm restores the saved workspace; the computer is ready only after it.
        this.ctx.storage.kv.put<Lease>("lease", { ...current, bootId: health.bootId });
        if (!this.restoring) await this.ctx.storage.setAlarm(Date.now());
        return { state: "starting" };
      }
      this.ctx.storage.kv.put("lease", { ...current, state: "ready", bootId: health.bootId });
      await this.attach();
      return this.running().size ? { state: "ready", busy: true } : { state: "ready" };
    } catch (cause) {
      this.liveLease();
      if (!lease.bootId && Date.now() - lease.createdAt < START_TIMEOUT_MS) return { state: "starting" };
      throw cause;
    }
  }

  async execute(frame: InstanceTargetRequest, deadlineAt: number): Promise<InstanceTargetResponse> {
    try {
      const lease = this.liveLease();
      if (lease.state !== "ready" || !COMPUTER_IMPLEMENTATIONS.some(call => call === frame.call)) throw new Error("Computer syscall is unavailable");
      if (this.ctx.storage.kv.get(`cancelled:${frame.id}`)) throw new Error("Computer request was cancelled");
      if (this.requests.has(frame.id)) throw new Error("Computer request is already running");
      deadlineAt = Math.min(deadlineAt, lease.expiresAt);
      if (deadlineAt <= Date.now()) throw new Error("Computer request deadline exceeded");
      const request = new ComputerRequest(frame, deadlineAt, () => this.cancel(frame.id), () => { this.requests.delete(frame.id); });
      this.requests.set(frame.id, request);
      return await request.run(async signal => {
        const connection = await this.attach();
        this.liveLease();
        signal.throwIfAborted();
        const response = await connection.execute(frame, deadlineAt);
        this.trackSession(frame, response);
        return response;
      });
    } catch (cause) { void cancelBinaryBody(frame.body, "Computer request failed"); throw cause; }
  }

  /** Use moves a ready computer's expiry later. The lease never moves to another boot or to an earlier expiry. */
  async extend(expiresAt: number): Promise<boolean> {
    const lease = this.ctx.storage.kv.get<Lease>("lease");
    if (!lease || lease.state !== "ready" || lease.expiresAt <= Date.now()) return false;
    if (expiresAt > lease.expiresAt) this.ctx.storage.kv.put<Lease>("lease", { ...lease, expiresAt });
    return true;
  }

  cancel(requestId: string): void {
    const lease = this.ctx.storage.kv.get<Lease>("lease");
    if (lease && lease.state !== "stopped" && lease.state !== "stopping" && lease.expiresAt > Date.now()) {
      // Keep the receipt for this lease, including cancellation before execute arrives.
      this.ctx.storage.kv.put(`cancelled:${requestId}`, lease.expiresAt);
    }
    // Expiry prevents new admission; active work still needs cancellation before teardown finishes.
    const request = this.requests.get(requestId);
    if (request && !request.abort.signal.aborted) request.abort.abort(new Error("Computer request cancelled"));
    else this.connection?.cancel(requestId);
  }

  async stop(identity?: Tombstone, expired = false): Promise<ComputerStop> {
    const lease = this.ctx.storage.kv.get<Lease>("lease");
    if (lease && this.settle(lease, expired || lease.expiresAt <= Date.now()).saveBy !== undefined) {
      // The alarm owns the save, so maintenance never waits for it.
      if (!this.stopping) await this.ctx.storage.setAlarm(Date.now());
      return { state: "stopping" };
    }
    await this.shutdown(identity);
    const workspace = this.ctx.storage.kv.get<WorkspaceSave>("workspace");
    return workspace ? { state: "stopped", workspace } : { state: "stopped" };
  }

  /**
   * Records how a live computer ends. Expiry owes a save of a computer that
   * booted and finished any restore; an earlier stop means the work is done.
   */
  private settle(lease: Lease, expired: boolean): Lease {
    if (lease.state === "stopping" || lease.state === "stopped") return lease;
    const next: Lease = expired && lease.workspace && lease.bootId && !lease.restore
      ? { ...lease, state: "stopping", saveBy: Date.now() + SAVE_WINDOW_MS }
      : { ...lease, state: "stopping", workspace: undefined };
    this.ctx.storage.kv.put("lease", next);
    return next;
  }

  private shutdown(identity?: Tombstone): Promise<void> {
    if (!this.stopping) this.stopping = this.destroy(identity).finally(() => { this.stopping = undefined; });
    return this.stopping;
  }

  private async destroy(identity?: Tombstone): Promise<void> {
    const lease = this.ctx.storage.kv.get<Lease>("lease");
    if (!lease) {
      if (identity) {
        if (this.ctx.id.name !== computerName(identity.installationId, identity.instanceId)) throw new Error("Computer identity mismatch");
        this.ctx.storage.kv.put("tombstone", identity);
      }
      return;
    }
    if (lease.state === "stopped") return;
    this.ctx.storage.kv.put("lease", { ...lease, state: "stopping" });
    for (const request of this.requests.values()) request.abort.abort(new Error("Computer stopped"));
    if (lease.saveBy !== undefined && lease.workspace) this.ctx.storage.kv.put<WorkspaceSave>("workspace", await this.save(lease, lease.workspace, lease.saveBy));
    this.connection?.close();
    this.connection = undefined;
    await this.ctx.container?.destroy();
    // The coordinator keeps the workspace keys; a stopped computer retains none.
    this.ctx.storage.kv.put<Lease>("lease", { ...lease, state: "stopped", secret: "", workspace: undefined, restore: undefined, saveBy: undefined });
    this.ctx.storage.kv.delete("events");
    this.ctx.storage.kv.delete("sessions");
    for (const [key] of this.ctx.storage.kv.list({ prefix: "cancelled:" })) this.ctx.storage.kv.delete(key);
    await this.ctx.storage.deleteAlarm();
  }

  async erase(): Promise<void> {
    const identity = this.inspect();
    if (!identity) return;
    const lease = this.ctx.storage.kv.get<Lease>("lease");
    if (lease && lease.state !== "stopped") {
      // Deletion never saves, and closing the connection ends a save already running.
      this.ctx.storage.kv.put<Lease>("lease", { ...lease, state: "stopping", workspace: undefined, saveBy: undefined });
      this.connection?.close();
    }
    await this.shutdown();
    this.ctx.storage.transactionSync(() => {
      for (const [key] of this.ctx.storage.kv.list()) this.ctx.storage.kv.delete(key);
      this.ctx.storage.kv.put<Tombstone>("tombstone", identity);
    });
  }

  inspect(): Tombstone | null {
    const lease = this.ctx.storage.kv.get<Lease>("lease");
    return lease ? { installationId: lease.installationId, instanceId: lease.instanceId } : this.ctx.storage.kv.get<Tombstone>("tombstone") ?? null;
  }

  async alarm(): Promise<void> {
    const lease = this.ctx.storage.kv.get<Lease>("lease");
    if (!lease || lease.state === "stopped") return;
    const expired = lease.expiresAt <= Date.now();
    if (expired || lease.state === "stopping") {
      // A retry after eviction or a failed teardown still owns the stop.
      await this.ctx.storage.setAlarm(Date.now() + 20_000);
      this.settle(lease, expired);
      await this.shutdown();
      return;
    }
    await this.ctx.storage.setAlarm(Math.min(Date.now() + 20_000, lease.expiresAt));
    if (this.ctx.container?.running) await this.ctx.container.setInactivityTimeout(60_000);
    if (lease.restore && lease.bootId) await this.restore();
    await this.publishEvents();
  }

  /** Saves /workspace through the computer's own protocol connection, after admission has closed. */
  private async save(lease: Lease, address: WorkspaceAddress, saveBy: number): Promise<WorkspaceSave> {
    try {
      if (Date.now() >= saveBy) throw new Error("Workspace save did not finish in time");
      const connection = await this.attach(() => {
        const current = this.lease();
        if (current.state !== "stopping" || current.saveBy === undefined || current.bootId !== lease.bootId) throw new Error("Computer is no longer saving its workspace");
        return current;
      });
      const { bytes } = await saveWorkspace(connection, this.env.PROFILES, address);
      return { savedAt: Date.now(), bytes };
    } catch (cause) {
      return { error: cause instanceof Error ? cause.message : String(cause) };
    }
  }

  /** A computer started from a saved workspace is ready only after the workspace is in place. */
  private restore(): Promise<void> {
    if (!this.restoring) this.restoring = (async () => {
      const lease = this.liveLease();
      if (!lease.restore) return;
      try {
        await restoreWorkspace(await this.attach(), this.env.PROFILES, lease.restore);
      } catch (cause) {
        const current = this.ctx.storage.kv.get<Lease>("lease");
        if (current?.state !== "starting" || current.expiresAt <= Date.now()) return;
        this.ctx.storage.kv.put("restore_error", cause instanceof Error ? cause.message : String(cause));
        this.settle(current, false);
        await this.shutdown();
        return;
      }
      this.ctx.storage.kv.put<Lease>("lease", { ...this.liveLease(), restore: undefined });
    })().finally(() => { this.restoring = undefined; });
    return this.restoring;
  }

  private lease(): Lease {
    const lease = this.ctx.storage.kv.get<Lease>("lease");
    if (!lease) throw new Error("Computer has not been provisioned");
    return lease;
  }
  private liveLease(): Lease {
    const lease = this.lease();
    if (lease.state === "stopped" || lease.state === "stopping" || lease.expiresAt <= Date.now()) throw new Error("Computer is stopped or expired");
    return lease;
  }
  /** `current` returns the lease a connection may serve: a live one, or a stopping one while it saves. */
  private attach(current: () => Lease = () => this.liveLease()): Promise<ComputerConnection> {
    if (this.connection?.connected) return Promise.resolve(this.connection);
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const lease = current();
      const handshake = new AbortController();
      const timer = setTimeout(() => handshake.abort(new Error("Computer connection handshake timed out")), 5000);
      let response: Response;
      try {
        response = await this.ctx.container!.getTcpPort(8788).fetch("http://computer/gsv", {
          headers: { Upgrade: "websocket", Authorization: `Bearer ${lease.secret}`, "X-GSV-Boot-Id": lease.bootId! }, signal: handshake.signal,
        });
      } finally {
        // Fetch retains this signal on the upgraded socket; only the handshake has this deadline.
        clearTimeout(timer);
      }
      const socket = response.webSocket;
      if (response.status !== 101 || !socket) { await response.body?.cancel(); throw new Error("Computer protocol connection failed"); }
      try {
        if (response.headers.get("X-GSV-Boot-Id") !== current().bootId) throw new Error("Computer boot changed during connection");
      } catch (cause) { socket.accept(); socket.close(1000, "Computer stopped"); throw cause; }
      const connection = new ComputerConnection(socket, payload => this.execChanged(payload));
      this.connection = connection;
      return connection;
    })().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }
  /**
   * Detached commands keep the computer in use until they end. A lost end event
   * holds it no longer than the command's own timeout.
   */
  private running(): Map<string, number> {
    const sessions = this.ctx.storage.kv.get<Map<string, number>>("sessions") ?? new Map();
    const now = Date.now();
    for (const [sessionId, endsAt] of sessions) if (endsAt <= now) sessions.delete(sessionId);
    return sessions;
  }
  private trackSession(frame: InstanceTargetRequest, response: InstanceTargetResponse): void {
    if (frame.call !== "shell.exec" || !response.ok) return;
    const result = sessionResultSchema.safeParse(response.data);
    if (!result.success || !result.data.sessionId) return;
    const sessions = this.running();
    if (result.data.status !== "running") sessions.delete(result.data.sessionId);
    else if (frame.args.start && sessions.size < 256) sessions.set(result.data.sessionId, Date.now() + (frame.args.timeout ?? DEFAULT_SHELL_EXEC_TIMEOUT_MS));
    this.ctx.storage.kv.put("sessions", sessions);
  }
  private execChanged(payload: JsonValue | undefined): void {
    // A job may end while the workspace saves; its event must not close that connection.
    const lease = this.lease();
    if (lease.state === "stopped") return;
    const event = execSchema.parse(payload);
    if (event.event !== "started") {
      const sessions = this.running();
      if (sessions.delete(event.sessionId)) this.ctx.storage.kv.put("sessions", sessions);
    }
    const pending = this.ctx.storage.kv.get<Map<string, InstanceExecChange>>("events") ?? new Map();
    const previous = pending.get(event.sessionId);
    if (previous && previous.event !== "started" && event.event === "started") return;
    if (!previous && pending.size >= 256) throw new Error("Computer event backlog is full");
    pending.set(event.sessionId, { ...event, targetId: lease.targetId, installationId: lease.installationId, ownerUid: lease.ownerUid, instanceId: lease.instanceId });
    this.ctx.storage.kv.put("events", pending);
    this.ctx.waitUntil(this.publishEvents());
  }
  private publishEvents(): Promise<void> {
    if (this.publishing) return this.publishing;
    this.publishing = (async () => {
      const pending = this.ctx.storage.kv.get<Map<string, InstanceExecChange>>("events") ?? new Map();
      for (const [sessionId, change] of pending) {
        await within(this.env.INSTANCE_EVENTS.instanceExecChanged(change), 5000, "Computer execution notification");
        const current = this.ctx.storage.kv.get<Map<string, InstanceExecChange>>("events");
        if (!current || current.get(sessionId)?.event !== change.event) continue;
        current.delete(sessionId);
        this.ctx.storage.kv.put("events", current);
      }
    })().catch(cause => {
      const lease = this.ctx.storage.kv.get<Lease>("lease");
      if (!lease || lease.state === "stopped" || lease.state === "stopping") return;
      const ref = crypto.randomUUID();
      this.ctx.storage.kv.put("notification_failure", { ref, occurredAt: Date.now(), cause: cause instanceof Error ? cause.message : String(cause) });
      console.warn(`[Instances] Computer notification failed; diagnostic ${ref}`);
    }).finally(() => { this.publishing = undefined; });
    return this.publishing;
  }
}
