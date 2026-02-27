import { describe, expect, it } from "vitest";
import { GatewayRpcDispatcher } from "./rpc-dispatcher";
import type { Frame, ErrorShape } from "../protocol/frames";
import type { Gateway } from "./do";

type FakeWebSocket = {
  attachment: {
    connected: boolean;
    mode?: "client" | "node" | "channel";
    clientId?: string;
    nodeId?: string;
    channelKey?: string;
  };
  readyState: number;
  sentFrames: Frame[];
  deserializeAttachment: () => Record<string, unknown>;
  serializeAttachment: (value: unknown) => void;
  send: (_frame: string) => void;
};

function createWs(
  attachment: FakeWebSocket["attachment"],
): FakeWebSocket {
  return {
    attachment: { ...attachment },
    readyState: 1,
    sentFrames: [],
    deserializeAttachment() {
      return this.attachment;
    },
    serializeAttachment(value: unknown) {
      this.attachment = value as FakeWebSocket["attachment"];
    },
    send(payload: string) {
      this.sentFrames.push(JSON.parse(payload) as Frame);
    },
  };
}

function createGateway(): Gateway {
  return {
    clients: new Map<string, WebSocket>(),
    nodes: new Map<string, WebSocket>(),
    channels: new Map<string, WebSocket>(),
    heartbeatScheduler: {
      initialized: false,
    },
    getConfigPath: () => undefined,
    scheduleHeartbeat: async () => {
      return;
    },
  } as unknown as Gateway;
}

describe("GatewayRpcDispatcher", () => {
  it("returns 101 for unknown methods before connect", async () => {
    const dispatcher = new GatewayRpcDispatcher();
    const ws = createWs({ connected: false });
    const gw = createGateway();

    const result = await dispatcher.dispatch(gw, ws as unknown as WebSocket, {
      type: "req",
      id: "1",
      method: "unknown.method",
      params: undefined,
    });

    expect(result).toEqual({
      kind: "error",
      error: {
        code: 101,
        message: "Not connected",
      },
    });
  });

  it("rejects unsupported mode before handler execution", async () => {
    const dispatcher = new GatewayRpcDispatcher();
    const ws = createWs({ connected: true, mode: "node", nodeId: "node-1" });
    const gw = createGateway();

    const result = await dispatcher.dispatch(gw, ws as unknown as WebSocket, {
      type: "req",
      id: "2",
      method: "tool.invoke",
      params: { tool: undefined },
    } as Frame);

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.error).toEqual({
        code: 403,
        message: "Method tool.invoke not allowed for mode",
      });
    }
  });

  it("dispatches connect on disconnected socket", async () => {
    const dispatcher = new GatewayRpcDispatcher();
    const ws = createWs({ connected: false });
    const gw = createGateway();

    const result = await dispatcher.dispatch(gw, ws as unknown as WebSocket, {
      type: "req",
      id: "3",
      method: "connect",
      params: {
        minProtocol: 1,
        maxProtocol: 1,
        client: {
          id: "client-1",
          version: "0.0.1",
          platform: "web",
          mode: "client",
        },
      },
    });
    if (result.kind === "error") {
      console.log(result.error);
    }

    expect(result.kind).toBe("ok");
    expect(ws.attachment.connected).toBe(true);
    expect(ws.attachment.mode).toBe("client");
  });
});
