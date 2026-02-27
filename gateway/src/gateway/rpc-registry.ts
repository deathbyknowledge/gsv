import type { Handler, RpcMethod } from "../protocol/methods";

export type RpcAttachmentMode = "client" | "node" | "channel" | "unknown";

export type RpcMethodDescriptor<M extends RpcMethod = RpcMethod> = {
  name: M;
  handler: Handler<M>;
  /**
   * Whether this method can be called before websocket connect handshake.
   * This is currently only relevant for `connect`.
   */
  allowDisconnected?: boolean;
  /**
   * Optional origin-mode restriction.
   * Undefined means no mode restriction.
   */
  allowedModes?: readonly RpcAttachmentMode[];
  category?: string;
};

export type RpcMethodDescriptorAny = RpcMethodDescriptor<RpcMethod>;

export type RpcRegistry = {
  [M in RpcMethod]?: RpcMethodDescriptor<M>;
};

const DEFAULT_DESCRIPTOR_OVERRIDES: Partial<
  Record<RpcMethod, Partial<RpcMethodDescriptor<RpcMethod>>>
> = {
  connect: {
    allowDisconnected: true,
  },
  "tool.invoke": {
    allowedModes: ["client"],
  },
  "tool.result": {
    allowedModes: ["node"],
  },
  "tool.request": {
    allowedModes: ["client"],
  },
  "logs.get": {
    allowedModes: ["client"],
  },
  "logs.result": {
    allowedModes: ["node"],
  },
  "node.probe.result": {
    allowedModes: ["node"],
  },
  "node.exec.event": {
    allowedModes: ["node"],
  },
};

export function buildRpcRegistry(
  handlers: Partial<{ [M in RpcMethod]: Handler<M> }>,
): RpcRegistry {
  const registry: Record<string, RpcMethodDescriptorAny> = {};

  for (const rawMethod of Object.keys(handlers) as Array<RpcMethod>) {
    const handler = handlers[rawMethod];
    if (!handler) {
      continue;
    }

    registry[rawMethod] = {
      name: rawMethod,
      handler: handler as Handler<RpcMethod>,
      allowDisconnected: false,
      ...DEFAULT_DESCRIPTOR_OVERRIDES[rawMethod],
    };
  }

  return registry as RpcRegistry;
}

export function isMethodAllowedForMode(
  descriptor: RpcMethodDescriptor | undefined,
  mode: string | undefined,
): boolean {
  if (!descriptor) {
    return false;
  }
  if (!descriptor.allowedModes || descriptor.allowedModes.length === 0) {
    return true;
  }
  if (!mode) {
    return descriptor.allowedModes.includes("unknown");
  }
  return descriptor.allowedModes.includes(mode as RpcAttachmentMode);
}
