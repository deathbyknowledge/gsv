import { env } from "cloudflare:workers";
import { executeNativeTool, isNativeTool } from "../../agents/tools";
import { getDefaultAgentId } from "../../config/parsing";
import type {
  CanvasActionEventPayload,
  CanvasDescriptor,
  CanvasDocument,
  CanvasMode,
  CanvasPatchParams,
  CanvasViewUpdatedEventPayload,
  CanvasUpdatedEventPayload,
} from "../../protocol/canvas";
import type { Handler } from "../../protocol/methods";
import { normalizeAgentId } from "../../session/routing";
import { RpcError } from "../../shared/utils";

const CANVAS_ID_MAX_LENGTH = 96;

function notImplemented(method: string): never {
  throw new RpcError(501, `${method} is not implemented yet`);
}

function resolveAgentId(
  gw: Parameters<Handler<"canvas.list">>[0]["gw"],
  input?: string,
): string {
  if (typeof input === "string" && input.trim().length > 0) {
    return normalizeAgentId(input);
  }
  return normalizeAgentId(getDefaultAgentId(gw.getConfig()));
}

function normalizeCanvasId(input: string): string {
  const normalized = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, CANVAS_ID_MAX_LENGTH);
  if (!normalized) {
    throw new RpcError(400, "Invalid canvasId");
  }
  return normalized;
}

function resolveCanvasId(input?: string): string {
  if (typeof input === "string" && input.trim().length > 0) {
    return normalizeCanvasId(input);
  }
  return `canvas-${crypto.randomUUID().slice(0, 8)}`;
}

function resolveCanvasMode(input?: string): CanvasMode {
  if (!input) {
    return "html";
  }
  if (input !== "html" && input !== "a2ui") {
    throw new RpcError(400, "mode must be 'html' or 'a2ui'");
  }
  return input;
}

function assertRecord(
  value: unknown,
  fieldName: string,
): Record<string, unknown> {
  if (
    value === undefined ||
    value === null ||
    (typeof value === "object" && !Array.isArray(value))
  ) {
    return (value ?? {}) as Record<string, unknown>;
  }
  throw new RpcError(400, `${fieldName} must be an object`);
}

function canvasPrefix(agentId: string, canvasId: string): string {
  return `agents/${agentId}/canvases/${canvasId}`;
}

function descriptorKey(agentId: string, canvasId: string): string {
  return `${canvasPrefix(agentId, canvasId)}/descriptor.json`;
}

function specKey(agentId: string, canvasId: string): string {
  return `${canvasPrefix(agentId, canvasId)}/spec.json`;
}

function stateKey(agentId: string, canvasId: string): string {
  return `${canvasPrefix(agentId, canvasId)}/state/latest.json`;
}

function viewsPrefix(agentId: string, canvasId: string): string {
  return `${canvasPrefix(agentId, canvasId)}/views/`;
}

function viewKey(agentId: string, canvasId: string, viewId: string): string {
  return `${viewsPrefix(agentId, canvasId)}${viewId}.json`;
}

function parseJsonOrThrow<T>(text: string, key: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new RpcError(500, `Invalid JSON at ${key}`);
  }
}

async function readJsonObject<T>(
  key: string,
): Promise<{ value: T | null; exists: boolean }> {
  const object = await env.STORAGE.get(key);
  if (!object) {
    return { value: null, exists: false };
  }
  const text = await object.text();
  return { value: parseJsonOrThrow<T>(text, key), exists: true };
}

async function writeJsonObject(key: string, value: unknown): Promise<void> {
  await env.STORAGE.put(key, JSON.stringify(value), {
    httpMetadata: { contentType: "application/json" },
  });
}

async function loadCanvasDocument(
  agentId: string,
  canvasId: string,
): Promise<CanvasDocument | null> {
  const descriptorRes = await readJsonObject<CanvasDescriptor>(
    descriptorKey(agentId, canvasId),
  );
  if (!descriptorRes.exists || !descriptorRes.value) {
    return null;
  }

  const specRes = await readJsonObject<Record<string, unknown>>(
    specKey(agentId, canvasId),
  );
  const stateRes = await readJsonObject<Record<string, unknown>>(
    stateKey(agentId, canvasId),
  );

  return {
    descriptor: descriptorRes.value,
    spec: assertRecord(specRes.value, "spec"),
    state: assertRecord(stateRes.value, "state"),
  };
}

async function saveCanvasDocument(document: CanvasDocument): Promise<void> {
  const { descriptor } = document;
  await Promise.all([
    writeJsonObject(
      descriptorKey(descriptor.agentId, descriptor.canvasId),
      descriptor,
    ),
    writeJsonObject(specKey(descriptor.agentId, descriptor.canvasId), document.spec),
    writeJsonObject(
      stateKey(descriptor.agentId, descriptor.canvasId),
      document.state,
    ),
  ]);
}

function decodeJsonPointerPart(part: string): string {
  return part.replace(/~1/g, "/").replace(/~0/g, "~");
}

function parseJsonPointer(path: string): string[] {
  if (!path.startsWith("/") || path === "/") {
    throw new RpcError(400, `Invalid patch path: ${path}`);
  }
  return path
    .slice(1)
    .split("/")
    .map((part) => decodeJsonPointerPart(part));
}

function setByDotPath(
  root: Record<string, unknown>,
  path: string,
  value: unknown,
): string {
  const trimmed = path.trim();
  if (!trimmed) {
    throw new RpcError(400, "saveAs must be a non-empty path");
  }
  const segments = trimmed.split(".").map((segment) => segment.trim());
  if (segments.some((segment) => segment.length === 0)) {
    throw new RpcError(400, `Invalid saveAs path: ${path}`);
  }

  let current = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const key = segments[i];
    const next = current[key];
    if (next === undefined) {
      current[key] = {};
      current = current[key] as Record<string, unknown>;
      continue;
    }
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      current[key] = {};
      current = current[key] as Record<string, unknown>;
      continue;
    }
    current = next as Record<string, unknown>;
  }

  const leaf = segments[segments.length - 1];
  current[leaf] = value;
  return `/${segments.join("/")}`;
}

function resolvePatchParent(
  root: Record<string, unknown>,
  pointerPath: string[],
  createParents: boolean,
): { parent: Record<string, unknown>; key: string } {
  if (pointerPath.length === 0) {
    throw new RpcError(400, "Patch path cannot target root");
  }
  let current: Record<string, unknown> = root;
  for (let i = 0; i < pointerPath.length - 1; i++) {
    const segment = pointerPath[i];
    const next = current[segment];
    if (next === undefined) {
      if (!createParents) {
        throw new RpcError(400, `Patch path not found: /${pointerPath.join("/")}`);
      }
      current[segment] = {};
      current = current[segment] as Record<string, unknown>;
      continue;
    }
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      if (!createParents) {
        throw new RpcError(400, `Patch path not object: /${pointerPath.join("/")}`);
      }
      current[segment] = {};
      current = current[segment] as Record<string, unknown>;
      continue;
    }
    current = next as Record<string, unknown>;
  }
  return { parent: current, key: pointerPath[pointerPath.length - 1] };
}

function applyStatePatch(
  source: Record<string, unknown>,
  params: CanvasPatchParams,
): { state: Record<string, unknown>; changedPaths: string[] } {
  const nextState = JSON.parse(JSON.stringify(source)) as Record<string, unknown>;
  const changedPaths: string[] = [];
  for (const op of params.statePatch ?? []) {
    const pointerPath = parseJsonPointer(op.path);
    if (op.op === "add") {
      const { parent, key } = resolvePatchParent(nextState, pointerPath, true);
      parent[key] = op.value;
      changedPaths.push(op.path);
      continue;
    }
    if (op.op === "replace") {
      const { parent, key } = resolvePatchParent(nextState, pointerPath, false);
      if (!(key in parent)) {
        throw new RpcError(400, `Patch target missing for replace: ${op.path}`);
      }
      parent[key] = op.value;
      changedPaths.push(op.path);
      continue;
    }
    if (op.op === "remove") {
      const { parent, key } = resolvePatchParent(nextState, pointerPath, false);
      if (!(key in parent)) {
        throw new RpcError(400, `Patch target missing for remove: ${op.path}`);
      }
      delete parent[key];
      changedPaths.push(op.path);
      continue;
    }
    throw new RpcError(400, `Unsupported patch operation: ${String(op.op)}`);
  }
  return { state: nextState, changedPaths };
}

function resolveOwnerSessionKey(
  gw: Parameters<Handler<"canvas.list">>[0]["gw"],
  ownerSessionKey?: string | null,
): string | undefined {
  if (ownerSessionKey === null) {
    return undefined;
  }
  if (!ownerSessionKey) {
    return undefined;
  }
  return gw.canonicalizeSessionKey(ownerSessionKey);
}

function emitCanvasUpdated(
  gw: Parameters<Handler<"canvas.list">>[0]["gw"],
  document: CanvasDocument,
  changedPaths?: string[],
): void {
  const payload: CanvasUpdatedEventPayload = {
    canvasId: document.descriptor.canvasId,
    agentId: document.descriptor.agentId,
    revision: document.descriptor.revision,
    changedPaths,
    descriptor: document.descriptor,
  };
  gw.broadcastEvent("canvas.updated", payload);
}

function emitCanvasActionEvent(
  gw: Parameters<Handler<"canvas.list">>[0]["gw"],
  phase: "started" | "finished" | "failed",
  payload: CanvasActionEventPayload,
): void {
  gw.broadcastEvent(`canvas.action.${phase}`, payload);
}

function isToolAllowed(
  spec: Record<string, unknown>,
  toolName: string,
): boolean {
  const toolPolicy = spec.toolPolicy;
  if (!toolPolicy || typeof toolPolicy !== "object" || Array.isArray(toolPolicy)) {
    return true;
  }
  const allow = (toolPolicy as Record<string, unknown>).allow;
  if (!Array.isArray(allow)) {
    return true;
  }
  const allowList = allow.filter(
    (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
  );
  if (allowList.length === 0) {
    return true;
  }
  return allowList.includes(toolName);
}

type CanvasViewRecord = {
  viewId: string;
  canvasId: string;
  agentId: string;
  state: "opening" | "open" | "closed";
  target?: {
    kind: "web-client" | "node";
    id: string;
  };
  openedAt: number;
  updatedAt: number;
};

function emitCanvasViewUpdated(
  gw: Parameters<Handler<"canvas.list">>[0]["gw"],
  view: CanvasViewRecord,
): void {
  const payload: CanvasViewUpdatedEventPayload = {
    canvasId: view.canvasId,
    agentId: view.agentId,
    viewId: view.viewId,
    state: view.state,
    target: view.target,
  };
  gw.broadcastEvent("canvas.view.updated", payload);
}

async function listCanvasViews(
  agentId: string,
  canvasId: string,
): Promise<Array<{ key: string; view: CanvasViewRecord }>> {
  const prefix = viewsPrefix(agentId, canvasId);
  const keys: string[] = [];
  let cursor: string | undefined = undefined;
  do {
    const listed = await env.STORAGE.list({
      prefix,
      cursor,
      limit: 1000,
    });
    for (const object of listed.objects) {
      if (object.key.endsWith(".json")) {
        keys.push(object.key);
      }
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  const views = await Promise.all(
    keys.map(async (key) => {
      const parsed = await readJsonObject<CanvasViewRecord>(key);
      if (!parsed.value) {
        return null;
      }
      return { key, view: parsed.value };
    }),
  );

  return views.filter((item): item is { key: string; view: CanvasViewRecord } =>
    Boolean(item),
  );
}

export const handleCanvasList: Handler<"canvas.list"> = async ({ gw, params }) => {
  const agentId = resolveAgentId(gw, params?.agentId);
  const limit = Math.min(Math.max(params?.limit ?? 100, 1), 500);
  const offset = Math.max(params?.offset ?? 0, 0);
  const prefix = `agents/${agentId}/canvases/`;

  const descriptorKeys: string[] = [];
  let cursor: string | undefined = undefined;
  do {
    const listed = await env.STORAGE.list({
      prefix,
      cursor,
      limit: 1000,
    });
    for (const object of listed.objects) {
      if (object.key.endsWith("/descriptor.json")) {
        descriptorKeys.push(object.key);
      }
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  const descriptors = (
    await Promise.all(
      descriptorKeys.map(async (key) => {
        const parsed = await readJsonObject<CanvasDescriptor>(key);
        return parsed.value;
      }),
    )
  ).filter((item): item is CanvasDescriptor => Boolean(item));

  descriptors.sort((a, b) => b.updatedAt - a.updatedAt);

  return {
    canvases: descriptors.slice(offset, offset + limit),
    count: descriptors.length,
  };
};

export const handleCanvasGet: Handler<"canvas.get"> = async ({ gw, params }) => {
  if (!params?.canvasId) {
    throw new RpcError(400, "canvasId required");
  }
  const agentId = resolveAgentId(gw, params.agentId);
  const canvasId = resolveCanvasId(params.canvasId);
  const document = await loadCanvasDocument(agentId, canvasId);
  if (!document) {
    throw new RpcError(404, "Canvas not found");
  }
  return document;
};

export const handleCanvasCreate: Handler<"canvas.create"> = async ({
  gw,
  params,
}) => {
  if (!params?.title || !params.title.trim()) {
    throw new RpcError(400, "title required");
  }
  const agentId = resolveAgentId(gw, params.agentId);
  const canvasId = resolveCanvasId(params.canvasId);
  const now = Date.now();

  const existing = await env.STORAGE.head(descriptorKey(agentId, canvasId));
  if (existing) {
    throw new RpcError(409, "Canvas already exists");
  }

  const document: CanvasDocument = {
    descriptor: {
      canvasId,
      agentId,
      title: params.title.trim(),
      mode: resolveCanvasMode(params.mode),
      ownerSessionKey: resolveOwnerSessionKey(gw, params.ownerSessionKey),
      entryAsset: "assets/index.html",
      createdAt: now,
      updatedAt: now,
      revision: 1,
    },
    spec: assertRecord(params.spec, "spec"),
    state: assertRecord(params.state, "state"),
  };

  await saveCanvasDocument(document);
  emitCanvasUpdated(gw, document, ["$create"]);
  return document;
};

export const handleCanvasUpsert: Handler<"canvas.upsert"> = async ({
  gw,
  params,
}) => {
  if (!params?.canvasId) {
    throw new RpcError(400, "canvasId required");
  }

  const agentId = resolveAgentId(gw, params.agentId);
  const canvasId = resolveCanvasId(params.canvasId);
  const existing = await loadCanvasDocument(agentId, canvasId);
  const now = Date.now();

  if (!existing) {
    const created: CanvasDocument = {
      descriptor: {
        canvasId,
        agentId,
        title: params.title?.trim() || canvasId,
        mode: resolveCanvasMode(params.mode),
        ownerSessionKey: resolveOwnerSessionKey(gw, params.ownerSessionKey),
        entryAsset: "assets/index.html",
        createdAt: now,
        updatedAt: now,
        revision: 1,
      },
      spec: assertRecord(params.spec, "spec"),
      state: assertRecord(params.state, "state"),
    };
    await saveCanvasDocument(created);
    emitCanvasUpdated(gw, created, ["$create"]);
    return created;
  }

  let changed = false;
  const next: CanvasDocument = {
    descriptor: { ...existing.descriptor },
    spec: existing.spec,
    state: existing.state,
  };

  if (typeof params.title === "string") {
    const title = params.title.trim();
    if (title && title !== next.descriptor.title) {
      next.descriptor.title = title;
      changed = true;
    }
  }
  if (params.mode) {
    const mode = resolveCanvasMode(params.mode);
    if (mode !== next.descriptor.mode) {
      next.descriptor.mode = mode;
      changed = true;
    }
  }
  if (params.ownerSessionKey !== undefined) {
    const ownerSessionKey = resolveOwnerSessionKey(gw, params.ownerSessionKey);
    if (ownerSessionKey !== next.descriptor.ownerSessionKey) {
      next.descriptor.ownerSessionKey = ownerSessionKey;
      changed = true;
    }
  }
  if (params.spec !== undefined) {
    next.spec = assertRecord(params.spec, "spec");
    changed = true;
  }
  if (params.state !== undefined) {
    next.state = assertRecord(params.state, "state");
    changed = true;
  }

  if (changed) {
    next.descriptor.revision += 1;
    next.descriptor.updatedAt = now;
    await saveCanvasDocument(next);
    emitCanvasUpdated(gw, next, ["$upsert"]);
  }

  return next;
};

export const handleCanvasPatch: Handler<"canvas.patch"> = async ({
  gw,
  params,
}) => {
  if (!params?.canvasId) {
    throw new RpcError(400, "canvasId required");
  }
  const agentId = resolveAgentId(gw, params.agentId);
  const canvasId = resolveCanvasId(params.canvasId);
  const existing = await loadCanvasDocument(agentId, canvasId);
  if (!existing) {
    throw new RpcError(404, "Canvas not found");
  }

  if (
    typeof params.expectedRevision === "number" &&
    params.expectedRevision !== existing.descriptor.revision
  ) {
    throw new RpcError(
      409,
      `Revision conflict (expected ${params.expectedRevision}, current ${existing.descriptor.revision})`,
    );
  }

  let changed = false;
  let nextState = existing.state;
  const next: CanvasDocument = {
    descriptor: { ...existing.descriptor },
    spec: existing.spec,
    state: existing.state,
  };

  if (typeof params.title === "string") {
    const title = params.title.trim();
    if (title && title !== next.descriptor.title) {
      next.descriptor.title = title;
      changed = true;
    }
  }

  if (params.mode) {
    const mode = resolveCanvasMode(params.mode);
    if (mode !== next.descriptor.mode) {
      next.descriptor.mode = mode;
      changed = true;
    }
  }

  if (params.ownerSessionKey !== undefined) {
    const ownerSessionKey = resolveOwnerSessionKey(gw, params.ownerSessionKey);
    if (ownerSessionKey !== next.descriptor.ownerSessionKey) {
      next.descriptor.ownerSessionKey = ownerSessionKey;
      changed = true;
    }
  }

  if (params.spec !== undefined) {
    next.spec = assertRecord(params.spec, "spec");
    changed = true;
  }

  if (params.statePatch && params.statePatch.length > 0) {
    const patched = applyStatePatch(existing.state, params);
    nextState = patched.state;
    changed = patched.changedPaths.length > 0 || changed;
  }

  next.state = nextState;

  if (changed) {
    next.descriptor.revision += 1;
    next.descriptor.updatedAt = Date.now();
    await saveCanvasDocument(next);
    emitCanvasUpdated(gw, next, ["$patch"]);
  }

  return next;
};

export const handleCanvasDelete: Handler<"canvas.delete"> = async ({
  gw,
  params,
}) => {
  if (!params?.canvasId) {
    throw new RpcError(400, "canvasId required");
  }
  const agentId = resolveAgentId(gw, params.agentId);
  const canvasId = resolveCanvasId(params.canvasId);
  const prefix = `${canvasPrefix(agentId, canvasId)}/`;
  const existing = await loadCanvasDocument(agentId, canvasId);
  if (!existing) {
    return { ok: true, deleted: false, canvasId, agentId };
  }

  let cursor: string | undefined = undefined;
  do {
    const listed = await env.STORAGE.list({
      prefix,
      cursor,
      limit: 1000,
    });
    for (const object of listed.objects) {
      await env.STORAGE.delete(object.key);
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  emitCanvasUpdated(gw, existing, ["$deleted"]);

  return { ok: true, deleted: true, canvasId, agentId };
};

export const handleCanvasOpen: Handler<"canvas.open"> = async ({
  gw,
  params,
}) => {
  if (!params?.canvasId) {
    throw new RpcError(400, "canvasId required");
  }

  const agentId = resolveAgentId(gw, params.agentId);
  const canvasId = resolveCanvasId(params.canvasId);
  const existing = await loadCanvasDocument(agentId, canvasId);
  if (!existing) {
    throw new RpcError(404, "Canvas not found");
  }

  const now = Date.now();
  const viewId = crypto.randomUUID();
  const target = params.target ??
    (params.clientId
      ? { kind: "web-client" as const, id: params.clientId }
      : undefined);

  const view: CanvasViewRecord = {
    viewId,
    canvasId,
    agentId,
    state: "open",
    target,
    openedAt: now,
    updatedAt: now,
  };

  await writeJsonObject(viewKey(agentId, canvasId, viewId), view);
  emitCanvasViewUpdated(gw, view);

  return { ok: true, canvasId, viewId };
};

export const handleCanvasClose: Handler<"canvas.close"> = async ({
  gw,
  params,
}) => {
  if (!params?.canvasId) {
    throw new RpcError(400, "canvasId required");
  }

  const agentId = resolveAgentId(gw, params.agentId);
  const canvasId = resolveCanvasId(params.canvasId);
  const existing = await loadCanvasDocument(agentId, canvasId);
  if (!existing) {
    throw new RpcError(404, "Canvas not found");
  }

  const views = await listCanvasViews(agentId, canvasId);
  const closeTarget = params.target ??
    (params.clientId
      ? { kind: "web-client" as const, id: params.clientId }
      : undefined);

  const toClose = views.filter(({ view }) => {
    if (params.viewId) {
      return view.viewId === params.viewId;
    }
    if (closeTarget) {
      return (
        view.target?.kind === closeTarget.kind &&
        view.target?.id === closeTarget.id
      );
    }
    return true;
  });

  let closed = false;
  let closedViewId: string | undefined;
  for (const { key, view } of toClose) {
    await env.STORAGE.delete(key);
    const updated: CanvasViewRecord = {
      ...view,
      state: "closed",
      updatedAt: Date.now(),
    };
    emitCanvasViewUpdated(gw, updated);
    closed = true;
    closedViewId = closedViewId ?? updated.viewId;
  }

  return { ok: true, canvasId, viewId: closedViewId, closed };
};

export const handleCanvasAction: Handler<"canvas.action"> = async ({
  gw,
  params,
}) => {
  if (!params?.canvasId) {
    throw new RpcError(400, "canvasId required");
  }
  if (!params.actionId) {
    throw new RpcError(400, "actionId required");
  }

  const agentId = resolveAgentId(gw, params.agentId);
  const canvasId = resolveCanvasId(params.canvasId);
  const document = await loadCanvasDocument(agentId, canvasId);
  if (!document) {
    throw new RpcError(404, "Canvas not found");
  }

  if (
    typeof params.expectedRevision === "number" &&
    params.expectedRevision !== document.descriptor.revision
  ) {
    throw new RpcError(
      409,
      `Revision conflict (expected ${params.expectedRevision}, current ${document.descriptor.revision})`,
    );
  }

  const spec = assertRecord(document.spec, "spec");
  const actions = assertRecord(spec.actions, "spec.actions");
  const action = actions[params.actionId];
  if (!action || typeof action !== "object" || Array.isArray(action)) {
    throw new RpcError(404, `Unknown action: ${params.actionId}`);
  }

  const actionRecord = action as Record<string, unknown>;
  const kind =
    typeof actionRecord.kind === "string" ? actionRecord.kind.trim() : "";
  if (!kind) {
    throw new RpcError(400, `Action '${params.actionId}' is missing kind`);
  }

  const eventId = crypto.randomUUID();
  emitCanvasActionEvent(gw, "started", {
    canvasId,
    agentId,
    actionId: params.actionId,
    eventId,
    revision: document.descriptor.revision,
  });

  try {
    if (kind === "state.patch") {
      const patchValue = actionRecord.patch;
      if (!Array.isArray(patchValue)) {
        throw new RpcError(
          400,
          `Action '${params.actionId}' has invalid state.patch payload`,
        );
      }

      const patchParams: CanvasPatchParams = {
        canvasId,
        agentId,
        statePatch: patchValue as CanvasPatchParams["statePatch"],
      };
      const patched = applyStatePatch(document.state, patchParams);
      document.state = patched.state;
      document.descriptor.revision += 1;
      document.descriptor.updatedAt = Date.now();
      await saveCanvasDocument(document);

      emitCanvasUpdated(gw, document, patched.changedPaths);
      emitCanvasActionEvent(gw, "finished", {
        canvasId,
        agentId,
        actionId: params.actionId,
        eventId,
        revision: document.descriptor.revision,
      });

      return {
        ok: true,
        eventId,
        status: "finished",
        revision: document.descriptor.revision,
      };
    }

    if (kind === "session.send") {
      const message =
        typeof actionRecord.message === "string"
          ? actionRecord.message.trim()
          : "";
      if (!message) {
        throw new RpcError(
          400,
          `Action '${params.actionId}' is missing session message`,
        );
      }

      const rawSessionKey =
        typeof actionRecord.sessionKey === "string" &&
        actionRecord.sessionKey.trim().length > 0
          ? actionRecord.sessionKey.trim()
          : document.descriptor.ownerSessionKey;
      if (!rawSessionKey) {
        throw new RpcError(
          400,
          `Action '${params.actionId}' requires sessionKey or ownerSessionKey`,
        );
      }
      const sessionKey = gw.canonicalizeSessionKey(rawSessionKey);
      const runId = crypto.randomUUID();
      const session = env.SESSION.getByName(sessionKey);
      await session.chatSend(
        message,
        runId,
        JSON.parse(JSON.stringify(gw.getAllTools())),
        JSON.parse(JSON.stringify(gw.getRuntimeNodeInventory())),
        sessionKey,
      );

      emitCanvasActionEvent(gw, "finished", {
        canvasId,
        agentId,
        actionId: params.actionId,
        eventId,
        revision: document.descriptor.revision,
      });

      return {
        ok: true,
        eventId,
        status: "started",
        revision: document.descriptor.revision,
      };
    }

    if (kind === "tool.call") {
      const toolName =
        typeof actionRecord.tool === "string" ? actionRecord.tool.trim() : "";
      if (!toolName) {
        throw new RpcError(400, `Action '${params.actionId}' is missing tool`);
      }
      if (!isToolAllowed(spec, toolName)) {
        throw new RpcError(403, `Tool '${toolName}' is not allowed by policy`);
      }

      const args = assertRecord(actionRecord.args, "action.args");
      let toolResult: unknown;
      if (isNativeTool(toolName)) {
        const nativeResult = await executeNativeTool(
          {
            bucket: env.STORAGE,
            agentId,
            gateway: env.GATEWAY.getByName("singleton"),
          },
          toolName,
          args,
        );
        if (!nativeResult.ok) {
          throw new RpcError(
            500,
            nativeResult.error || `Tool '${toolName}' failed`,
          );
        }
        toolResult = nativeResult.result ?? null;
      } else {
        try {
          toolResult = await gw.executeToolOnce({
            tool: toolName,
            args,
            timeoutMs:
              typeof actionRecord.timeoutMs === "number" &&
              Number.isFinite(actionRecord.timeoutMs)
                ? Math.floor(actionRecord.timeoutMs)
                : undefined,
          });
        } catch (error) {
          throw new RpcError(
            500,
            error instanceof Error
              ? error.message
              : `Tool '${toolName}' failed`,
          );
        }
      }

      let changedPath: string | undefined;
      if (typeof actionRecord.saveAs === "string" && actionRecord.saveAs.trim()) {
        changedPath = setByDotPath(
          document.state,
          actionRecord.saveAs,
          toolResult ?? null,
        );
        document.descriptor.revision += 1;
        document.descriptor.updatedAt = Date.now();
        await saveCanvasDocument(document);
        emitCanvasUpdated(
          gw,
          document,
          changedPath ? [changedPath] : undefined,
        );
      }

      emitCanvasActionEvent(gw, "finished", {
        canvasId,
        agentId,
        actionId: params.actionId,
        eventId,
        revision: document.descriptor.revision,
      });

      return {
        ok: true,
        eventId,
        status: "finished",
        revision: document.descriptor.revision,
      };
    }

    throw new RpcError(400, `Unsupported action kind: ${kind}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitCanvasActionEvent(gw, "failed", {
      canvasId,
      agentId,
      actionId: params.actionId,
      eventId,
      revision: document.descriptor.revision,
      error: message,
    });
    throw error;
  }
};
