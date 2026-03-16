import { env } from "cloudflare:workers";
import { RpcError } from "../../shared/utils";
import { snapshot, type Proxied } from "../../shared/persisted-object";
import type { Handler } from "../../protocol/methods";
import { DEFER_RESPONSE } from "../../protocol/methods";
import type { Surface } from "../../protocol/surface";
import type {
  SurfaceOpenedPayload,
  SurfaceClosedPayload,
  SurfaceUpdatedPayload,
  SurfaceEvalRequestPayload,
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

  // Release browser profile lock if held
  const profileId = surface.profileId;
  if (profileId) {
    gw.releaseProfileLock(profileId, params.surfaceId);
  }

  const targetClientId = surface.targetClientId;
  delete gw.surfaces[params.surfaceId];

  // Broadcast to other clients + targeted node (exclude sender)
  gw.broadcastSurfaceEvent<SurfaceClosedPayload>("surface.closed", {
    surfaceId: params.surfaceId,
    targetClientId,
    profileId,
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

/**
 * Execute JavaScript in a webview surface.
 * This is a deferred handler — we send the eval request to the target node
 * and wait for `surface.eval.result` to come back before responding.
 */
export const handleSurfaceEval: Handler<"surface.eval"> = ({ gw, ws, frame, params }) => {
  if (!params?.surfaceId || !params?.script) {
    throw new RpcError(400, "surfaceId and script are required");
  }

  const surface = gw.surfaces[params.surfaceId];
  if (!surface) {
    throw new RpcError(404, `Surface not found: ${params.surfaceId}`);
  }

  // Only webview surfaces support eval
  if (surface.kind !== "webview") {
    throw new RpcError(400, `Surface kind "${surface.kind}" does not support eval`);
  }

  const targetClientId = surface.targetClientId;

  // Must be targeting a node (not a web client iframe)
  if (!gw.nodes.has(targetClientId)) {
    throw new RpcError(400, "Surface target is not a display node — eval requires native webview");
  }

  const targetWs = gw.nodes.get(targetClientId);
  if (!targetWs || targetWs.readyState !== WebSocket.OPEN) {
    throw new RpcError(503, `Target node "${targetClientId}" is not connected`);
  }

  const evalId = params.evalId ?? crypto.randomUUID();

  // Store the pending eval so we can send the deferred response when the result arrives
  gw.pendingEvals.set(evalId, { ws, frameId: frame.id });

  // Send the eval request to the target node as an event
  const evalPayload: SurfaceEvalRequestPayload = {
    evalId,
    surfaceId: params.surfaceId,
    script: params.script,
  };
  targetWs.send(JSON.stringify({ type: "evt", event: "surface.eval", payload: evalPayload }));

  console.log(`[Gateway] Surface eval dispatched: ${evalId} -> surface ${params.surfaceId}`);

  // Defer the response — it will be sent when surface.eval.result arrives
  return DEFER_RESPONSE;
};

/**
 * Receive the result of a surface eval from a node.
 * Routes back to Session DO (agent tool path) and/or resolves WS deferred response.
 */
export const handleSurfaceEvalResult: Handler<"surface.eval.result"> = async ({ gw, params }) => {
  if (!params?.evalId) {
    throw new RpcError(400, "evalId is required");
  }

  console.log(
    `[Gateway] surface.eval.result received: evalId=${params.evalId} ok=${params.ok} hasResult=${params.result !== undefined} result=${JSON.stringify(params.result)?.slice(0, 200)} error=${params.error}`,
  );

  // ── Agent tool path: route result back to Session DO via toolResult() ──
  const route = gw.pendingEvalRoutes[params.evalId];
  if (route && typeof route === "object" && route.sessionKey && route.callId) {
    const toolResult = params.ok
      ? { callId: route.callId, result: { evalId: params.evalId, surfaceId: params.surfaceId, value: params.result } }
      : { callId: route.callId, error: params.error || "Eval failed" };
    console.log(
      `[Gateway] Routing eval result to session ${route.sessionKey} callId=${route.callId} toolResult=${JSON.stringify(toolResult)?.slice(0, 300)}`,
    );
    try {
      const sessionStub = env.SESSION.getByName(route.sessionKey);
      await sessionStub.toolResult(toolResult);
    } catch (e) {
      console.error(`[Gateway] Failed to route eval result to session ${route.sessionKey}:`, e);
    }
    delete gw.pendingEvalRoutes[params.evalId];
  } else {
    console.log(
      `[Gateway] No agent route found for evalId=${params.evalId} (pendingEvalRoutes keys: ${Object.keys(gw.pendingEvalRoutes).join(", ")})`,
    );
  }

  // ── WS deferred path: direct WS caller → pendingEvals ──
  const pending = gw.pendingEvals.get(params.evalId);
  if (pending) {
    gw.pendingEvals.delete(params.evalId);

    // Send the deferred response to the original WS caller
    const response = {
      type: "res" as const,
      id: pending.frameId,
      ok: params.ok,
      payload: {
        evalId: params.evalId,
        surfaceId: params.surfaceId,
        ok: params.ok,
        result: params.result,
        error: params.error,
      },
    };

    if (pending.ws.readyState === WebSocket.OPEN) {
      pending.ws.send(JSON.stringify(response));
    }
  }

  return { ok: true as const };
};
