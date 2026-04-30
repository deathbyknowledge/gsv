type KernelClient = {
  request(call: string, args: Record<string, unknown>): Promise<any>;
};

type AppBinding = {
  clientId?: string;
};

const CHAT_RUNTIME_SIGNALS = [
  "process.message",
  "process.context",
  "process.lifecycle",
  "chat.tool_call",
  "chat.tool_result",
  "chat.text",
  "chat.complete",
  "chat.hil",
  "chat.error",
  "process.exit",
];

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

function buildSignalWatchKey(clientId: string, pid: string, signal: string) {
  return `chat:${clientId}:${pid}:${signal}`;
}

export async function listProfiles(kernel: KernelClient, input: unknown) {
  return kernel.request("proc.profile.list", normalizeArgs(input));
}

export async function listWorkspaces(kernel: KernelClient, input: unknown) {
  const args = normalizeArgs(input);
  return kernel.request("sys.workspace.list", {
    kind: "thread",
    ...args,
  });
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
  return kernel.request("proc.history", {
    limit: normalizeLimit(args.limit, 50),
    ...(pid ? { pid } : {}),
    ...(conversationId ? { conversationId } : {}),
    ...(typeof offset === "number" ? { offset } : {}),
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
  });
}

export async function watchProcessSignals(kernel: KernelClient, app: AppBinding | undefined, input: unknown) {
  const pid = normalizePid(normalizeArgs(input).pid);
  if (!pid) {
    throw new Error("pid is required");
  }
  const clientId = normalizeClientId(app?.clientId);
  if (!clientId) {
    throw new Error("client signal watch requires an app session");
  }
  await Promise.all(CHAT_RUNTIME_SIGNALS.map((signal) => kernel.request("signal.watch", {
    signal,
    processId: pid,
    key: buildSignalWatchKey(clientId, pid, signal),
    state: { clientId, pid },
    once: false,
  })));
  return {
    pid,
    watched: CHAT_RUNTIME_SIGNALS.length,
  };
}

export async function unwatchProcessSignals(kernel: KernelClient, app: AppBinding | undefined, input: unknown) {
  const pid = normalizePid(normalizeArgs(input).pid);
  if (!pid) {
    return { pid: "", removed: 0 };
  }
  const clientId = normalizeClientId(app?.clientId);
  if (!clientId) {
    return { pid, removed: 0 };
  }
  let removed = 0;
  await Promise.all(CHAT_RUNTIME_SIGNALS.map(async (signal) => {
    const result = await kernel.request("signal.unwatch", {
      key: buildSignalWatchKey(clientId, pid, signal),
    });
    const count = result && typeof result === "object" && "removed" in result && typeof result.removed === "number"
      ? result.removed
      : 0;
    removed += count;
  }));
  return { pid, removed };
}
