import { z } from "zod";
import type { ConnectionIdentity } from "@humansandmachines/gsv/protocol";

export type KernelWebSocketMessage = string | ArrayBuffer;

export type KernelConnectionState = {
  step: "pending" | "connected" | "superseded";
  identity?: ConnectionIdentity;
  clientId?: string;
  clientPlatform?: string;
  observedProcessIds?: string[];
};

const PROCESS_IDENTITY_SCHEMA = z.object({
  uid: z.number().int(),
  gid: z.number().int(),
  gids: z.array(z.number().int()),
  username: z.string(),
  home: z.string(),
  cwd: z.string(),
});

const CONNECTION_IDENTITY_SCHEMA = z.discriminatedUnion("role", [
  z.object({
    role: z.literal("user"),
    process: PROCESS_IDENTITY_SCHEMA,
    capabilities: z.array(z.string()),
  }),
  z.object({
    role: z.literal("driver"),
    process: PROCESS_IDENTITY_SCHEMA,
    capabilities: z.array(z.string()),
    device: z.string(),
    implements: z.array(z.string()),
  }),
  z.object({
    role: z.literal("service"),
    process: PROCESS_IDENTITY_SCHEMA,
    capabilities: z.array(z.string()),
    channel: z.string(),
  }),
]);

const KERNEL_CONNECTION_STATE_SCHEMA = z.object({
  step: z.enum(["pending", "connected", "superseded"]),
  identity: CONNECTION_IDENTITY_SCHEMA.optional(),
  clientId: z.string().optional(),
  clientPlatform: z.string().optional(),
  observedProcessIds: z.array(z.string()).optional(),
});

type ConnectionAttachment<State> = {
  version: 1;
  id: string;
  uri: string;
  state: State;
};

type AcceptedKernelWebSocket<State> = {
  connection: KernelConnection<State>;
  response: Response;
};

const CONNECTION_ATTACHMENT_SCHEMA = z.object({
  version: z.literal(1),
  id: z.string().min(1),
  uri: z.url(),
  state: KERNEL_CONNECTION_STATE_SCHEMA,
});

export class KernelConnection<State = unknown> {
  constructor(
    readonly socket: WebSocket,
    readonly id: string,
    readonly uri: string,
    private currentState: State,
  ) {}

  get state(): State {
    return this.currentState;
  }

  setState(state: State): void {
    this.currentState = state;
    this.persist();
  }

  send(message: string | ArrayBuffer | ArrayBufferView): void {
    this.socket.send(message);
  }

  close(code?: number, reason?: string): void {
    this.socket.close(code, reason);
  }

  persist(): void {
    this.socket.serializeAttachment({
      version: 1,
      id: this.id,
      uri: this.uri,
      state: this.currentState,
    } satisfies ConnectionAttachment<State>);
  }
}

export function acceptKernelWebSocket<State>(
  ctx: DurableObjectState,
  request: Request,
  initialState: State,
): AcceptedKernelWebSocket<State> {
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  const connection = new KernelConnection(
    server,
    crypto.randomUUID(),
    request.url,
    initialState,
  );
  connection.persist();
  ctx.acceptWebSocket(server);
  return {
    connection,
    response: new Response(null, { status: 101, webSocket: client }),
  };
}

export function restoreKernelWebSocket(
  socket: WebSocket,
): KernelConnection<KernelConnectionState> | null {
  const decoded = CONNECTION_ATTACHMENT_SCHEMA.safeParse(
    socket.deserializeAttachment(),
  );
  if (!decoded.success) {
    return null;
  }
  return new KernelConnection(
    socket,
    decoded.data.id,
    decoded.data.uri,
    decoded.data.state,
  );
}
