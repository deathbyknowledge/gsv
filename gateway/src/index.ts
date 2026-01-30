import { DurableObject } from "cloudflare:workers";

const isWebSocketRequest = (request: Request) => 
  request.method === "GET" && request.headers.get('upgrade') === 'websocket';
;

// TODO: add proper validation
const validateFrame = (frame: Frame) => {
  const ok = ["req", "res", "evt"].includes(frame.type);
  if (!ok) throw new Error("Invalid frame");
};

const isWsConnected = (ws: WebSocket) => {
  const { connected } = ws.deserializeAttachment();
  return !!connected;
};

type RequestFrame<Params = unknown> = {
  type: "req";
  id: string;
  method: string;
  params?: Params;

};

type ErrorShape = {
    code: number;
    message: string;
    details?: unknown;
    retryable?: boolean;
    retryAfterMs?: number;
};

type ResponseFrame<Payload = unknown> = {
  type: "res";
  id: string;
  payload?: Payload;
  ok: true;
} | {
  type: "res";
  id: string;
  payload?: Payload;
  ok: false;
  error: ErrorShape;
};

type EventFrame<Payload = unknown> = {
  type: "evt";
  event: string;
  payload?: Payload;
  seq?: number;
};

type ConnectParams = {
  minProtocol: number; 
  maxProtocol: number; 
  client: {
    id: string;
    version: string;
    platform: string;
    mode: string;
  };
  caps?: string[];
  commands?: string[];
  permissions?: string[];
  auth?: string;
  device?: string;
}

type HelloOkPayload = {
  type: "hello-ok";
  protocol: number;
  server: {
    version: string;
    commit?: string;
    host?: string;
    connectionId: string;
  };
  features: {
    methods: string[];
    events: string[];
  };
  snapshot: {},
  auth?: string;
  policy: {
    maxPayload: number;
    maxBufferedBytes: number;
    tickIntervalMs: number;
  }
}

type Frame = RequestFrame | ResponseFrame | EventFrame;

export class Gateway extends DurableObject<Env> {

  async fetch(request: Request): Promise<Response> {
    if (isWebSocketRequest(request)) {
      const webSocketPair = new WebSocketPair();
      const [client, server] = Object.values(webSocketPair);
      this.ctx.acceptWebSocket(server);
      const id = crypto.randomUUID();
      server.serializeAttachment({ id, connected: false });

      return new Response(null, {
        status: 101,
        webSocket: client,
      });
    }

		return new Response("Not Found", { status: 404 });
      
  }

  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string) {
    try {
      if (typeof message === "string") {
        const frame: Frame = JSON.parse(message);
        validateFrame(frame);
        this.handleFrame(ws, frame); 
      }
    } catch (e) {
      console.error(e);
    }
  }

  handleFrame(ws: WebSocket, frame: Frame) {
    switch (frame.type) {
      case "req": {
        if (!isWsConnected(ws) && frame.method !== "connect") {
          const res: ResponseFrame = {
            type: "res",
            id: frame.id,
            ok: false,
            error: {
              code: 101, // TODO: don't pull this out of my ass
              message: "Clien't is not connected or hasn't finished handshake."
            }
          };
          ws.send(JSON.stringify(res));
          return;
        }

        switch (frame.method) {
          case "connect": {
            const { minProtocol } = (frame as RequestFrame<ConnectParams>).params ?? {}; 
            if (minProtocol != 1) {
              const res: ResponseFrame = {
                type: "res",
                id: frame.id,
                ok: false,
                error: {
                  code: 102, // TODO: don't pull this out of my ass
                  message: "Unsupported protocol version."
                }
              }; 
              ws.send(JSON.stringify(res));
              return;
            }

            const attachments = ws.deserializeAttachment();
            ws.serializeAttachment({ ...attachments, connected: true});
            const res: ResponseFrame<HelloOkPayload> = {
              type: "res",
              id: frame.id,
              ok: true,
              payload: {
                type: "hello-ok",
                protocol: 1,
                server: {
                  version: "0.0.1",
                  connectionId: attachments.id
                },
                features: {
                  methods: [],
                  events: []
                },
                snapshot: {},
                auth: undefined,
                policy: {
                  maxPayload: Infinity,
                  maxBufferedBytes: Infinity,
                  tickIntervalMs: Infinity,
                }
              }
            }; 
            ws.send(JSON.stringify(res));
          }
        }

        break;
      };
      case "res": {
        break;
      };
      case "evt": {
        break;
      };
    };
  }

}


export default {
	async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    
    if (url.pathname === "/health") {
      return Response.json({ status: "healthy" });
    }

    if (url.pathname === "/ws" && isWebSocketRequest(request)) {
      const stub = env.GATEWAY.getByName("singleton");
      return stub.fetch(request);
    }

		return new Response("Not Found", { status: 404 });

	},
} satisfies ExportedHandler<Env>;
