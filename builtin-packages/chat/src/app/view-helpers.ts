import DOMPurify from "dompurify";
import { parse as parseMarkdown } from "marked";
import type {
  Attachment,
  ContextState,
  ConversationRecord,
  ConversationSegment,
  HilRequest,
  InteractionOrigin,
  LogRow,
  MessageRow,
  PendingAssistantState,
  Profile,
  ThreadContext,
  ToolRow,
  WorkspaceEntry,
} from "./types";

const ACTIVE_THREAD_CONTEXT_KEY = "gsv.activeThreadContext.v1";

function flattenHistory(messages: unknown[]): LogRow[] {
  const rows: LogRow[] = [];
  for (const entry of messages) {
    const record = asRecord(entry);
    const timestamp = normalizeTimestampMs(record?.timestamp) || Date.now();
    const messageId = asNumber(record?.id);
    const origin = normalizeInteractionOrigin(record?.origin);
    if (record?.role === "assistant") {
      const parsed = extractAssistantHistory(record.content);
      if ((parsed.text && parsed.text.trim()) || parsed.thinking.length > 0) {
        rows.push({ kind: "message", role: "assistant", text: parsed.text, thinking: parsed.thinking, timestamp, messageId, origin });
      }
      for (const toolCall of parsed.toolCalls) {
        rows.push({
          kind: "toolCall",
          toolName: toolCall.toolName,
          callId: toolCall.callId,
          args: toolCall.args,
          syscall: toolCall.syscall,
          timestamp,
        });
      }
      continue;
    }
    if (record?.role === "toolResult") {
      const parsed = extractToolResultHistory(record.content);
      if (parsed) {
        const callId = parsed.callId ?? "tool-result";
        const priorCallIndex = rows.findIndex((row) => row.kind === "toolCall" && row.callId === callId);
        if (priorCallIndex >= 0) {
          const prior = rows[priorCallIndex] as ToolRow;
          rows[priorCallIndex] = {
            kind: "toolResult",
            toolName: parsed.toolName,
            callId,
            args: prior.args,
            syscall: parsed.syscall ?? prior.syscall,
            output: parsed.output,
            ok: parsed.ok,
            error: parsed.error,
            timestamp,
          };
        } else {
          rows.push({
            kind: "toolResult",
            toolName: parsed.toolName,
            callId,
            args: {},
            syscall: parsed.syscall,
            output: parsed.output,
            ok: parsed.ok,
            error: parsed.error,
            timestamp,
          });
        }
      } else {
        rows.push({ kind: "message", role: "system", text: formatMessageContent(record.content), timestamp, messageId, origin });
      }
      continue;
    }
    const role = record?.role === "user" ? "user" : record?.role === "assistant" ? "assistant" : "system";
    const contentRecord = asRecord(record?.content);
    const media = Array.isArray(contentRecord?.media) ? contentRecord.media : [];
    const text = contentRecord && "text" in contentRecord
      ? asString(contentRecord.text) ?? ""
      : formatMessageContent(record?.content);
    rows.push({ kind: "message", role, text, media, timestamp, messageId, origin });
  }
  return rows.length > 0 ? rows : systemRows("No messages yet. Send your first prompt.");
}

function applyProcessMessageSignal(
  payload: unknown,
  active: ThreadContext,
  setRows: (update: (current: LogRow[]) => LogRow[]) => void,
  setPendingAssistant: (value: PendingAssistantState) => void,
) {
  const record = asRecord(payload);
  if (!signalMatchesActiveThread(record, active)) return;
  const content = asString(record?.content) ?? "";
  if (!content.trim()) return;
  const messageId = asNumber(record?.messageId);
  setRows((current) => {
    if (messageId && current.some((row) => row.kind === "message" && row.messageId === messageId)) {
      return current;
    }
    const role = record?.role === "user" || record?.role === "assistant" ? record.role : "system";
    return dropEmptyPlaceholder(current).concat({
      kind: "message",
      role,
      text: formatMessageContent(content),
      timestamp: asNumber(record?.timestamp) || Date.now(),
      messageId: messageId ?? null,
      origin: normalizeInteractionOrigin(record?.origin),
    });
  });
  setPendingAssistant("thinking");
}

function applyAssistantSignal(payload: unknown, active: ThreadContext, setRows: (update: (current: LogRow[]) => LogRow[]) => void) {
  const record = asRecord(payload);
  if (!signalMatchesActiveThread(record, active)) return;
  const text = asString(record?.text) ?? "";
  const thinking = extractThinkingBlocks(record);
  if (!text.trim() && thinking.length === 0) return;
  const runId = asString(record?.runId);
  setRows((current) => {
    const next = current.slice();
    const last = next[next.length - 1];
    const row: MessageRow = { kind: "message", role: "assistant", text, thinking, timestamp: Date.now(), runId };
    if (last?.kind === "message" && last.role === "assistant" && runId && last.runId === runId) {
      next[next.length - 1] = row;
    } else {
      next.push(row);
    }
    return dropEmptyPlaceholder(next);
  });
}

function applyToolCallSignal(payload: unknown, active: ThreadContext, setRows: (update: (current: LogRow[]) => LogRow[]) => void) {
  const record = asRecord(payload);
  if (!signalMatchesActiveThread(record, active)) return;
  const callId = asString(record?.callId);
  if (!callId) return;
  const row: ToolRow = {
    kind: "toolCall",
    toolName: asString(record?.name) || "Tool",
    callId,
    args: record?.args ?? {},
    syscall: asString(record?.syscall),
    timestamp: Date.now(),
    runId: asString(record?.runId),
  };
  setRows((current) => upsertToolRow(current, row));
}

function applyToolResultSignal(payload: unknown, active: ThreadContext, setRows: (update: (current: LogRow[]) => LogRow[]) => void) {
  const record = asRecord(payload);
  if (!signalMatchesActiveThread(record, active)) return;
  const callId = asString(record?.callId);
  if (!callId) return;
  setRows((current) => {
    const existing = findToolRow(current, callId);
    const row: ToolRow = {
      kind: "toolResult",
      toolName: asString(record?.name) || existing?.toolName || "Tool",
      callId,
      args: existing?.args ?? {},
      syscall: asString(record?.syscall) ?? existing?.syscall,
      output: record?.output,
      ok: asBoolean(record?.ok) !== false,
      error: asString(record?.error),
      timestamp: Date.now(),
      runId: asString(record?.runId) ?? existing?.runId,
    };
    return upsertToolRow(current, row);
  });
}

function upsertToolRow(rows: LogRow[], nextRow: ToolRow): LogRow[] {
  const next = dropEmptyPlaceholder(rows).slice();
  const index = next.findIndex((row) => (row.kind === "toolCall" || row.kind === "toolResult") && row.callId === nextRow.callId);
  if (index >= 0) {
    const prior = next[index] as ToolRow;
    next[index] = { ...nextRow, args: nextRow.args ?? prior.args, syscall: nextRow.syscall ?? prior.syscall, runId: nextRow.runId ?? prior.runId };
  } else {
    next.push(nextRow);
  }
  return next;
}

function findToolRow(rows: LogRow[], callId: string): ToolRow | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if ((row.kind === "toolCall" || row.kind === "toolResult") && row.callId === callId) {
      return row;
    }
  }
  return null;
}

function signalMatchesActiveThread(payload: unknown, active: ThreadContext): boolean {
  const record = asRecord(payload);
  if (!record) return false;
  const pid = asString(record.pid);
  if (pid && pid !== active.pid) return false;
  const conversationId = asString(record.conversationId) || "default";
  return conversationId === (active.conversationId || "default");
}

function normalizeContextSignal(payload: unknown, active: ThreadContext): ContextState | null {
  const record = asRecord(payload);
  const pid = asString(record?.pid);
  if (pid && pid !== active.pid) return null;
  const next = normalizeContextState(record?.context ?? record);
  if (!next || next.conversationId !== active.conversationId) return null;
  return next;
}

function normalizeInteractionOrigin(value: unknown): InteractionOrigin | undefined {
  const record = asRecord(value);
  const kind = asString(record?.kind);
  if (kind === "client") {
    const connectionId = requiredText(record?.connectionId);
    if (!connectionId) return undefined;
    const clientId = optionalText(record?.clientId);
    const platform = optionalText(record?.platform);
    return {
      kind,
      connectionId,
      ...(clientId ? { clientId } : {}),
      ...(platform ? { platform } : {}),
    };
  }
  if (kind === "app") {
    const packageId = requiredText(record?.packageId);
    const packageName = requiredText(record?.packageName);
    const entrypointName = requiredText(record?.entrypointName);
    const routeBase = requiredText(record?.routeBase);
    if (!packageId || !packageName || !entrypointName || !routeBase) return undefined;
    return { kind, packageId, packageName, entrypointName, routeBase };
  }
  if (kind === "adapter") {
    const adapter = requiredText(record?.adapter);
    const accountId = requiredText(record?.accountId);
    const actorId = requiredText(record?.actorId);
    const surface = normalizeAdapterSurface(record?.surface);
    if (!adapter || !accountId || !actorId || !surface) return undefined;
    const actorLabel = optionalText(record?.actorLabel);
    const messageId = optionalText(record?.messageId);
    return {
      kind,
      adapter,
      accountId,
      surface,
      actorId,
      ...(actorLabel ? { actorLabel } : {}),
      ...(messageId ? { messageId } : {}),
    };
  }
  if (kind === "device") {
    const deviceId = requiredText(record?.deviceId);
    if (!deviceId) return undefined;
    const cwd = optionalText(record?.cwd);
    return { kind, deviceId, ...(cwd ? { cwd } : {}) };
  }
  if (kind === "process") {
    const sourcePid = requiredText(record?.sourcePid);
    if (!sourcePid) return undefined;
    const uid = asNumber(record?.uid);
    return { kind, sourcePid, ...(uid !== null ? { uid } : {}) };
  }
  if (kind === "scheduler") {
    const scheduleId = requiredText(record?.scheduleId);
    if (!scheduleId) return undefined;
    return { kind, scheduleId };
  }
  return undefined;
}

function normalizeAdapterSurface(value: unknown): Extract<InteractionOrigin, { kind: "adapter" }>["surface"] | null {
  const record = asRecord(value);
  const kind = asString(record?.kind);
  const id = requiredText(record?.id);
  if (!id || (kind !== "dm" && kind !== "group" && kind !== "channel" && kind !== "thread")) {
    return null;
  }
  const name = optionalText(record?.name);
  const handle = optionalText(record?.handle);
  const threadId = optionalText(record?.threadId);
  return {
    kind,
    id,
    ...(name ? { name } : {}),
    ...(handle ? { handle } : {}),
    ...(threadId ? { threadId } : {}),
  };
}

function formatInteractionOriginLabel(origin: InteractionOrigin | undefined): string | null {
  if (!origin) return null;
  if (origin.kind === "app") {
    if (origin.packageId === "chat" || origin.routeBase === "/apps/chat") {
      return null;
    }
    return `via ${origin.packageName}`;
  }
  if (origin.kind === "adapter") {
    const adapter = titleCase(origin.adapter);
    const surface = formatAdapterSurfaceLabel(origin.surface);
    const actor = origin.actorLabel || origin.actorId;
    return [`via ${adapter}`, surface, actor ? `from ${actor}` : ""].filter(Boolean).join(" ");
  }
  if (origin.kind === "client") {
    return `via ${origin.platform || "client"}${origin.clientId ? ` ${origin.clientId}` : ""}`;
  }
  if (origin.kind === "device") {
    return `via ${origin.deviceId}`;
  }
  if (origin.kind === "process") {
    return `from ${origin.sourcePid}`;
  }
  if (origin.kind === "scheduler") {
    return `from schedule ${origin.scheduleId}`;
  }
  return null;
}

function formatAdapterSurfaceLabel(surface: Extract<InteractionOrigin, { kind: "adapter" }>["surface"]): string {
  const label = surface.name || surface.handle || "";
  if (surface.kind === "dm") {
    return "DM";
  }
  if (surface.kind === "thread") {
    return [label || "thread", surface.threadId ? `#${surface.threadId}` : ""].filter(Boolean).join(" ");
  }
  return label || surface.kind;
}

function extractAssistantHistory(content: unknown): { text: string; thinking: string[]; toolCalls: Array<{ toolName: string; callId: string; args: unknown; syscall: string | null }> } {
  const record = asRecord(content);
  if (!record) {
    return { text: typeof content === "string" ? content : formatMessageContent(content), thinking: [], toolCalls: [] };
  }
  const text = asString(record.text) || "";
  const thinking = (Array.isArray(record.thinking) ? record.thinking : [])
    .map((item) => {
      const block = asRecord(item);
      return asString(block?.thinking) || asString(block?.text) || (typeof item === "string" ? item : "");
    })
    .map((item) => item.trim())
    .filter(Boolean);
  const toolCalls = (Array.isArray(record.toolCalls) ? record.toolCalls : [])
    .map((item, index) => {
      const call = asRecord(item);
      if (!call) return null;
      const toolName = asString(call.name) || "tool";
      const callId = asString(call.id) || asString(call.callId) || `hist-call-${index}`;
      return { toolName, callId, args: call.arguments ?? call.args ?? {}, syscall: inferToolSyscall(toolName, asString(call.syscall)) };
    })
    .filter(Boolean) as Array<{ toolName: string; callId: string; args: unknown; syscall: string | null }>;
  return { text, thinking, toolCalls };
}

function extractToolResultHistory(content: unknown) {
  const record = asRecord(content);
  const toolName = asString(record?.toolName) || asString(record?.name);
  if (!toolName) return null;
  return {
    toolName,
    callId: asString(record?.toolCallId) || asString(record?.callId) || asString(record?.id),
    ok: record?.ok === true || record?.isError !== true,
    output: record?.output,
    error: asString(record?.error),
    syscall: inferToolSyscall(toolName, asString(record?.syscall)),
  };
}

function extractThinkingBlocks(value: unknown): string[] {
  const record = asRecord(value);
  const raw = Array.isArray(record?.thinking) ? record.thinking : [];
  return raw
    .map((item) => {
      if (typeof item === "string") return item.trim();
      const block = asRecord(item);
      return (asString(block?.thinking) || asString(block?.text) || "").trim();
    })
    .filter(Boolean);
}

async function readAttachmentFile(file: File): Promise<Attachment> {
  const data = await readBlobAsDataUrl(file);
  return {
    type: inferAttachmentKind(file.type, file.name),
    mimeType: file.type || "application/octet-stream",
    data,
    filename: file.name || undefined,
    size: typeof file.size === "number" ? file.size : undefined,
  };
}

async function readAttachmentBlob(blob: Blob, filename: string, duration?: number): Promise<Attachment> {
  const data = await readBlobAsDataUrl(blob);
  const roundedDuration = typeof duration === "number" && Number.isFinite(duration) && duration > 0
    ? Math.round(duration * 10) / 10
    : undefined;
  return {
    type: inferAttachmentKind(blob.type, filename),
    mimeType: blob.type || "application/octet-stream",
    data,
    filename: filename || undefined,
    size: typeof blob.size === "number" ? blob.size : undefined,
    duration: roundedDuration,
  };
}

async function readBlobAsDataUrl(blob: Blob): Promise<string> {
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error("Failed to read file"));
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.readAsDataURL(blob);
  });
  return data;
}

function inferAttachmentKind(mimeType: string, filename: string): string {
  const normalized = safeText(mimeType).split(";")[0].trim().toLowerCase();
  if (normalized.startsWith("image/")) return "image";
  if (normalized.startsWith("audio/")) return "audio";
  if (normalized.startsWith("video/")) return "video";
  const lowerName = safeText(filename).toLowerCase();
  if (/\.(png|jpg|jpeg|gif|webp)$/.test(lowerName)) return "image";
  if (/\.(mp3|wav|ogg|m4a)$/.test(lowerName)) return "audio";
  if (/\.(mp4|mov|webm)$/.test(lowerName)) return "video";
  return "document";
}

function renderMarkdownHtml(value: string): string {
  try {
    const html = parseMarkdown(value, { async: false, breaks: true, gfm: true });
    return DOMPurify.sanitize(html);
  } catch {
    return escapeHtml(value);
  }
}

function normalizeProfile(value: unknown): Profile | null {
  const record = asRecord(value);
  const id = asString(record?.id);
  if (!id) return null;
  return {
    id,
    alias: asString(record?.alias) || undefined,
    displayName: asString(record?.displayName) || id,
    description: asString(record?.description) || "",
    kind: asString(record?.kind) || "system",
    interactive: record?.interactive === true,
    startable: record?.startable === true,
    background: record?.background === true,
    spawnMode: asString(record?.spawnMode) || "new",
  };
}

function normalizeWorkspace(value: unknown): WorkspaceEntry | null {
  const record = asRecord(value);
  const workspaceId = asString(record?.workspaceId);
  if (!workspaceId) return null;
  const activeProcessRecord = asRecord(record?.activeProcess);
  return {
    workspaceId,
    label: asString(record?.label) || undefined,
    updatedAt: normalizeTimestampMs(record?.updatedAt) || Date.now(),
    processCount: asNumber(record?.processCount) ?? undefined,
    activeProcess: activeProcessRecord && asString(activeProcessRecord.pid)
      ? { pid: asString(activeProcessRecord.pid) as string, cwd: asString(activeProcessRecord.cwd) || "" }
      : null,
  };
}

function normalizeConversation(value: unknown): ConversationRecord | null {
  const record = asRecord(value);
  const id = asString(record?.id);
  if (!id) return null;
  return {
    id,
    generation: asNumber(record?.generation) || 0,
    status: asString(record?.status) || "open",
    title: asString(record?.title),
    messageCount: asNumber(record?.messageCount) || 0,
    createdAt: normalizeTimestampMs(record?.createdAt) || Date.now(),
    updatedAt: normalizeTimestampMs(record?.updatedAt) || Date.now(),
  };
}

function normalizeConversationSegment(value: unknown): ConversationSegment | null {
  const record = asRecord(value);
  const id = asString(record?.id);
  if (!id) return null;
  return {
    id,
    generation: asNumber(record?.generation) || 0,
    fromMessageId: asNumber(record?.fromMessageId) || 0,
    toMessageId: asNumber(record?.toMessageId) || 0,
    archivePath: asString(record?.archivePath) || "",
    summaryMessageId: asNumber(record?.summaryMessageId),
    createdAt: normalizeTimestampMs(record?.createdAt) || Date.now(),
  };
}

function normalizeHilRequest(value: unknown): HilRequest | null {
  const record = asRecord(value);
  const requestId = asString(record?.requestId);
  const runId = asString(record?.runId);
  const conversationId = asString(record?.conversationId) || "default";
  const callId = asString(record?.callId);
  const toolName = asString(record?.toolName);
  const syscall = asString(record?.syscall);
  if (!requestId || !runId || !callId || !toolName || !syscall) return null;
  return { requestId, runId, conversationId, callId, toolName, syscall, args: record?.args ?? {}, createdAt: asNumber(record?.createdAt) || Date.now() };
}

function normalizeContextState(value: unknown): ContextState | null {
  const record = asRecord(value);
  if (!record) return null;
  const level = record.level === "ok" || record.level === "warn" || record.level === "critical" || record.level === "full" || record.level === "unknown"
    ? record.level
    : "unknown";
  return {
    conversationId: asString(record.conversationId) || "default",
    runId: asString(record.runId) || undefined,
    messageCount: asNumber(record.messageCount) ?? undefined,
    lastMessageId: asNumber(record.lastMessageId),
    provider: asString(record.provider),
    model: asString(record.model),
    contextWindowTokens: normalizePositiveNumber(record.contextWindowTokens),
    maxOutputTokens: normalizePositiveNumber(record.maxOutputTokens) || 0,
    estimatedInputTokens: normalizePositiveNumber(record.estimatedInputTokens) || 0,
    inputTokens: normalizePositiveNumber(record.inputTokens) || 0,
    outputTokens: normalizePositiveNumber(record.outputTokens),
    totalTokens: normalizePositiveNumber(record.totalTokens),
    availableInputTokens: normalizePositiveNumber(record.availableInputTokens),
    pressure: typeof record.pressure === "number" && Number.isFinite(record.pressure) && record.pressure >= 0 ? record.pressure : null,
    level,
    source: record.source === "provider" ? "provider" : "estimate",
    updatedAt: normalizeTimestampMs(record.updatedAt) || Date.now(),
  };
}

function normalizeThreadContext(value: unknown): ThreadContext | null {
  const record = asRecord(value);
  const pid = asString(record?.pid)?.trim() || "";
  const cwd = asString(record?.cwd)?.trim() || "";
  if (!pid || !cwd) return null;
  const conversationId = asString(record?.conversationId)?.trim() || "default";
  return {
    pid,
    cwd,
    workspaceId: asString(record?.workspaceId),
    conversationId,
    conversationTitle: asString(record?.conversationTitle),
  };
}

function getStoredThreadContext(): ThreadContext | null {
  try {
    const raw = window.localStorage.getItem(ACTIVE_THREAD_CONTEXT_KEY);
    return raw ? normalizeThreadContext(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function setStoredThreadContext(context: ThreadContext | null): ThreadContext | null {
  const normalized = normalizeThreadContext(context);
  try {
    if (normalized) {
      window.localStorage.setItem(ACTIVE_THREAD_CONTEXT_KEY, JSON.stringify(normalized));
    } else {
      window.localStorage.removeItem(ACTIVE_THREAD_CONTEXT_KEY);
    }
  } catch {}
  return normalized;
}

function fallbackProfiles(): Profile[] {
  return [
    { id: "init", alias: "personal", displayName: "Personal Agent", description: "Persistent personal conversation.", kind: "system", interactive: true, startable: true, background: false, spawnMode: "singleton" },
    { id: "task", displayName: "Worker", description: "Focused delegated worker.", kind: "system", interactive: true, startable: true, background: false, spawnMode: "new" },
    { id: "review", displayName: "Review", description: "Review conversation.", kind: "system", interactive: true, startable: true, background: false, spawnMode: "new" },
    { id: "mcp", displayName: "Master Control", description: "Operational control-plane work.", kind: "system", interactive: true, startable: true, background: false, spawnMode: "new" },
  ];
}

function titleForActive(active: ThreadContext, conversation: ConversationRecord | null, threads: WorkspaceEntry[]): string {
  if (active.pid.startsWith("init:")) {
    return active.conversationId === "default" ? "Personal Agent" : active.conversationTitle || conversation?.title || "Personal Branch";
  }
  if (active.conversationId !== "default") {
    return active.conversationTitle || conversation?.title || "Conversation Branch";
  }
  const entry = active.workspaceId ? threads.find((thread) => thread.workspaceId === active.workspaceId) : null;
  return entry ? displayThreadLabel(entry) : "Conversation";
}

function activeMeta(active: ThreadContext, conversation: ConversationRecord | null): string {
  if (active.conversationId !== "default") {
    return `${conversation?.title || active.conversationTitle || active.conversationId} - ${active.cwd}`;
  }
  return active.pid.startsWith("init:") ? "Persistent personal conversation" : active.cwd;
}

function draftConversationTitle(profile: Profile): string {
  if (!profile || profile.id === "init") return "Personal Agent";
  return profile.id === "task" ? "New Worker" : `New ${profile.displayName}`;
}

function draftConversationMeta(profile: Profile): string {
  if (!profile || profile.id === "init") {
    return "Send a message to your Personal Agent.";
  }
  return profile.id === "task"
    ? "Send a message to start a bounded worker."
    : `Send a message to start ${profile.displayName.toLowerCase()}.`;
}

function getStatusText(args: {
  active: ThreadContext | null;
  draftProfile: Profile;
  hostError: string;
  pendingAssistant: PendingAssistantState;
  pendingHil: HilRequest | null;
  messageBusy: boolean;
  abortBusy: boolean;
  hilBusy: boolean;
}): string {
  if (args.hostError) return args.hostError;
  if (args.hilBusy) return "Applying confirmation...";
  if (args.pendingHil) return "Tool confirmation is required before the run can continue.";
  if (args.abortBusy) return "Stopping active run...";
  if (args.messageBusy) return "Run in progress. Responses will refresh as signals arrive.";
  if (args.pendingAssistant) return "Run active. Send to queue another message or stop it.";
  if (args.active) return "Ready";
  return draftConversationMeta(args.draftProfile);
}

function sortConversations(conversations: ConversationRecord[]): ConversationRecord[] {
  return [...conversations].sort((left, right) => {
    if (left.id === "default") return -1;
    if (right.id === "default") return 1;
    return right.updatedAt - left.updatedAt;
  });
}

function displayThreadLabel(entry: WorkspaceEntry): string {
  const label = entry.label?.trim() || entry.workspaceId;
  return label.length > 76 ? label.slice(0, 73) + "..." : label;
}

function deriveThreadLabel(message: string): string | undefined {
  const firstLine = message.split("\n").map((line) => line.trim()).find(Boolean);
  if (!firstLine) return undefined;
  return firstLine.length > 72 ? firstLine.slice(0, 69) + "..." : firstLine;
}

function labelForRole(role: string, userLabel = "You"): string {
  if (role === "user") return userLabel.trim() || "You";
  if (role === "assistant") return "Assistant";
  return "System";
}

function suggestKeepLast(messageCount: number, context: ContextState | null): number {
  if (context?.level === "full" || context?.level === "critical") {
    return Math.min(40, Math.max(1, messageCount - 1));
  }
  if (messageCount > 0 && messageCount <= 80) {
    return Math.max(1, Math.floor(messageCount / 2));
  }
  return 80;
}

function systemRow(text: string): MessageRow {
  return { kind: "message", role: "system", text, timestamp: Date.now() };
}

function systemRows(text: string): LogRow[] {
  return [systemRow(text)];
}

function dropEmptyPlaceholder(rows: LogRow[]): LogRow[] {
  return rows.filter((row) => !(row.kind === "message" && row.role === "system" && (
    row.text === "Connecting chat backend." ||
    row.text === "No messages yet. Send your first prompt." ||
    row.text.startsWith("Send a message to start")
  )));
}

function formatMessageContent(value: unknown): string {
  const record = asRecord(value);
  if (record) {
    const text = asString(record.text) || "";
    const media = Array.isArray(record.media) ? record.media : [];
    if (media.length > 0) {
      const lines = text.trim() ? [text] : [];
      for (const item of media) lines.push(describeAttachment(item));
      return lines.join("\n");
    }
  }
  return typeof value === "string" ? value : prettyJson(value);
}

function describeAttachment(value: unknown): string {
  const record = asRecord(value);
  if (!record) return "Attached media";
  const type = asString(record.type) || "media";
  const filename = asString(record.filename);
  const mimeType = asString(record.mimeType);
  const size = asNumber(record.size);
  const duration = asNumber(record.duration);
  const parts = ["Attached " + type];
  if (filename) parts.push(`"${filename}"`);
  if (mimeType) parts.push(`[${mimeType}]`);
  const sizeLabel = formatAttachmentSize(size);
  if (sizeLabel) parts.push(sizeLabel);
  const durationLabel = formatAttachmentDuration(duration);
  if (durationLabel) parts.push(durationLabel);
  return parts.join(" ");
}

function formatAttachmentSize(size: number | null): string {
  if (!size || size <= 0) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function formatAttachmentDuration(duration: number | null): string {
  if (!duration || duration <= 0 || !Number.isFinite(duration)) return "";
  const totalSeconds = Math.max(1, Math.round(duration));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function inferToolSyscall(toolName: string, syscall?: string | null): string | null {
  if (syscall?.trim()) return syscall.trim();
  switch (toolName) {
    case "Read": return "fs.read";
    case "Search": return "fs.search";
    case "Shell": return "shell.exec";
    case "Write": return "fs.write";
    case "Edit": return "fs.edit";
    case "Delete": return "fs.delete";
    case "CodeMode": return "codemode.exec";
    default: return null;
  }
}

function describeToolCard(toolName: string, args: unknown, syscall: string | null): { title: string; subtitle: string; target: string } {
  const record = asRecord(args);
  const path = asString(record?.path);
  const target = resolveToolTarget(args);
  if (toolName === "Shell" || syscall === "shell.exec") {
    const command = asString(record?.input);
    const cwd = asString(record?.cwd);
    return { title: record?.sessionId ? "Continue shell session" : command ? "Run " + truncateInline(command) : "Run command", subtitle: cwd ? "cwd " + truncateInline(cwd, 36) : "", target };
  }
  if (toolName === "Read" || syscall === "fs.read") return { title: path ? "Read " + basenamePath(path) : "Read file", subtitle: path ?? "", target };
  if (toolName === "Search" || syscall === "fs.search") return { title: "Search workspace", subtitle: path ?? "", target };
  if (toolName === "Write" || syscall === "fs.write") return { title: path ? "Write " + basenamePath(path) : "Write file", subtitle: path ?? "", target };
  if (toolName === "Edit" || syscall === "fs.edit") return { title: path ? "Edit " + basenamePath(path) : "Edit file", subtitle: path ?? "", target };
  if (toolName === "Delete" || syscall === "fs.delete") return { title: path ? "Delete " + basenamePath(path) : "Delete file", subtitle: path ?? "", target };
  if (toolName === "CodeMode" || syscall === "codemode.exec" || syscall === "codemode.run") {
    const code = asString(record?.code)?.trim();
    return { title: "Run CodeMode script", subtitle: code ? truncateInline(firstCodeLine(code), 72) : "process-local JavaScript", target: "process" };
  }
  if (syscall === "sys.mcp.call") {
    const serverId = asString(record?.serverId);
    const name = asString(record?.name);
    return {
      title: name ? "Call MCP " + truncateInline(name, 48) : "Call MCP tool",
      subtitle: serverId ? `server ${truncateInline(serverId, 36)}` : "",
      target: "mcp",
    };
  }
  return { title: toolName, subtitle: "", target };
}

function describeHilSummary(request: HilRequest, syscall: string): string {
  const args = asRecord(request.args) || {};
  const path = asString(args.path);
  const command = asString(args.input);
  if (request.toolName === "Shell" || syscall === "shell.exec") {
    return command ? `Run "${truncateInline(command, 96)}".` : "Run a shell command.";
  }
  if (request.toolName === "Read" || syscall === "fs.read") return path ? `Read ${path}.` : "Read a file.";
  if (request.toolName === "Write" || syscall === "fs.write") return path ? `Write ${path}.` : "Write a file.";
  if (request.toolName === "Edit" || syscall === "fs.edit") return path ? `Edit ${path}.` : "Edit a file.";
  if (request.toolName === "Delete" || syscall === "fs.delete") return path ? `Delete ${path}.` : "Delete a file.";
  if (request.toolName === "CodeMode" || syscall === "codemode.exec" || syscall === "codemode.run") return "Run a process-local CodeMode script.";
  if (syscall === "sys.mcp.call") {
    const serverId = asString(args.serverId);
    const name = asString(args.name);
    if (serverId && name) return `Call MCP tool ${name} on ${serverId}.`;
    if (name) return `Call MCP tool ${name}.`;
    return "Call an MCP tool.";
  }
  return "Confirm this tool call before it runs.";
}

function firstCodeLine(code: string): string {
  return code.split("\n").map((line) => line.trim()).find(Boolean) || "script";
}

function resolveToolTarget(args: unknown): string {
  const record = asRecord(args);
  const raw = asString(record?.target)?.trim() || "";
  if (!raw || raw === "gsv" || raw === "gateway" || raw === "<init>" || raw === "init" || raw === "local") return "gsv";
  if (raw.startsWith("device:")) return raw.slice("device:".length) || raw;
  if (raw.startsWith("driver:")) return raw.slice("driver:".length) || raw;
  return raw;
}

function normalizeToolOutput(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function formatContextPressure(state: ContextState): string {
  if (!state.availableInputTokens || state.pressure === null) return "context unknown";
  const percent = Math.round(state.pressure * 100);
  return `${percent}% context - ${formatCompactTokens(state.inputTokens)}/${formatCompactTokens(state.availableInputTokens)}`;
}

function formatCompactTokens(value: number | null): string {
  if (!value || !Number.isFinite(value)) return "0";
  if (value >= 1000000) return (value / 1000000).toFixed(value >= 10000000 ? 0 : 1).replace(/\.0$/, "") + "M";
  if (value >= 1000) return (value / 1000).toFixed(value >= 10000 ? 0 : 1).replace(/\.0$/, "") + "k";
  return String(Math.round(value));
}

function basenamePath(path: string): string {
  const normalized = String(path ?? "").replace(/\/+$/g, "");
  if (!normalized) return path;
  return normalized.split("/").pop() || normalized;
}

function formatTimestamp(value: number): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatRelativeTime(value: number): string {
  const deltaMs = value - Date.now();
  const abs = Math.abs(deltaMs);
  if (abs < 60000) return "just now";
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [["day", 86400000], ["hour", 3600000], ["minute", 60000]];
  for (const [unit, ms] of units) {
    if (abs >= ms) {
      return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(Math.round(deltaMs / ms), unit);
    }
  }
  return "just now";
}

function shortId(value: string): string {
  if (!value) return "";
  if (value === "default") return "default";
  if (value.includes(":")) return value;
  return value.length > 12 ? value.slice(0, 8) : value;
}

function isNearBottom(node: HTMLElement, thresholdPx = 96): boolean {
  return node.scrollHeight - node.scrollTop - node.clientHeight <= thresholdPx;
}

const CHAT_MENU_SELECTOR = "details.process-menu, details.message-menu";

function closeChatMenus(except?: HTMLDetailsElement | null): void {
  if (typeof document === "undefined") {
    return;
  }
  document.querySelectorAll<HTMLDetailsElement>(`${CHAT_MENU_SELECTOR}[open]`).forEach((menu) => {
    if (menu !== except) {
      menu.open = false;
    }
  });
}

function closeContainingChatMenu(target: EventTarget | null): void {
  const element = target instanceof Element ? target : null;
  const menu = element?.closest(CHAT_MENU_SELECTOR);
  if (menu instanceof HTMLDetailsElement) {
    menu.open = false;
  }
}

function isInsideChatMenu(target: EventTarget | null): boolean {
  const element = target instanceof Element ? target : null;
  return Boolean(element?.closest(CHAT_MENU_SELECTOR));
}

async function copyTextToClipboard(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall back for iframe runtimes where the Clipboard API exists but is denied.
    }
  }
  if (typeof document === "undefined") {
    throw new Error("clipboard is unavailable");
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "-9999px";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  try {
    if (!document.execCommand("copy")) {
      throw new Error("copy command failed");
    }
  } finally {
    document.body.removeChild(textarea);
  }
}

function truncateInline(value: unknown, maxLength = 80): string {
  const compact = String(value ?? "").replace(/\s+/g, " ").trim();
  return compact.length <= maxLength ? compact : compact.slice(0, maxLength) + "...";
}

function truncateBlock(value: unknown, maxLength = 1800): string {
  const text = String(value ?? "");
  return text.length <= maxLength ? text : text.slice(0, maxLength) + "\n...[truncated]";
}

function normalizeTimestampMs(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value > 0 && value < 1000000000000) return Math.floor(value * 1000);
  return Math.floor(value);
}

function normalizePositiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function requiredText(value: unknown): string | null {
  const text = asString(value)?.trim();
  return text ? text : null;
}

function optionalText(value: unknown): string | undefined {
  return requiredText(value) ?? undefined;
}

function safeText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return String(value);
}

function titleCase(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return value;
  const known = new Map([
    ["whatsapp", "WhatsApp"],
    ["discord", "Discord"],
    ["gsv", "GSV"],
  ]);
  const mapped = known.get(trimmed.toLowerCase());
  if (mapped) return mapped;
  return `${trimmed.slice(0, 1).toUpperCase()}${trimmed.slice(1)}`;
}

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function escapeHtml(value: string): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export {
  activeMeta,
  applyAssistantSignal,
  applyProcessMessageSignal,
  applyToolCallSignal,
  applyToolResultSignal,
  asBoolean,
  asNumber,
  asRecord,
  asString,
  basenamePath,
  closeChatMenus,
  closeContainingChatMenu,
  copyTextToClipboard,
  describeAttachment,
  describeHilSummary,
  describeToolCard,
  deriveThreadLabel,
  displayThreadLabel,
  dropEmptyPlaceholder,
  draftConversationMeta,
  draftConversationTitle,
  fallbackProfiles,
  flattenHistory,
  formatAttachmentDuration,
  formatAttachmentSize,
  formatContextPressure,
  formatError,
  formatInteractionOriginLabel,
  formatMessageContent,
  formatRelativeTime,
  formatTimestamp,
  getStatusText,
  getStoredThreadContext,
  inferToolSyscall,
  isInsideChatMenu,
  isNearBottom,
  labelForRole,
  normalizeContextSignal,
  normalizeContextState,
  normalizeConversation,
  normalizeConversationSegment,
  normalizeHilRequest,
  normalizePositiveNumber,
  normalizeProfile,
  normalizeThreadContext,
  normalizeTimestampMs,
  normalizeToolOutput,
  normalizeWorkspace,
  prettyJson,
  readAttachmentBlob,
  readAttachmentFile,
  renderMarkdownHtml,
  safeText,
  setStoredThreadContext,
  signalMatchesActiveThread,
  shortId,
  sortConversations,
  suggestKeepLast,
  systemRow,
  systemRows,
  titleForActive,
  truncateBlock,
  truncateInline,
};
