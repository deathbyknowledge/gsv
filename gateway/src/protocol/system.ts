// System events broadcast to all connected clients for operational awareness.

export type SystemNodeEvent = {
  event: "system.node";
  action: "connected" | "disconnected";
  nodeId: string;
  toolCount?: number;
  hostOs?: string;
  hostRole?: string;
};

export type SystemChannelEvent = {
  event: "system.channel";
  action: "connected" | "disconnected" | "status";
  channel: string;
  accountId: string;
  connected?: boolean;
  authenticated?: boolean;
  error?: string;
};

export type SystemToolsEvent = {
  event: "system.tools";
  action: "changed";
  nodeId: string;
  toolCount: number;
};

export type SystemEvent =
  | SystemNodeEvent
  | SystemChannelEvent
  | SystemToolsEvent;
