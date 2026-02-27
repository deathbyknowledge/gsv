import type { ErrorShape, Frame } from "../protocol/frames";
import { DEFER_RESPONSE, type RpcMethod } from "../protocol/methods";
import { toErrorShape, isWsConnected } from "../shared/utils";
import { buildRpcHandlers } from "./rpc-handlers/";
import {
  buildRpcRegistry,
  isMethodAllowedForMode,
  type RpcMethodDescriptorAny,
  type RpcRegistry,
} from "./rpc-registry";
import type { Gateway } from "./do";

export type RpcDispatchResult =
  | { kind: "ignore" }
  | { kind: "ok"; payload: unknown }
  | { kind: "deferred" }
  | { kind: "error"; error: ErrorShape };

export class GatewayRpcDispatcher {
  private readonly handlers = buildRpcHandlers();
  private readonly rpcRegistry: RpcRegistry = buildRpcRegistry(this.handlers);

  getMethodDescriptor(
    method: string,
  ): RpcMethodDescriptorAny | undefined {
    return this.rpcRegistry[method as RpcMethod] as
      | RpcMethodDescriptorAny
      | undefined;
  }

  async dispatch(
    gw: Gateway,
    ws: WebSocket,
    frame: Frame,
  ): Promise<RpcDispatchResult> {
    if (frame.type !== "req") {
      return { kind: "ignore" };
    }

    if (!isWsConnected(ws) && frame.method !== "connect") {
      return {
        kind: "error",
        error: { code: 101, message: "Not connected" },
      };
    }

    const attachment = ws.deserializeAttachment();
    const methodDescriptor = this.getMethodDescriptor(frame.method);

    if (!methodDescriptor) {
      return {
        kind: "error",
        error: { code: 404, message: `Unknown method: ${frame.method}` },
      };
    }

    if (!methodDescriptor.allowDisconnected && !isWsConnected(ws)) {
      return {
        kind: "error",
        error: { code: 101, message: "Not connected" },
      };
    }

    if (!isMethodAllowedForMode(methodDescriptor, attachment.mode)) {
      return {
        kind: "error",
        error: {
          code: 403,
          message: `Method ${frame.method} not allowed for mode`,
        },
      };
    }

    const methodHandler = methodDescriptor.handler as unknown as (
      ctx: {
        gw: Gateway;
        ws: WebSocket;
        frame: Frame;
        params: unknown;
      },
    ) => Promise<unknown> | unknown;

    try {
      const payload = await methodHandler({
        gw,
        ws,
        frame,
        params: frame.params,
      });
      if (payload === DEFER_RESPONSE) {
        return { kind: "deferred" };
      }
      return { kind: "ok", payload };
    } catch (error) {
      return { kind: "error", error: toErrorShape(error) };
    }
  }
}
