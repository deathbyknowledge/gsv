import type { PackageViewerBinding } from "@humansandmachines/gsv/sdk/backend";

type KernelClient = {
  request(call: string, args: Record<string, unknown>): Promise<any>;
};

type ViewerRuntime = {
  viewer?: PackageViewerBinding;
};

type AppBinding = {
  sessionId?: string;
  clientId?: string;
};

const CHAT_TRANSCRIPT_SIGNALS = [
  "proc.run.tool.started",
  "proc.run.tool.finished",
  "proc.run.stream",
  "proc.run.retrying",
  "proc.run.output",
];

const CHAT_CATALOG_SIGNALS = [
  "proc.changed",
  "proc.run.started",
  "proc.run.finished",
  "proc.run.hil.requested",
  "process.exit",
];

const CHAT_PROCESS_UNWATCH_SIGNALS = Array.from(new Set([
  ...CHAT_TRANSCRIPT_SIGNALS,
  ...CHAT_CATALOG_SIGNALS,
]));
function normalizeArgs(value: unknown) {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function normalizePid(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : "";
}

function normalizeClientId(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : "";
}

function normalizeLimit(value: unknown, fallback = 50) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function buildSignalWatchKey(sessionId: string, clientId: string, pid: string, signal: string) {
  return `chat:${sessionId}:${clientId}:${pid}:${signal}`;
}

function buildOwnerSignalWatchKey(sessionId: string, clientId: string, signal: string) {
  return `chat:${sessionId}:${clientId}:owner:${signal}`;
}

export async function listAgents(kernel: KernelClient, input: unknown) {
  return kernel.request("account.list", normalizeArgs(input));
}

export async function listProcesses(kernel: KernelClient, input: unknown) {
  return kernel.request("proc.list", normalizeArgs(input));
}

export async function spawnProcess(kernel: KernelClient, input: unknown) {
  return kernel.request("proc.spawn", normalizeArgs(input));
}

export async function sendMessage(kernel: KernelClient, input: unknown) {
  const args = normalizeArgs(input);
  const message = typeof args.message === "string" ? args.message : "";
  const pid = normalizePid(args.pid);
  const conversationId = typeof args.conversationId === "string" && args.conversationId.trim()
    ? args.conversationId.trim()
    : undefined;
  const media = Array.isArray(args.media) ? args.media : [];
  return kernel.request("proc.send", {
    message,
    ...(pid ? { pid } : {}),
    ...(conversationId ? { conversationId } : {}),
    ...(media.length > 0 ? { media } : {}),
  });
}

export async function getHistory(kernel: KernelClient, input: unknown) {
  const args = normalizeArgs(input);
  const pid = normalizePid(args.pid);
  const conversationId = typeof args.conversationId === "string" && args.conversationId.trim()
    ? args.conversationId.trim()
    : undefined;
  const offset = typeof args.offset === "number" && Number.isFinite(args.offset) ? Math.floor(args.offset) : undefined;
  const beforeMessageId = typeof args.beforeMessageId === "number" && Number.isFinite(args.beforeMessageId)
    ? Math.floor(args.beforeMessageId)
    : undefined;
  const afterMessageId = typeof args.afterMessageId === "number" && Number.isFinite(args.afterMessageId)
    ? Math.floor(args.afterMessageId)
    : undefined;
  return kernel.request("proc.history", {
    limit: normalizeLimit(args.limit, 50),
    ...(pid ? { pid } : {}),
    ...(conversationId ? { conversationId } : {}),
    ...(typeof offset === "number" ? { offset } : {}),
    ...(typeof beforeMessageId === "number" ? { beforeMessageId } : {}),
    ...(typeof afterMessageId === "number" ? { afterMessageId } : {}),
    ...(args.tail === true ? { tail: true } : {}),
  });
}

export async function readProcessMedia(kernel: KernelClient, input: unknown) {
  const args = normalizeArgs(input);
  const pid = normalizePid(args.pid);
  const key = typeof args.key === "string" ? args.key.trim() : "";
  const mimeType = typeof args.mimeType === "string" && args.mimeType.trim()
    ? args.mimeType.trim()
    : undefined;
  return kernel.request("proc.media.read", {
    ...(pid ? { pid } : {}),
    key,
    ...(mimeType ? { mimeType } : {}),
  });
}

export async function listConversations(kernel: KernelClient, input: unknown) {
  const args = normalizeArgs(input);
  const pid = normalizePid(args.pid);
  return kernel.request("proc.conversation.list", {
    ...(pid ? { pid } : {}),
    ...(args.includeClosed === true ? { includeClosed: true } : {}),
  });
}

export async function compactConversation(kernel: KernelClient, input: unknown) {
  const args = normalizeArgs(input);
  const pid = normalizePid(args.pid);
  const keepLast = typeof args.keepLast === "number" && Number.isFinite(args.keepLast)
    ? Math.max(0, Math.floor(args.keepLast))
    : 40;
  return kernel.request("proc.conversation.compact", {
    keepLast,
    generateSummary: true,
    ...(pid ? { pid } : {}),
    ...(typeof args.conversationId === "string" && args.conversationId.trim()
      ? { conversationId: args.conversationId.trim() }
      : {}),
  });
}

export async function listConversationSegments(kernel: KernelClient, input: unknown) {
  const args = normalizeArgs(input);
  const pid = normalizePid(args.pid);
  return kernel.request("proc.conversation.segments", {
    ...(pid ? { pid } : {}),
    ...(typeof args.conversationId === "string" && args.conversationId.trim()
      ? { conversationId: args.conversationId.trim() }
      : {}),
  });
}

export async function readConversationSegment(kernel: KernelClient, input: unknown) {
  const args = normalizeArgs(input);
  const pid = normalizePid(args.pid);
  const segmentId = typeof args.segmentId === "string" ? args.segmentId.trim() : "";
  const offset = typeof args.offset === "number" && Number.isFinite(args.offset) ? Math.max(0, Math.floor(args.offset)) : undefined;
  return kernel.request("proc.conversation.segment.read", {
    segmentId,
    limit: normalizeLimit(args.limit, 100),
    ...(pid ? { pid } : {}),
    ...(typeof args.conversationId === "string" && args.conversationId.trim()
      ? { conversationId: args.conversationId.trim() }
      : {}),
    ...(typeof offset === "number" ? { offset } : {}),
  });
}

export async function forkConversation(kernel: KernelClient, input: unknown) {
  const args = normalizeArgs(input);
  const pid = normalizePid(args.pid);
  const throughMessageId = typeof args.throughMessageId === "number" && Number.isFinite(args.throughMessageId)
    ? Math.floor(args.throughMessageId)
    : undefined;
  const targetConversationId = typeof args.targetConversationId === "string" && args.targetConversationId.trim()
    ? args.targetConversationId.trim()
    : undefined;
  const title = typeof args.title === "string" && args.title.trim()
    ? args.title.trim()
    : undefined;
  return kernel.request("proc.conversation.fork", {
    ...(pid ? { pid } : {}),
    ...(typeof args.conversationId === "string" && args.conversationId.trim()
      ? { conversationId: args.conversationId.trim() }
      : {}),
    ...(throughMessageId !== undefined ? { throughMessageId } : {}),
    ...(targetConversationId ? { targetConversationId } : {}),
    ...(title ? { title } : {}),
  });
}

export async function abortRun(kernel: KernelClient, input: unknown) {
  const pid = normalizePid(normalizeArgs(input).pid);
  return kernel.request("proc.abort", { pid });
}

export async function decideHil(kernel: KernelClient, input: unknown) {
  const args = normalizeArgs(input);
  const decision = args.decision === true
    ? "approve"
    : args.decision === false
      ? "deny"
      : typeof args.decision === "string"
        ? args.decision.trim()
        : "";
  return kernel.request("proc.hil", {
    pid: normalizePid(args.pid),
    requestId: typeof args.requestId === "string" ? args.requestId : "",
    decision,
    ...(args.remember === true ? { remember: true } : {}),
  });
}

export async function watchProcessSignals(kernel: KernelClient, app: AppBinding | undefined, input: unknown) {
  const args = normalizeArgs(input);
  const scope = args.scope === "owner" ? "owner" : "process";
  const pid = normalizePid(args.pid);
  if (scope === "process" && !pid) {
    throw new Error("pid is required");
  }
  const sessionId = normalizeClientId(app?.sessionId);
  const clientId = normalizeClientId(app?.clientId);
  if (!sessionId || !clientId) {
    throw new Error("client signal watch requires an app session");
  }
  const signals = scope === "owner" ? CHAT_CATALOG_SIGNALS : CHAT_TRANSCRIPT_SIGNALS;
  await Promise.all(signals.map((signal) => kernel.request("signal.watch", {
    signal,
    ...(scope === "process" ? { processId: pid } : {}),
    key: scope === "owner"
      ? buildOwnerSignalWatchKey(sessionId, clientId, signal)
      : buildSignalWatchKey(sessionId, clientId, pid, signal),
    owner: { appSessionId: sessionId, clientId },
    state: { appSessionId: sessionId, clientId, scope, ...(pid ? { pid } : {}) },
    once: false,
  })));
  return {
    scope,
    ...(pid ? { pid } : {}),
    watched: signals.length,
  };
}

export async function unwatchProcessSignals(kernel: KernelClient, app: AppBinding | undefined, input: unknown) {
  const args = normalizeArgs(input);
  const scope = args.scope === "owner" ? "owner" : "process";
  const pid = normalizePid(args.pid);
  if (scope === "process" && !pid) {
    return { pid: "", removed: 0 };
  }
  const sessionId = normalizeClientId(app?.sessionId);
  const clientId = normalizeClientId(app?.clientId);
  if (!sessionId || !clientId) {
    return { pid, removed: 0 };
  }
  let removed = 0;
  const signals = scope === "owner" ? CHAT_CATALOG_SIGNALS : CHAT_PROCESS_UNWATCH_SIGNALS;
  await Promise.all(signals.map(async (signal) => {
    const result = await kernel.request("signal.unwatch", {
      key: scope === "owner"
        ? buildOwnerSignalWatchKey(sessionId, clientId, signal)
        : buildSignalWatchKey(sessionId, clientId, pid, signal),
      owner: { appSessionId: sessionId, clientId },
    });
    const count = result && typeof result === "object" && "removed" in result && typeof result.removed === "number"
      ? result.removed
      : 0;
    removed += count;
  }));
  return { scope, ...(pid ? { pid } : {}), removed };
}

export function getViewer(runtime: ViewerRuntime) {
  const uid = typeof runtime.viewer?.uid === "number" ? runtime.viewer.uid : 0;
  const username = typeof runtime.viewer?.username === "string" && runtime.viewer.username.trim().length > 0
    ? runtime.viewer.username.trim()
    : uid === 0 ? "root" : "user";
  return {
    uid,
    username,
  };
}
