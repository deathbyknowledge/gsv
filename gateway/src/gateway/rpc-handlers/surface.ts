import { RpcError } from "../../shared/utils";
import { snapshot, type Proxied } from "../../shared/persisted-object";
import type { Handler } from "../../protocol/methods";
import type { Surface } from "../../protocol/surface";
import type {
  SurfaceOpenedPayload,
  SurfaceClosedPayload,
  SurfaceUpdatedPayload,
} from "../../protocol/surface";

/** Cast a PersistedObject value to Proxied for snapshot(). */
function snap(s: Surface): Surface {
  return snapshot(s as unknown as Proxied<Surface>);
}

function generateSurfaceId(): string {
  return crypto.randomUUID();
}

function getCallerClientId(ws: WebSocket): string {
  const attachment = ws.deserializeAttachment();
  if (attachment.mode === "client" && attachment.clientId) {
    return attachment.clientId;
  }
  if (attachment.mode === "node" && attachment.nodeId) {
    return attachment.nodeId;
  }
  throw new RpcError(403, "Only clients and nodes can manage surfaces");
}

export const handleSurfaceOpen: Handler<"surface.open"> = ({ gw, ws, params }) => {
  if (!params?.contentRef) {
    throw new RpcError(400, "contentRef is required");
  }

  const callerId = getCallerClientId(ws);
  const targetClientId = params.targetClientId ?? callerId;

  // Verify target exists (client or node)
  if (!gw.clients.has(targetClientId) && !gw.nodes.has(targetClientId)) {
    throw new RpcError(
      404,
      `Target client not connected: ${targetClientId}`,
    );
  }

  const now = Date.now();
  const surfaceId = generateSurfaceId();
  const surface: Surface = {
    surfaceId,
    kind: params.kind,
    label: params.label ?? params.contentRef,
    contentRef: params.contentRef,
    contentData: params.contentData,
    targetClientId,
    sourceClientId: callerId,
    state: params.state ?? "open",
    rect: params.rect,
    createdAt: now,
    updatedAt: now,
  };

  gw.surfaces[surfaceId] = surface;

  // Broadcast to other clients + targeted node (exclude sender — they get the RPC response)
  gw.broadcastSurfaceEvent<SurfaceOpenedPayload>("surface.opened", {
    surface: snap(surface),
  }, targetClientId, ws);

  console.log(
    `[Gateway] Surface opened: ${surfaceId} kind=${surface.kind} ref=${surface.contentRef} target=${targetClientId} source=${callerId}`,
  );

  return { surface: snap(surface) };
};

export const handleSurfaceClose: Handler<"surface.close"> = ({ gw, ws, params }) => {
  if (!params?.surfaceId) {
    throw new RpcError(400, "surfaceId is required");
  }

  const surface = gw.surfaces[params.surfaceId];
  if (!surface) {
    throw new RpcError(404, `Surface not found: ${params.surfaceId}`);
  }

  const targetClientId = surface.targetClientId;
  delete gw.surfaces[params.surfaceId];

  // Broadcast to other clients + targeted node (exclude sender)
  gw.broadcastSurfaceEvent<SurfaceClosedPayload>("surface.closed", {
    surfaceId: params.surfaceId,
    targetClientId,
  }, targetClientId, ws);

  console.log(`[Gateway] Surface closed: ${params.surfaceId}`);

  return { ok: true as const, surfaceId: params.surfaceId };
};

export const handleSurfaceUpdate: Handler<"surface.update"> = ({ gw, ws, params }) => {
  if (!params?.surfaceId) {
    throw new RpcError(400, "surfaceId is required");
  }

  const surface = gw.surfaces[params.surfaceId];
  if (!surface) {
    throw new RpcError(404, `Surface not found: ${params.surfaceId}`);
  }

  // Apply updates
  if (params.state !== undefined) surface.state = params.state;
  if (params.rect !== undefined) surface.rect = params.rect;
  if (params.label !== undefined) surface.label = params.label;
  if (params.zIndex !== undefined) surface.zIndex = params.zIndex;
  if (params.contentData !== undefined) surface.contentData = params.contentData;
  surface.updatedAt = Date.now();

  // The PersistedObject proxy auto-persists mutations,
  // but we explicitly re-assign to ensure the top-level key triggers a put.
  gw.surfaces[params.surfaceId] = surface;

  // Broadcast to other clients + targeted node (exclude sender)
  gw.broadcastSurfaceEvent<SurfaceUpdatedPayload>("surface.updated", {
    surface: snap(surface),
  }, surface.targetClientId, ws);

  return { surface: snap(surface) };
};

export const handleSurfaceFocus: Handler<"surface.focus"> = ({ gw, ws, params }) => {
  if (!params?.surfaceId) {
    throw new RpcError(400, "surfaceId is required");
  }

  const surface = gw.surfaces[params.surfaceId];
  if (!surface) {
    throw new RpcError(404, `Surface not found: ${params.surfaceId}`);
  }

  // Compute a zIndex higher than all current surfaces for the same target
  let maxZ = 0;
  for (const s of Object.values(gw.surfaces)) {
    if (s.targetClientId === surface.targetClientId && s.zIndex !== undefined) {
      maxZ = Math.max(maxZ, s.zIndex);
    }
  }
  surface.zIndex = maxZ + 1;
  surface.state = "open"; // un-minimize on focus
  surface.updatedAt = Date.now();
  gw.surfaces[params.surfaceId] = surface;

  gw.broadcastSurfaceEvent<SurfaceUpdatedPayload>("surface.updated", {
    surface: snap(surface),
  }, surface.targetClientId, ws);

  return { surface: snap(surface) };
};

export const handleSurfaceList: Handler<"surface.list"> = ({ gw, params }) => {
  const allSurfaces = Object.values(gw.surfaces);
  const targetFilter = params?.targetClientId;

  const filtered = targetFilter
    ? allSurfaces.filter((s) => s.targetClientId === targetFilter)
    : allSurfaces;

  return {
    surfaces: filtered.map((s) => snap(s)),
    count: filtered.length,
  };
};
