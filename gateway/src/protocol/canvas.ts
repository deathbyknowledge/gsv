export type CanvasMode = "html" | "a2ui";

export type CanvasDescriptor = {
  canvasId: string;
  agentId: string;
  title: string;
  mode: CanvasMode;
  ownerSessionKey?: string;
  entryAsset?: string;
  createdAt: number;
  updatedAt: number;
  revision: number;
};

export type CanvasDocument = {
  descriptor: CanvasDescriptor;
  spec: Record<string, unknown>;
  state: Record<string, unknown>;
};

export type CanvasListParams = {
  agentId?: string;
  limit?: number;
  offset?: number;
};

export type CanvasListResult = {
  canvases: CanvasDescriptor[];
  count: number;
};

export type CanvasGetParams = {
  canvasId: string;
  agentId?: string;
};

export type CanvasCreateParams = {
  agentId?: string;
  canvasId?: string;
  title: string;
  mode?: CanvasMode;
  ownerSessionKey?: string;
  spec?: Record<string, unknown>;
  state?: Record<string, unknown>;
};

export type CanvasUpsertParams = {
  agentId?: string;
  canvasId: string;
  title?: string;
  mode?: CanvasMode;
  ownerSessionKey?: string;
  spec?: Record<string, unknown>;
  state?: Record<string, unknown>;
};

export type CanvasPatchParams = {
  canvasId: string;
  agentId?: string;
  expectedRevision?: number;
  title?: string;
  mode?: CanvasMode;
  ownerSessionKey?: string | null;
  spec?: Record<string, unknown>;
  statePatch?: Array<{
    op: "add" | "replace" | "remove";
    path: string;
    value?: unknown;
  }>;
};

export type CanvasDeleteParams = {
  canvasId: string;
  agentId?: string;
};

export type CanvasOpenParams = {
  canvasId: string;
  agentId?: string;
  clientId?: string;
  target?: {
    kind: "web-client" | "node";
    id: string;
  };
};

export type CanvasCloseParams = {
  canvasId: string;
  agentId?: string;
  viewId?: string;
  clientId?: string;
  target?: {
    kind: "web-client" | "node";
    id: string;
  };
};

export type CanvasActionParams = {
  canvasId: string;
  agentId?: string;
  actionId: string;
  input?: Record<string, unknown>;
  expectedRevision?: number;
};

export type CanvasActionResult = {
  ok: true;
  eventId: string;
  status: "started" | "finished";
  revision?: number;
};

export type CanvasUpdatedEventPayload = {
  canvasId: string;
  agentId: string;
  revision: number;
  changedPaths?: string[];
  descriptor?: CanvasDescriptor;
};

export type CanvasViewUpdatedEventPayload = {
  canvasId: string;
  agentId: string;
  viewId: string;
  state: "opening" | "open" | "closed";
  target?: {
    kind: "web-client" | "node";
    id: string;
  };
};

export type CanvasActionEventPayload = {
  canvasId: string;
  agentId: string;
  actionId: string;
  eventId: string;
  revision?: number;
  error?: string;
};
