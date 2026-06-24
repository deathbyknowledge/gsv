import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { SystemMessage } from "../../../components/ui/SystemMessage";
import type {
  ChatTranscriptRow,
  ChatTranscriptRowRole,
} from "../domain/transcript";
import { ChatMediaAttachment } from "./ChatMediaAttachment";

export type ChatDockMessageRole = ChatTranscriptRowRole;
export type ChatDockMessage = ChatTranscriptRow;

type ChatTranscriptProps = {
  messages: readonly ChatDockMessage[];
  state?: "empty" | "error" | "loading" | "ready";
  emptyTitle?: string;
  emptyDescription?: string;
  errorMessage?: string;
  action?: ComponentChildren;
  beforeMessages?: ComponentChildren;
  processId?: string;
  onBranch?: (messageId: number) => void;
};

type CopyState = {
  id: string;
  status: "copied" | "failed";
};

type TranscriptActivityEntry =
  | { kind: "reasoning"; message: ChatDockMessage }
  | { kind: "tool"; message: ChatDockMessage };

type TranscriptRenderItem =
  | { kind: "message"; id: string; index: number; message: ChatDockMessage }
  | { kind: "activityGroup"; entries: TranscriptActivityEntry[]; id: string; index: number };

function copyWithFallback(text: string): boolean {
  if (typeof document === "undefined" || !document.body) {
    return false;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.top = "-1000px";
  textarea.style.left = "-1000px";
  document.body.appendChild(textarea);
  textarea.select();

  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    document.body.removeChild(textarea);
  }
}

async function copyText(text: string): Promise<boolean> {
  if (!text.trim()) {
    return false;
  }

  if (typeof navigator !== "undefined" && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return copyWithFallback(text);
    }
  }

  return copyWithFallback(text);
}

function normalizedRole(role: ChatDockMessageRole | undefined): ChatDockMessageRole {
  if (
    role === "assistant"
    || role === "system"
    || role === "tool"
    || role === "toolResult"
    || role === "user"
  ) {
    return role;
  }
  return "assistant";
}

function roleLabel(role: ChatDockMessageRole): string {
  switch (role) {
    case "assistant":
      return "ASSISTANT";
    case "system":
      return "SYSTEM";
    case "tool":
      return "TOOL";
    case "toolResult":
      return "TOOL RESULT";
    case "user":
      return "USER";
  }
}

function roleClass(role: ChatDockMessageRole): string {
  return role === "toolResult" ? "tool-result" : role;
}

function originLabel(origin: ChatDockMessage["origin"]): string {
  if (!origin) {
    return "";
  }
  if (origin.kind === "adapter") {
    return [
      origin.adapter,
      origin.surface.name || origin.surface.handle || origin.surface.kind,
      origin.actorLabel,
    ].filter(Boolean).join(" · ");
  }
  if (origin.kind === "client") {
    return [origin.platform, origin.clientId].filter(Boolean).join(" · ") || "client";
  }
  if (origin.kind === "app") {
    return origin.packageName || origin.packageId || "app";
  }
  if (origin.kind === "device") {
    return origin.deviceId;
  }
  if (origin.kind === "process") {
    return origin.sourcePid;
  }
  if (origin.kind === "scheduler") {
    return origin.scheduleId;
  }
  return "";
}

function AssistantGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" shape-rendering="crispEdges">
      <g fill="currentColor">
        <rect x="7" y="1" width="2" height="2" />
        <rect x="6" y="3" width="4" height="6" />
        <rect x="4" y="6" width="2" height="3" />
        <rect x="10" y="6" width="2" height="3" />
        <rect x="7" y="11" width="2" height="3" class="gsv-chat-message-glyph-accent" />
      </g>
    </svg>
  );
}

function roleGlyph(role: ChatDockMessageRole): ComponentChildren {
  switch (role) {
    case "assistant":
      return <AssistantGlyph />;
    case "system":
      return "!";
    case "tool":
      return "$";
    case "toolResult":
      return "=";
    case "user":
      return ">";
  }
}

function copyButtonLabel(copied: boolean, failed: boolean): string {
  if (copied) {
    return "COPIED";
  }
  if (failed) {
    return "FAILED";
  }
  return "COPY";
}

function CopyButton({
  copied,
  failed,
  role,
  text,
  onCopy,
}: {
  copied: boolean;
  failed: boolean;
  role: ChatDockMessageRole;
  text: string;
  onCopy: () => void;
}) {
  const label = copyButtonLabel(copied, failed);

  return (
    <button
      type="button"
      class={`gsv-chat-copy${failed ? " is-failed" : ""}`}
      disabled={!text.trim()}
      onClick={onCopy}
      aria-label={copied ? `Copied ${roleLabel(role).toLowerCase()} message` : `Copy ${roleLabel(role).toLowerCase()} message`}
      title={copied ? "Copied" : "Copy message"}
    >
      <svg width="10" height="10" viewBox="0 0 16 16" aria-hidden="true">
        <g fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="3" y="3" width="7" height="7" />
          <rect x="6" y="6" width="7" height="7" />
        </g>
      </svg>
      {label}
    </button>
  );
}

type AssistantBlock =
  | { kind: "text"; text: string }
  | { kind: "code"; language: string; code: string };

function assistantBlocks(text: string): AssistantBlock[] {
  const blocks: AssistantBlock[] = [];
  const pattern = /```([^\n`]*)\n([\s\S]*?)```/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    const before = text.slice(cursor, match.index);
    if (/\S/.test(before)) {
      blocks.push({ kind: "text", text: before });
    }
    blocks.push({
      kind: "code",
      language: match[1]?.trim() || "code",
      code: match[2]?.replace(/\n$/, "") ?? "",
    });
    cursor = match.index + match[0].length;
  }

  const rest = text.slice(cursor);
  if (/\S/.test(rest)) {
    blocks.push({ kind: "text", text: rest });
  }

  return blocks.length > 0 ? blocks : [{ kind: "text", text }];
}

function AssistantText({ text }: { text: string }) {
  return (
    <div class="gsv-chat-assistant-rich">
      {assistantBlocks(text).map((block, index) => block.kind === "code" ? (
        <figure class="gsv-chat-code-block" key={`code:${index}`}>
          <figcaption>{block.language}</figcaption>
          <pre><code>{block.code}</code></pre>
        </figure>
      ) : (
        <div class="gsv-chat-rich-text" key={`text:${index}`}>
          {block.text}
        </div>
      ))}
    </div>
  );
}

function formatToolDetailValue(value: unknown): string {
  if (value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function shortId(value: string | undefined): string {
  return value ? value.slice(0, 8) : "";
}

function basenamePath(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] || value;
}

function truncateInline(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 3).trim()}...`;
}

function lowercaseFirst(value: string): string {
  return value ? `${value.charAt(0).toLowerCase()}${value.slice(1)}` : value;
}

function inferToolSyscall(toolName: string | undefined, syscall: string | null | undefined): string | null {
  if (syscall?.trim()) {
    return syscall.trim();
  }

  switch (toolName) {
    case "Read":
      return "fs.read";
    case "Search":
      return "fs.search";
    case "Shell":
      return "shell.exec";
    case "Write":
      return "fs.write";
    case "Edit":
      return "fs.edit";
    case "Delete":
      return "fs.delete";
    case "CodeMode":
      return "codemode.exec";
    default:
      return null;
  }
}

function toolSyscall(message: ChatDockMessage): string | null {
  return inferToolSyscall(message.toolName, message.toolSyscall);
}

function toolEntryTone(message: ChatDockMessage): "done" | "error" | "running" {
  if (message.isError || message.status === "error") {
    return "error";
  }
  if (message.role === "toolResult" || message.status === "done") {
    return "done";
  }
  return "running";
}

function toolStatusLabel(message: ChatDockMessage): string {
  const tone = toolEntryTone(message);
  if (tone === "error") {
    return "ERROR";
  }
  if (tone === "done") {
    return "DONE";
  }
  return message.status === "planning" ? "PREPARING" : "RUNNING";
}

function toolPathTarget(message: ChatDockMessage): string | null {
  const args = asRecord(message.toolArgs);
  const path = asString(args?.path)
    ?? asString(args?.file)
    ?? asString(args?.targetPath)
    ?? asString(args?.sourcePath);
  return path ? basenamePath(path) : null;
}

function shellInputText(message: ChatDockMessage): string | null {
  const args = asRecord(message.toolArgs);
  return asString(args?.input)
    ?? asString(args?.command)
    ?? asString(args?.cmd)
    ?? asString(args?.script);
}

function toolDisplayName(message: ChatDockMessage): string {
  const name = message.toolName?.trim();
  if (!name || name === "Tool") {
    return message.toolSyscall?.trim() || "tool";
  }
  return name;
}

function toolActivityTitle(message: ChatDockMessage): string {
  const syscall = toolSyscall(message);
  const target = toolPathTarget(message) || "file";
  const tone = toolEntryTone(message);
  const running = tone === "running";
  const failed = tone === "error";

  if (syscall === "fs.read") {
    return failed ? `Could not read ${target}` : running ? `Reading ${target}` : `Read ${target}`;
  }
  if (syscall === "fs.write") {
    return failed ? `Could not write ${target}` : running ? `Writing ${target}` : `Wrote ${target}`;
  }
  if (syscall === "fs.edit") {
    return failed ? `Could not edit ${target}` : running ? `Editing ${target}` : `Edited ${target}`;
  }
  if (syscall === "fs.delete") {
    return failed ? `Could not delete ${target}` : running ? `Deleting ${target}` : `Deleted ${target}`;
  }
  if (syscall === "fs.search") {
    return failed ? "Search failed" : running ? "Searching files" : "Searched files";
  }
  if (syscall === "shell.exec") {
    const input = shellInputText(message);
    if (failed) {
      return input ? `Failed ${truncateInline(input, 72)}` : "Command failed";
    }
    if (running) {
      return input ? `Running ${truncateInline(input, 72)}` : "Running command";
    }
    return input ? `Ran ${truncateInline(input, 72)}` : "Ran shell input";
  }
  if (syscall === "codemode.exec" || syscall === "codemode.run") {
    return failed ? "CodeMode failed" : running ? "Running CodeMode script" : "Ran CodeMode script";
  }
  if (syscall === "sys.mcp.call") {
    return failed ? "MCP tool failed" : running ? "Calling MCP tool" : "Called MCP tool";
  }

  const name = toolDisplayName(message);
  return failed ? `${name} failed` : running ? `Using ${name}` : `Used ${name}`;
}

function toolActivityPreview(message: ChatDockMessage): string {
  const syscall = toolSyscall(message);
  const tone = toolEntryTone(message);
  if (tone === "running") {
    if (syscall === "shell.exec") return "Running command.";
    if (syscall === "fs.read") return "Reading file.";
    if (syscall === "fs.search") return "Searching files.";
    if (syscall === "fs.write") return "Preparing file write.";
    if (syscall === "fs.edit") return "Preparing edit.";
    if (syscall === "fs.delete") return "Preparing delete.";
    if (syscall === "codemode.exec" || syscall === "codemode.run") return "Running process-local script.";
    if (syscall === "sys.mcp.call") return "Calling MCP tool.";
    return `Using ${toolDisplayName(message)}.`;
  }

  if (tone === "error") {
    const output = asRecord(message.toolOutput);
    return message.text || asString(output?.error) || "Tool call failed.";
  }

  const output = message.toolOutput;
  const record = asRecord(output);
  if (syscall === "shell.exec") {
    const input = shellInputText(message);
    return input ? truncateInline(input, 140) : "Command completed.";
  }
  if (syscall === "fs.read") {
    const content = asString(record?.content);
    const directories = Array.isArray(record?.directories) ? record.directories : [];
    const files = Array.isArray(record?.files) ? record.files : [];
    if (content) return "Read file content.";
    if (directories.length || files.length) {
      return `Listed ${directories.length} dirs and ${files.length} files.`;
    }
    return "Read completed.";
  }
  if (syscall === "fs.write") {
    const size = asNumber(record?.size);
    return size !== null ? `Wrote ${size} ${size === 1 ? "byte" : "bytes"}.` : "Wrote file.";
  }
  if (syscall === "fs.edit") {
    const replacements = asNumber(record?.replacements);
    return replacements !== null ? `${replacements} ${replacements === 1 ? "replacement" : "replacements"}.` : "Edited file.";
  }
  if (syscall === "fs.delete") {
    return "Deleted file.";
  }
  if (syscall === "fs.search") {
    const matches = Array.isArray(record?.matches) ? record.matches : [];
    const count = asNumber(record?.count) ?? matches.length;
    return `${count} ${count === 1 ? "match" : "matches"}.`;
  }
  if (syscall === "codemode.exec" || syscall === "codemode.run") {
    const status = asString(record?.status);
    if (status === "failed") return asString(record?.error) || "CodeMode script failed.";
    if (status === "completed") return "CodeMode script completed.";
    return "CodeMode completed.";
  }
  if (typeof output === "string" && output.trim()) {
    return truncateInline(output, 140);
  }
  if (message.text.trim() && !message.text.trim().startsWith("{")) {
    return truncateInline(message.text, 140);
  }
  return "Completed.";
}

function toolGroupStatus(tools: readonly ChatDockMessage[]): "done" | "error" | "running" {
  if (tools.some((message) => toolEntryTone(message) === "error")) {
    return "error";
  }
  if (tools.some((message) => toolEntryTone(message) === "running")) {
    return "running";
  }
  return "done";
}

function toolGroupTitle(tools: readonly ChatDockMessage[]): string {
  const status = toolGroupStatus(tools);
  if (status === "error") {
    const failed = [...tools].reverse().find((message) => toolEntryTone(message) === "error");
    return failed ? lowercaseFirst(toolActivityTitle(failed)) : "activity needs attention";
  }
  const running = tools.find((message) => toolEntryTone(message) === "running");
  if (running) {
    return lowercaseFirst(toolActivityTitle(running));
  }
  const latest = tools[tools.length - 1];
  return latest ? lowercaseFirst(toolActivityTitle(latest)) : "completed work";
}

function reasoningText(message: ChatDockMessage): string {
  return message.thinking?.filter((entry) => entry.trim()).join("\n\n") ?? "";
}

function isReasoningOnlyMessage(message: ChatDockMessage): boolean {
  return normalizedRole(message.role) === "assistant"
    && !message.meta
    && !message.text.trim()
    && (Boolean(reasoningText(message)) || message.streaming === true);
}

function isToolMessage(message: ChatDockMessage): boolean {
  const role = normalizedRole(message.role);
  return role === "tool" || role === "toolResult";
}

function activityEntryForMessage(message: ChatDockMessage): TranscriptActivityEntry | null {
  if (isToolMessage(message)) {
    return { kind: "tool", message };
  }
  if (isReasoningOnlyMessage(message)) {
    return { kind: "reasoning", message };
  }
  return null;
}

function activityRunId(entry: TranscriptActivityEntry): string | null {
  return entry.message.runId || null;
}

function buildTranscriptRenderItems(messages: readonly ChatDockMessage[]): TranscriptRenderItem[] {
  const items: TranscriptRenderItem[] = [];
  let index = 0;

  while (index < messages.length) {
    const message = messages[index];
    const firstEntry = activityEntryForMessage(message);
    if (!firstEntry) {
      items.push({
        kind: "message",
        id: `message:${message.id}:${index}`,
        index,
        message,
      });
      index += 1;
      continue;
    }

    const runId = activityRunId(firstEntry);
    const entries: TranscriptActivityEntry[] = [];
    const startIndex = index;
    while (index < messages.length) {
      const candidate = messages[index];
      const entry = activityEntryForMessage(candidate);
      if (!entry || activityRunId(entry) !== runId) {
        break;
      }
      entries.push(entry);
      index += 1;
    }

    const firstMessage = entries[0]?.message;
    const identifier = firstMessage?.runId || firstMessage?.toolCallId || firstMessage?.id || `activity:${startIndex}`;
    items.push({
      kind: "activityGroup",
      entries,
      id: `activity-group:${identifier}:${startIndex}`,
      index: startIndex,
    });
  }

  return items;
}

function summarizeSystemText(text: string): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.length <= 92) {
    return trimmed;
  }
  return `${trimmed.slice(0, 89).trim()}...`;
}

function UserMessage({
  copied,
  failed,
  message,
  processId,
  onCopy,
  onBranch,
}: {
  copied: boolean;
  failed: boolean;
  message: ChatDockMessage;
  processId: string;
  onCopy: () => void;
  onBranch?: (messageId: number) => void;
}) {
  const origin = originLabel(message.origin);
  return (
    <div class="gsv-chat-user-message">
      <div class="gsv-chat-user-message-inner">
        {message.text ? <div class="gsv-chat-user-message-text">{message.text}</div> : null}
        {message.media?.length ? (
          <div class="gsv-chat-media-list">
            {message.media.map((media, index) => (
              <ChatMediaAttachment key={`${message.id}:media:${index}`} media={media} processId={processId} />
            ))}
          </div>
        ) : null}
        <div class="gsv-chat-user-message-meta">
          {message.time ? <span>{message.time}</span> : null}
          {origin ? <span title={origin}>{origin}</span> : null}
          {message.messageId && onBranch ? (
            <button type="button" class="gsv-chat-copy" title="Branch from message" onClick={() => onBranch(message.messageId as number)}>
              BRANCH
            </button>
          ) : null}
          <CopyButton
            copied={copied}
            failed={failed}
            role="user"
            text={message.text}
            onCopy={onCopy}
          />
        </div>
      </div>
    </div>
  );
}

function SystemSurfaceMessage({
  copied,
  failed,
  message,
  onCopy,
}: {
  copied: boolean;
  failed: boolean;
  message: ChatDockMessage;
  onCopy: () => void;
}) {
  const origin = originLabel(message.origin);
  const [expanded, setExpanded] = useState(false);
  const summary = message.meta || summarizeSystemText(message.text);

  return (
    <article class="gsv-chat-system-surface">
      <div class="gsv-chat-system-line">
        <span>SYSTEM</span>
        {summary ? <small>{summary}</small> : null}
      </div>
      <div class="gsv-chat-system-actions">
        <button type="button" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
          <i aria-hidden="true" data-expanded={expanded ? "true" : undefined}>{">"}</i>
          DETAILS
        </button>
        {message.time ? <span>{message.time}</span> : null}
        {origin ? <span title={origin}>{origin}</span> : null}
        <CopyButton
          copied={copied}
          failed={failed}
          role="system"
          text={message.text}
          onCopy={onCopy}
        />
      </div>
      {expanded ? <div class="gsv-chat-system-detail">{message.text}</div> : null}
    </article>
  );
}

function ToolResultMessage({
  copied,
  failed,
  message,
  onCopy,
}: {
  copied: boolean;
  failed: boolean;
  message: ChatDockMessage;
  onCopy: () => void;
}) {
  const title = message.toolName?.trim() || "Tool result";
  const status = message.role === "tool"
    ? message.status === "planning" ? "PLANNING" : "RUNNING"
    : message.isError ? "ERROR" : "DONE";
  const identifier = message.toolCallId || message.runId || message.id;
  const output = message.role === "tool" && message.status === "planning"
    ? "Preparing tool call."
    : message.text;
  const argsText = formatToolDetailValue(message.toolArgs);
  const outputText = formatToolDetailValue(message.toolOutput);
  const hasDetails = Boolean(argsText.trim() || outputText.trim());

  return (
    <article class={`gsv-chat-tool-card${message.isError ? " is-error" : ""}${message.role === "tool" ? " is-pending" : ""}`}>
      <span class="gsv-chat-tool-corner is-top-left" aria-hidden="true" />
      <span class="gsv-chat-tool-corner is-top-right" aria-hidden="true" />
      <span class="gsv-chat-tool-corner is-bottom-left" aria-hidden="true" />
      <span class="gsv-chat-tool-corner is-bottom-right" aria-hidden="true" />

      <header class="gsv-chat-tool-card-head">
        <span class="gsv-chat-tool-card-dot" aria-hidden="true" />
        <strong>{title}</strong>
        <small>{status}</small>
      </header>

      <div class="gsv-chat-tool-card-id">
        <span>{message.runId ? `RUN ${shortId(message.runId)}` : "TOOL RESULT"}</span>
        {identifier ? <small>{shortId(identifier)}</small> : null}
      </div>

      <div class="gsv-chat-tool-card-output">{output}</div>

      {hasDetails ? (
        <details class="gsv-chat-tool-card-details">
          <summary>DETAILS</summary>
          {argsText.trim() ? (
            <>
              <span>ARGS</span>
              <pre>{argsText}</pre>
            </>
          ) : null}
          {outputText.trim() ? (
            <>
              <span>OUTPUT</span>
              <pre>{outputText}</pre>
            </>
          ) : null}
        </details>
      ) : null}

      <footer class="gsv-chat-tool-card-meta">
        {message.time ? <span>{message.time}</span> : null}
        <CopyButton
          copied={copied}
          failed={failed}
          role={message.role === "tool" ? "tool" : "toolResult"}
          text={output}
          onCopy={onCopy}
        />
      </footer>
    </article>
  );
}

function activityGroupStatus(entries: readonly TranscriptActivityEntry[]): "done" | "error" | "running" {
  const tools = entries.filter((entry) => entry.kind === "tool").map((entry) => entry.message);
  if (tools.length > 0) {
    return toolGroupStatus(tools);
  }
  return entries.some((entry) => entry.message.streaming) ? "running" : "done";
}

function activityDuration(entries: readonly TranscriptActivityEntry[]): string {
  const timestamps = entries
    .map((entry) => entry.message.timestamp)
    .filter((timestamp): timestamp is number => typeof timestamp === "number" && Number.isFinite(timestamp));
  if (timestamps.length < 2) {
    return "";
  }
  const seconds = Math.max(1, Math.round((Math.max(...timestamps) - Math.min(...timestamps)) / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return remaining > 0 ? `${minutes}m ${remaining}s` : `${minutes}m`;
}

function activityGroupTitle(entries: readonly TranscriptActivityEntry[]): string {
  const tools = entries.filter((entry) => entry.kind === "tool").map((entry) => entry.message);
  const status = activityGroupStatus(entries);
  const duration = activityDuration(entries);

  if (status === "done" && duration && entries.length > 1) {
    return tools.length > 0 ? `worked for ${duration}` : `reasoned for ${duration}`;
  }
  if (tools.length > 0) {
    return toolGroupTitle(tools);
  }
  return status === "running" ? "thinking" : "reasoned";
}

function EntryControls({
  expanded,
  hasDetails,
  label,
  status,
  onToggle,
}: {
  expanded: boolean;
  hasDetails: boolean;
  label: string;
  status: string;
  onToggle: () => void;
}) {
  return (
    <div class="gsv-chat-tool-entry-controls" aria-label={status} title={status}>
      {hasDetails ? (
        <button
          type="button"
          class="gsv-chat-tool-entry-expand"
          aria-expanded={expanded}
          onClick={onToggle}
        >
          <i aria-hidden="true" data-expanded={expanded ? "true" : undefined}>{">"}</i>
          {label}
        </button>
      ) : null}
    </div>
  );
}

function ReasoningEntry({ message }: { message: ChatDockMessage }) {
  const [expanded, setExpanded] = useState(false);
  const text = reasoningText(message);
  const status = message.streaming ? "THINKING" : "REASONED";
  return (
    <div class={`gsv-chat-tool-entry gsv-chat-reasoning-entry${message.streaming ? " is-running" : " is-done"}`}>
      <span class="gsv-chat-tool-entry-status" aria-hidden="true" />
      <div class="gsv-chat-tool-entry-main">
        <strong>{message.streaming ? "Thinking" : "Reasoned"}</strong>
      </div>
      <EntryControls
        expanded={expanded}
        hasDetails={Boolean(text)}
        label="REASONING"
        status={status}
        onToggle={() => setExpanded((value) => !value)}
      />
      {text && expanded ? (
        <div class="gsv-chat-tool-entry-detail-body">
          <pre>{text}</pre>
        </div>
      ) : null}
    </div>
  );
}

function ToolEntry({ tool }: { tool: ChatDockMessage }) {
  const [expanded, setExpanded] = useState(false);
  const tone = toolEntryTone(tool);
  const argsText = formatToolDetailValue(tool.toolArgs);
  const outputText = formatToolDetailValue(tool.toolOutput);
  const hasDetails = Boolean(argsText.trim() || outputText.trim());
  return (
    <div class={`gsv-chat-tool-entry is-${tone}`}>
      <span class="gsv-chat-tool-entry-status" aria-hidden="true" />
      <div class="gsv-chat-tool-entry-main">
        <strong>{toolActivityTitle(tool)}</strong>
      </div>
      <EntryControls
        expanded={expanded}
        hasDetails={hasDetails}
        label="DETAILS"
        status={toolStatusLabel(tool)}
        onToggle={() => setExpanded((value) => !value)}
      />
      {hasDetails && expanded ? (
        <div class="gsv-chat-tool-entry-detail-body">
          {argsText.trim() ? (
            <>
              <small>INPUT</small>
              <pre>{argsText}</pre>
            </>
          ) : null}
          {outputText.trim() ? (
            <>
              <small>OUTPUT</small>
              <pre>{outputText}</pre>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function RunActivityCard({ entries }: { entries: readonly TranscriptActivityEntry[] }) {
  const status = activityGroupStatus(entries);
  const [expanded, setExpanded] = useState(status === "running");
  const runId = entries.find((entry) => entry.message.runId)?.message.runId;
  const title = activityGroupTitle(entries);
  const statusLabel = status === "error" ? "ERROR" : status === "running" ? "RUNNING" : "DONE";

  useEffect(() => {
    setExpanded(status === "running");
  }, [status]);

  return (
    <article class={`gsv-chat-tool-group-card is-${status}`}>
      <span class="gsv-chat-tool-corner is-top-left" aria-hidden="true" />
      <span class="gsv-chat-tool-corner is-top-right" aria-hidden="true" />
      <span class="gsv-chat-tool-corner is-bottom-left" aria-hidden="true" />
      <span class="gsv-chat-tool-corner is-bottom-right" aria-hidden="true" />

      <header class="gsv-chat-tool-group-head">
        <span class="gsv-chat-tool-group-dot" aria-hidden="true" />
        <strong>{title}</strong>
        <small>{statusLabel}</small>
        <button
          type="button"
          class="gsv-chat-tool-group-toggle"
          aria-label={expanded ? "Collapse tool activity" : "Expand tool activity"}
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          <i aria-hidden="true" data-expanded={expanded ? "true" : undefined}>{">"}</i>
        </button>
      </header>

      {expanded ? (
        <>
          <div class="gsv-chat-tool-group-id">
            <span>{runId ? `RUN ${shortId(runId)}` : "RUN ACTIVITY"}</span>
            <small>{entries.length} {entries.length === 1 ? "ENTRY" : "ENTRIES"}</small>
          </div>

          <div class="gsv-chat-tool-entry-list">
            {entries.map((entry, index) => entry.kind === "reasoning" ? (
              <ReasoningEntry key={`reasoning:${entry.message.id}:${index}`} message={entry.message} />
            ) : (
              <ToolEntry key={`tool:${entry.message.toolCallId || entry.message.id}:${index}`} tool={entry.message} />
            ))}
          </div>
        </>
      ) : null}
    </article>
  );
}

function AssistantProcessMessage({
  copied,
  failed,
  message,
  processId,
  onCopy,
}: {
  copied: boolean;
  failed: boolean;
  message: ChatDockMessage;
  processId: string;
  onCopy: () => void;
}) {
  const [reasoningOpen, setReasoningOpen] = useState(false);
  const reasoning = reasoningText(message);
  const assistantText = message.text.trim()
    ? message.text
    : message.streaming ? "Thinking..." : "";

  return (
    <>
      <SystemMessage
        text={assistantText}
        time={message.time}
        meta={reasoning ? (
          <button
            type="button"
            class="gsv-chat-reasoning-toggle"
            aria-expanded={reasoningOpen}
            onClick={() => setReasoningOpen((value) => !value)}
          >
            <i aria-hidden="true" data-expanded={reasoningOpen ? "true" : undefined}>{">"}</i>
            REASONING
          </button>
        ) : null}
        copyLabel={copyButtonLabel(copied, failed)}
        copyDisabled={!assistantText.trim()}
        copyFailed={failed}
        copyTitle={copied ? "Copied" : "Copy message"}
        copyAriaLabel={copied ? "Copied assistant message" : "Copy assistant message"}
        onCopy={onCopy}
      >
        <AssistantText text={assistantText} />
      </SystemMessage>
      {reasoning && reasoningOpen ? (
        <div class="gsv-chat-assistant-reasoning">
          <pre>{reasoning}</pre>
        </div>
      ) : null}
      {message.media?.length ? (
        <div class="gsv-chat-media-list is-assistant">
          {message.media.map((media, index) => (
            <ChatMediaAttachment key={`${message.id}:media:${index}`} media={media} processId={processId} />
          ))}
        </div>
      ) : null}
    </>
  );
}

function ProcessMessage({
  copied,
  failed,
  message,
  processId,
  onCopy,
}: {
  copied: boolean;
  failed: boolean;
  message: ChatDockMessage;
  processId: string;
  onCopy: () => void;
}) {
  const messageRole = normalizedRole(message.role);
  const role = roleClass(messageRole);
  const label = roleLabel(messageRole);
  const showHead = messageRole !== "assistant" || Boolean(message.meta);

  if (messageRole === "tool" || messageRole === "toolResult") {
    return (
      <ToolResultMessage
        copied={copied}
        failed={failed}
        message={message}
        onCopy={onCopy}
      />
    );
  }

  if (messageRole === "system") {
    return (
      <SystemSurfaceMessage
        copied={copied}
        failed={failed}
        message={message}
        onCopy={onCopy}
      />
    );
  }

  if (messageRole === "assistant" && !message.meta) {
    return (
      <AssistantProcessMessage
        copied={copied}
        failed={failed}
        message={message}
        processId={processId}
        onCopy={onCopy}
      />
    );
  }

  const origin = originLabel(message.origin);
  return (
    <article class={`gsv-chat-message gsv-chat-message-${role}`}>
      <div class="gsv-chat-message-glyph" aria-hidden="true">
        {roleGlyph(messageRole)}
      </div>
      <div class="gsv-chat-message-body">
        {showHead ? (
          <div class="gsv-chat-message-head">
            <span>{label}</span>
            {message.meta ? <small>{message.meta}</small> : null}
          </div>
        ) : null}
        {message.thinking?.length ? (
          <div class="gsv-chat-message-thinking">{message.thinking.join("\n\n")}</div>
        ) : null}
        <div class="gsv-chat-message-text">{message.text || (message.streaming ? "Thinking..." : "")}</div>
        {message.media?.length ? (
          <div class="gsv-chat-media-list">
            {message.media.map((media, index) => (
              <ChatMediaAttachment key={`${message.id}:media:${index}`} media={media} processId={processId} />
            ))}
          </div>
        ) : null}
        <div class="gsv-chat-message-meta">
          {message.time ? <span>{message.time}</span> : null}
          {origin ? <span title={origin}>{origin}</span> : null}
          <CopyButton
            copied={copied}
            failed={failed}
            role={messageRole}
            text={message.text}
            onCopy={onCopy}
          />
        </div>
      </div>
    </article>
  );
}

function TranscriptState({
  action,
  description,
  title,
  tone,
}: {
  action?: ComponentChildren;
  description: string;
  title: string;
  tone: "empty" | "error" | "loading";
}) {
  return (
    <div class={`gsv-chat-empty gsv-chat-empty-${tone}`}>
      <strong>{title}</strong>
      <span>{description}</span>
      {action ? <div class="gsv-chat-empty-action">{action}</div> : null}
    </div>
  );
}

export function ChatTranscript({
  action,
  beforeMessages,
  emptyDescription = "Process history will appear here when a conversation is available.",
  emptyTitle = "No active conversation",
  errorMessage = "Process history could not be loaded.",
  messages,
  onBranch,
  processId = "",
  state = "ready",
}: ChatTranscriptProps) {
  const [copyState, setCopyState] = useState<CopyState | null>(null);
  const copyResetTimer = useRef<ReturnType<typeof globalThis.setTimeout> | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const [showJumpLatest, setShowJumpLatest] = useState(false);
  const renderItems = buildTranscriptRenderItems(messages);

  useEffect(() => () => {
    if (copyResetTimer.current !== null) {
      globalThis.clearTimeout(copyResetTimer.current);
    }
  }, []);

  const resetCopyState = (messageId: string) => {
    if (copyResetTimer.current !== null) {
      globalThis.clearTimeout(copyResetTimer.current);
    }
    copyResetTimer.current = globalThis.setTimeout(() => {
      setCopyState((current) => current?.id === messageId ? null : current);
      copyResetTimer.current = null;
    }, 1600);
  };

  const copyMessage = (message: ChatDockMessage, messageId: string) => {
    const text = message.text || message.thinking?.filter(Boolean).join("\n\n") || "";
    void copyText(text).then((copied) => {
      setCopyState({ id: messageId, status: copied ? "copied" : "failed" });
      resetCopyState(messageId);
    });
  };

  const scrollToLatest = () => {
    const node = transcriptRef.current;
    if (!node) {
      return;
    }
    node.scrollTop = node.scrollHeight;
    stickToBottomRef.current = true;
    setShowJumpLatest(false);
  };

  const handleScroll = () => {
    const node = transcriptRef.current;
    if (!node) {
      return;
    }
    const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
    const nearBottom = distanceFromBottom < 96;
    stickToBottomRef.current = nearBottom;
    setShowJumpLatest(!nearBottom);
  };

  useEffect(() => {
    if (stickToBottomRef.current) {
      scrollToLatest();
    }
  }, [messages]);

  return (
    <div class="gsv-chat-transcript" aria-live="polite" ref={transcriptRef} onScroll={handleScroll}>
      {state === "loading" ? (
        <TranscriptState
          title="Loading process history"
          description="Fetching the latest transcript for this process."
          tone="loading"
        />
      ) : state === "error" ? (
        <TranscriptState
          title="History unavailable"
          description={errorMessage}
          tone="error"
        />
      ) : messages.length === 0 ? (
        <TranscriptState
          action={action}
          title={emptyTitle}
          description={emptyDescription}
          tone="empty"
        />
      ) : (
        <>
          {beforeMessages}
          {renderItems.map((item) => {
            if (item.kind === "activityGroup") {
              return <RunActivityCard key={item.id} entries={item.entries} />;
            }

            const message = item.message;
            const messageRole = normalizedRole(message.role);
            const messageId = `${messageRole}:${message.id}:${item.index}`;
            const copied = copyState?.id === messageId && copyState.status === "copied";
            const failed = copyState?.id === messageId && copyState.status === "failed";

            return messageRole === "user" ? (
              <UserMessage
                key={messageId}
                copied={copied}
                failed={failed}
                message={message}
                processId={processId}
                onCopy={() => copyMessage(message, messageId)}
                onBranch={onBranch}
              />
            ) : (
              <ProcessMessage
                key={messageId}
                copied={copied}
                failed={failed}
                message={message}
                processId={processId}
                onCopy={() => copyMessage(message, messageId)}
              />
            );
          })}
        </>
      )}
      {showJumpLatest ? (
        <button type="button" class="gsv-chat-jump-latest" onClick={scrollToLatest}>
          LATEST
        </button>
      ) : null}
    </div>
  );
}
