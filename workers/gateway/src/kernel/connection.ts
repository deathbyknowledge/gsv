import { z } from "zod";
import type { ConnectedPeer } from "@humansandmachines/gsv/protocol";
import { connectedPeerSchema } from "../protocol/peer-schemas";

export type KernelWebSocketMessage = string | ArrayBuffer;

export type KernelConnectionState = {
  step: "pending" | "connected" | "superseded";
  /** Protocol version negotiated by sys.connect; absent on pre-protocol-4 attachments. */
  protocol?: number;
  peer?: ConnectedPeer;
  clientId?: string;
  clientPlatform?: string;
  credentialMethod?: "password" | "token";
  observedProcessIds?: string[];
};

const KERNEL_CONNECTION_STATE_SCHEMA = z.object({
  step: z.enum(["pending", "connected", "superseded"]),
  protocol: z.number().int().optional(),
  peer: connectedPeerSchema.optional(),
  clientId: z.string().optional(),
  clientPlatform: z.string().optional(),
  credentialMethod: z.enum(["password", "token"]).optional(),
  observedProcessIds: z.array(z.string()).optional(),
}) satisfies z.ZodType<KernelConnectionState>;

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
