import {
  Connection,
  ConnectionContext,
  Agent as Host,
  type WSMessage,
} from "agents";
import type { Frame, RequestFrame, ResponseFrame } from "../protocol/frames";
import type { ConnectionIdentity } from "../syscalls/system";
import { CapabilityStore, hasCapability } from "./capabilities";
import { DeviceRegistry } from "./devices";
import { handleConnect } from "./connect";
import type { KernelContext } from "./context";

const SERVER_VERSION = "0.0.1";

type ConnectionState = {
  step: "pending" | "connected";
  identity?: ConnectionIdentity;
};

export class Kernel extends Host<Env> {
  private readonly caps: CapabilityStore;
  private readonly devices: DeviceRegistry;
  private readonly connections = new Map<string, Connection>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    this.caps = new CapabilityStore(ctx.storage.sql);
    this.caps.init();

    this.devices = new DeviceRegistry(ctx.storage.sql);
    this.devices.init();
  }

  shouldSendProtocolMessages(_: Connection, __: ConnectionContext): boolean {
    return false;
  }

  onConnect(connection: Connection): void {
    const state: ConnectionState = { step: "pending" };
    connection.setState(state);
  }

  onClose(connection: Connection): void {
    const state = connection.state as ConnectionState | undefined;
    if (!state) return;

    this.connections.delete(connection.id);

    const identity = state.identity;
    if (identity?.role === "driver") {
      this.devices.setOnline(identity.device, false);
    }
  }

  async onMessage(connection: Connection<ConnectionState>, message: WSMessage): Promise<void> {
    if (typeof message !== "string") {
      // TODO: binary stream frames
      return;
    }

    let frame: Frame;
    try {
      frame = JSON.parse(message);
    } catch {
      this.sendError(connection, "?", 400, "Malformed JSON");
      return;
    }

    if (!frame.type || !["req", "res", "sig"].includes(frame.type)) {
      this.sendError(connection, "?", 400, "Invalid frame type");
      return;
    }

    switch (frame.type) {
      case "req":
        await this.handleReq(connection, frame);
        break;
      case "res":
        this.handleRes(frame);
        break;
      case "sig":
        // TODO: inbound signals
        break;
    }
  }

  private buildContext(connection: Connection<ConnectionState>): KernelContext {
    const state = connection.state;
    if (!state) throw new Error("Connection state is missing");
    return {
      env: this.env,
      caps: this.caps,
      devices: this.devices,
      connection,
      identity: state.identity as ConnectionIdentity,
      serverVersion: SERVER_VERSION,
    };
  }

  private async handleReq(connection: Connection<ConnectionState>, frame: RequestFrame): Promise<void> {
    const state = connection.state as ConnectionState | undefined;

    if (frame.call === "sys.connect") {
      if (state?.step === "connected") {
        this.sendError(connection, frame.id, 409, "Already connected");
        return;
      }
      await this.handleSysConnect(connection, frame);
      return;
    }

    if (!state || state.step !== "connected" || !state.identity) {
      this.sendError(connection, frame.id, 403, "Must call sys.connect first");
      return;
    }

    if (!hasCapability(state.identity.capabilities, frame.call)) {
      this.sendError(connection, frame.id, 403, `Permission denied: ${frame.call}`);
      return;
    }

    // TODO: dispatch to syscall handlers via buildContext(connection)
    this.sendError(connection, frame.id, 404, `Unknown syscall: ${frame.call}`);
  }

  private async handleSysConnect(
    connection: Connection<ConnectionState>,
    frame: RequestFrame<"sys.connect">,
  ): Promise<void> {
    const ctx = this.buildContext(connection);

    const outcome = await handleConnect(frame.args, ctx);

    if (!outcome.ok) {
      this.sendError(connection, frame.id, outcome.code, outcome.message);
      return;
    }

    // Handle reconnect: close old socket with same uid + client.id
    const uid = outcome.identity.process.uid;
    const clientId = frame.args?.client?.id;
    if (clientId) {
      for (const [connId, existing] of this.connections) {
        const existingState = existing.state as ConnectionState | undefined;
        if (
          existingState?.identity?.process.uid === uid &&
          connId !== ctx.connection.id &&
          existing !== connection
        ) {
          existing.close(1000, "Replaced by newer connection");
          this.connections.delete(connId);
        }
      }
    }

    const newState: ConnectionState = {
      step: "connected",
      identity: outcome.identity,
    };
    connection.setState(newState);
    this.connections.set(ctx.connection.id, connection);

    this.sendOk(connection, frame.id, outcome.result);
  }


  private handleRes(_frame: ResponseFrame): void {
    // TODO: resolve pending request promises
  }


  private sendOk(connection: Connection, id: string, data?: unknown): void {
    connection.send(JSON.stringify({ type: "res", id, ok: true, data }));
  }

  private sendError(
    connection: Connection,
    id: string,
    code: number,
    message: string,
  ): void {
    connection.send(
      JSON.stringify({
        type: "res",
        id,
        ok: false,
        error: { code, message },
      }),
    );
  }
}
