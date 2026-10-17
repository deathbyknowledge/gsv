import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { cancelBinaryBody, type JsonValue } from "@humansandmachines/gsv/protocol";
import { instanceExecChangeSchema, type InstanceExecChange, type InstanceTargetRequest, type InstanceTargetResponse } from "@humansandmachines/gsv/services/instances";
import { COMPUTER_IMPLEMENTATIONS, type Environment } from "./config";
import { ComputerConnection } from "./computer-connection";
import { ComputerRequest } from "./computer-request";
import { within } from "./browser-operation";

export type ComputerIdentity = { installationId: string; instanceId: string; targetId: string; ownerUid: number; expiresAt: number };
type Lease = ComputerIdentity & { state: "starting" | "ready" | "stopping" | "stopped"; secret: string; attempted: boolean; bootId?: string; createdAt: number };
type Tombstone = { installationId: string; instanceId: string };
export interface ComputerControl {
  provision(identity: ComputerIdentity): Promise<void>;
  status(): Promise<{ state: Lease["state"] }>;
  execute(frame: InstanceTargetRequest, deadlineAt: number): Promise<InstanceTargetResponse>;
  cancel(requestId: string): void | Promise<void>;
  stop(identity?: Tombstone): Promise<void>;
  erase(): Promise<void>;
}
const healthSchema = z.object({ protocol: z.literal(4), version: z.string(), targetId: z.string(), bootId: z.string().uuid(), implements: z.array(z.string()) });
const execSchema = instanceExecChangeSchema.pick({ sessionId: true, event: true, exitCode: true, signal: true }).strip();
const START_TIMEOUT_MS = 120_000;

export const computerName = (installationId: string, instanceId: string): string => JSON.stringify([installationId, instanceId]);

/** Owns one physical computer for its entire lifetime. A lost computer is never recreated. */
export class ComputerInstance extends DurableObject<Environment> {
  private connection: ComputerConnection | undefined;
  private connecting: Promise<ComputerConnection> | undefined;
  private publishing: Promise<void> | undefined;
  private stopping: Promise<void> | undefined;
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

  async status(): Promise<{ state: Lease["state"] }> {
    let lease = this.lease();
    if (lease.state === "stopped") return { state: lease.state };
    if (lease.state === "stopping" || lease.expiresAt <= Date.now()) { await this.stop(); return { state: "stopped" }; }
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
      this.ctx.storage.kv.put("lease", { ...current, state: "ready", bootId: health.bootId });
      await this.attach();
      return { state: "ready" };
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
        return connection.execute(frame, deadlineAt);
      });
    } catch (cause) { void cancelBinaryBody(frame.body, "Computer request failed"); throw cause; }
  }

  cancel(requestId: string): void {
    const lease = this.ctx.storage.kv.get<Lease>("lease");
    if (lease && lease.state !== "stopped" && lease.state !== "stopping" && lease.expiresAt > Date.now()) {
      // Keep the receipt for this immutable lease, including cancellation before execute arrives.
      this.ctx.storage.kv.put(`cancelled:${requestId}`, lease.expiresAt);
    }
    // Expiry prevents new admission; active work still needs cancellation before teardown finishes.
    const request = this.requests.get(requestId);
    if (request && !request.abort.signal.aborted) request.abort.abort(new Error("Computer request cancelled"));
    else this.connection?.cancel(requestId);
  }

  stop(identity?: Tombstone): Promise<void> {
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
    this.connection?.close();
    this.connection = undefined;
    await this.ctx.container?.destroy();
    this.ctx.storage.kv.put("lease", { ...lease, state: "stopped", secret: "" });
    this.ctx.storage.kv.delete("events");
    for (const [key] of this.ctx.storage.kv.list({ prefix: "cancelled:" })) this.ctx.storage.kv.delete(key);
    await this.ctx.storage.deleteAlarm();
  }

  async erase(): Promise<void> {
    const identity = this.inspect();
    if (!identity) return;
    await this.stop();
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
    await this.ctx.storage.setAlarm(Math.min(Date.now() + 20_000, lease.expiresAt));
    if (lease.expiresAt <= Date.now() || lease.state === "stopping") { await this.stop(); return; }
    if (this.ctx.container?.running) await this.ctx.container.setInactivityTimeout(60_000);
    await this.publishEvents();
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
  private attach(): Promise<ComputerConnection> {
    if (this.connection?.connected) return Promise.resolve(this.connection);
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const lease = this.liveLease();
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
        const current = this.liveLease();
        if (response.headers.get("X-GSV-Boot-Id") !== current.bootId) throw new Error("Computer boot changed during connection");
      } catch (cause) { socket.accept(); socket.close(1000, "Computer stopped"); throw cause; }
      const connection = new ComputerConnection(socket, payload => this.execChanged(payload));
      this.connection = connection;
      return connection;
    })().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }
  private execChanged(payload: JsonValue | undefined): void {
    const lease = this.liveLease();
    const event = execSchema.parse(payload);
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
