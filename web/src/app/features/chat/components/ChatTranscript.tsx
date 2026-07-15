import type { ComponentChildren } from "preact";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import DOMPurify from "dompurify";
import { parse as parseMarkdown } from "marked";
import { SystemMessage } from "../../../components/ui/SystemMessage";
import { Hint, Tooltip } from "../../../components/ui/Tooltip";
import type {
  ChatBackupModelInfo,
  ChatTranscriptRow,
  ChatTranscriptRowRole,
} from "../domain/transcript";
import {
  useVirtualTranscript,
  type VirtualTranscriptItem,
  type VirtualTranscriptSource,
} from "../hooks/useVirtualTranscript";
import type { ChatFeedbackEntry } from "../hooks/useChatFeedback";
import { ChatFeedbackMessage } from "./ChatFeedbackMessage";
import { ChatMediaAttachment } from "./ChatMediaAttachment";
import {
  chatTranscriptActiveGroupIndex,
  chatTranscriptActivityGroupTone,
  chatTranscriptToolGroupTone,
  chatTranscriptToolStatusLabel,
  chatTranscriptToolTone,
  type ChatTranscriptToolTone,
} from "./ChatTranscriptToolStatus";
import {
  chatTranscriptIsAtBottom,
  chatTranscriptShouldPauseFollowForWheel,
  nextChatTranscriptBottomFollow,
} from "./ChatTranscriptScrollPolicy";

export type ChatDockMessageRole = ChatTranscriptRowRole;
export type ChatDockMessage = ChatTranscriptRow;

type ChatTranscriptProps = {
  activeRunId?: string | null;
  messages: readonly ChatDockMessage[];
  state?: "empty" | "error" | "loading" | "ready";
  emptyTitle?: string;
  emptyDescription?: string;
  errorMessage?: string;
  action?: ComponentChildren;
  conversationId?: string | null;
  /** Ephemeral operation feedback lines appended after the newest message. */
  feedback?: readonly ChatFeedbackEntry[];
  hasOlderMessages?: boolean;
  loadingOlderMessages?: boolean;
  onLoadOlder?: () => Promise<void> | void;
  processId?: string;
  onBranch?: (messageId: number) => void;
};

type CopyState = {
  id: string;
  status: "copied" | "failed";
};

type TranscriptActivityEntry =
  | { kind: "backup"; message: ChatDockMessage }
  | { kind: "reasoning"; message: ChatDockMessage }
  | { kind: "tool"; message: ChatDockMessage };

type TranscriptRenderItem =
  | { kind: "message"; id: string; index: number; message: ChatDockMessage }
  | { kind: "activityGroup"; entries: TranscriptActivityEntry[]; id: string; index: number };

type TranscriptVirtualEntry = VirtualTranscriptSource & (
  | { kind: "olderLoader" }
  | { item: TranscriptRenderItem; kind: "item" }
  | { feedback: ChatFeedbackEntry; kind: "feedback" }
);

type TranscriptViewport = {
  height: number;
  scrollTop: number;
};

const EMPTY_VIEWPORT: TranscriptViewport = {
  height: 0,
  scrollTop: 0,
};

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
    <Hint
      text={copied ? "Copied to clipboard" : "Copy message text"}
      position={role === "user" ? "top-end" : "top"}
    >
      <button
        type="button"
        class={`gsv-chat-copy${failed ? " is-failed" : ""}`}
        disabled={!text.trim()}
        onClick={onCopy}
        aria-label={copied ? `Copied ${roleLabel(role).toLowerCase()} message` : `Copy ${roleLabel(role).toLowerCase()} message`}
      >
        <svg width="10" height="10" viewBox="0 0 16 16" aria-hidden="true">
          <g fill="none" stroke="currentColor" stroke-width="1.5">
            <rect x="3" y="3" width="7" height="7" />
            <rect x="6" y="6" width="7" height="7" />
          </g>
        </svg>
        {label}
      </button>
    </Hint>
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

function renderMarkdownHtml(value: string): string {
  try {
    const html = parseMarkdown(value, { async: false, breaks: true, gfm: true });
    return DOMPurify.sanitize(html);
  } catch {
    return DOMPurify.sanitize(value);
  }
}

function MarkdownText({ text }: { text: string }) {
  return (
    <div
      class="gsv-chat-rich-text"
      dangerouslySetInnerHTML={{ __html: renderMarkdownHtml(text) }}
    />
  );
}

function CodeBlock({ code, language }: { code: string; language: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof globalThis.setTimeout> | null>(null);

  useEffect(() => () => {
    if (timerRef.current !== null) {
      globalThis.clearTimeout(timerRef.current);
    }
  }, []);

  const copyCode = () => {
    void copyText(code).then((ok) => {
      if (!ok) {
        return;
      }
      setCopied(true);
      if (timerRef.current !== null) {
        globalThis.clearTimeout(timerRef.current);
      }
      timerRef.current = globalThis.setTimeout(() => {
        setCopied(false);
        timerRef.current = null;
      }, 1400);
    });
  };

  return (
    <figure class="gsv-chat-code-block">
      <figcaption>
        <span>{language}</span>
        <button type="button" onClick={copyCode}>{copied ? "COPIED" : "COPY"}</button>
      </figcaption>
      <pre><code>{code}</code></pre>
    </figure>
  );
}

function StreamingText({ text }: { text: string }) {
  return <div class="gsv-chat-rich-text is-streaming">{text}</div>;
}

function AssistantText({ streaming = false, text }: { streaming?: boolean; text: string }) {
  const blocks = streaming ? (
    <StreamingText text={text} />
  ) : assistantBlocks(text).map((block, index) => block.kind === "code" ? (
    <CodeBlock code={block.code} language={block.language} key={`code:${index}`} />
  ) : (
    <MarkdownText text={block.text} key={`text:${index}`} />
  ));

  return (
    <div class="gsv-chat-assistant-rich gsv-prose">
      {blocks}
    </div>
  );
}

function BackupModelBadge({ backupModel }: { backupModel: ChatBackupModelInfo }) {
  return (
    <Tooltip text={backupModelDetails(backupModel)} position="top">
      <span class="gsv-chat-backup-model-badge">Backup</span>
    </Tooltip>
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

function isEmptyObjectText(value: string): boolean {
  return value.trim() === "{}" || value.trim() === "[]";
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function truncateBlock(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength).trimEnd()}\n...`;
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

function modelRefLabel(ref: ChatBackupModelInfo["from"] | undefined): string {
  const provider = ref?.provider?.trim();
  const model = ref?.model?.trim();
  if (provider && model) {
    return `${provider} / ${model}`;
  }
  return model || provider || "selected model";
}

function backupModelSummary(backupModel: ChatBackupModelInfo): string {
  return `The selected model failed, so GSV continued with ${modelRefLabel(backupModel.to)}.`;
}

function backupModelDetails(backupModel: ChatBackupModelInfo): string {
  const lines = [backupModelSummary(backupModel)];
  if (backupModel.reason) {
    lines.push(`Reason: ${backupModel.reason}`);
  }
  return lines.join("\n");
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

function toolEntryTone(message: ChatDockMessage): ChatTranscriptToolTone {
  return chatTranscriptToolTone(message);
}

function toolStatusLabel(message: ChatDockMessage): string {
  return chatTranscriptToolStatusLabel(message);
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

type ToolDetailSection = {
  body: ComponentChildren;
  label: string;
};

function textDetail(label: string, value: unknown, maxLength = 12000): ToolDetailSection | null {
  const text = typeof value === "string" ? value : formatToolDetailValue(value);
  if (!text.trim() || isEmptyObjectText(text)) {
    return null;
  }
  return {
    label,
    body: <pre>{truncateBlock(text, maxLength)}</pre>,
  };
}

function fileToolKind(syscall: string | null): "read" | "write" | "edit" | "delete" | null {
  if (syscall === "fs.read") return "read";
  if (syscall === "fs.write") return "write";
  if (syscall === "fs.edit") return "edit";
  if (syscall === "fs.delete") return "delete";
  return null;
}

function readToolDetails(output: unknown): ToolDetailSection | null {
  const record = asRecord(output);
  const content = optionalString(record?.content);
  if (content !== null) {
    return content.trim()
      ? textDetail("CONTENT", content)
      : { label: "CONTENT", body: <p class="gsv-chat-tool-muted">Empty file.</p> };
  }
  const directories = Array.isArray(record?.directories) ? record.directories : [];
  const files = Array.isArray(record?.files) ? record.files : [];
  if (directories.length || files.length) {
    const listing = [
      ...directories.map((item) => `${String(item)}/`),
      ...files.map((item) => String(item)),
    ].join("\n");
    return textDetail("LISTING", listing);
  }
  return textDetail("OUTPUT", output);
}

function shellToolDetails(output: unknown): ToolDetailSection[] {
  const record = asRecord(output);
  const stdout = optionalString(record?.stdout);
  const stderr = optionalString(record?.stderr);
  const sections = [
    stdout !== null ? textDetail("STDOUT", stdout) : null,
    stderr !== null ? textDetail("STDERR", stderr) : null,
  ].filter((section): section is ToolDetailSection => section !== null);
  return sections.length > 0
    ? sections
    : [textDetail("OUTPUT", output)].filter((section): section is ToolDetailSection => section !== null);
}

function codeModeToolDetails(output: unknown): ToolDetailSection[] {
  const record = asRecord(output);
  const logs = Array.isArray(record?.logs)
    ? record.logs.map((item) => typeof item === "string" ? item : formatToolDetailValue(item)).filter(Boolean).join("\n")
    : "";
  const sections = [
    textDetail("LOGS", logs),
    textDetail("ERROR", record?.error),
    textDetail("RESULT", record?.result ?? output),
  ].filter((section): section is ToolDetailSection => section !== null);
  return sections.length > 0 ? sections : [];
}

function searchToolDetails(output: unknown): ToolDetailSection | null {
  const record = asRecord(output);
  const matches = Array.isArray(record?.matches) ? record.matches : [];
  if (matches.length > 0) {
    return textDetail("MATCHES", matches);
  }
  return textDetail("OUTPUT", output);
}

function editToolDiff(args: Record<string, unknown> | null): ToolDetailSection | null {
  const oldText = optionalString(args?.oldString);
  const newText = optionalString(args?.newString);
  if (oldText === null && newText === null) {
    return null;
  }
  return {
    label: "DIFF",
    body: <ToolDiffPreview oldText={oldText ?? ""} newText={newText ?? ""} />,
  };
}

function toolDetailSections(tool: ChatDockMessage): ToolDetailSection[] {
  const syscall = toolSyscall(tool);
  const kind = fileToolKind(syscall);
  const args = asRecord(tool.toolArgs);
  const sections: ToolDetailSection[] = [];

  if (kind === "write") {
    const content = optionalString(args?.content);
    if (content !== null) {
      const detail = content.trim()
        ? textDetail("CONTENT", content)
        : { label: "CONTENT", body: <p class="gsv-chat-tool-muted">Empty file.</p> };
      if (detail) {
        sections.push(detail);
      }
    }
  } else if (kind === "edit") {
    const diff = editToolDiff(args);
    if (diff) sections.push(diff);
  } else if (kind === "read" && tool.role === "toolResult") {
    const detail = readToolDetails(tool.toolOutput);
    if (detail) sections.push(detail);
  } else if (syscall === "shell.exec" && tool.role === "toolResult") {
    sections.push(...shellToolDetails(tool.toolOutput));
  } else if ((syscall === "codemode.exec" || syscall === "codemode.run") && tool.role === "toolResult") {
    sections.push(...codeModeToolDetails(tool.toolOutput));
  } else if (syscall === "fs.search" && tool.role === "toolResult") {
    const detail = searchToolDetails(tool.toolOutput);
    if (detail) sections.push(detail);
  }

  if (tool.role === "tool" && sections.length === 0) {
    const input = textDetail("INPUT", tool.toolArgs);
    if (input) sections.push(input);
  }
  if (tool.role === "toolResult" && sections.length === 0) {
    const output = textDetail("OUTPUT", tool.toolOutput ?? tool.text);
    if (output) sections.push(output);
  }
  return sections;
}

function ToolDiffPreview({ oldText, newText }: { oldText: string; newText: string }) {
  const oldLines = oldText.length > 0 ? oldText.split("\n") : [""];
  const newLines = newText.length > 0 ? newText.split("\n") : [""];
  return (
    <pre class="gsv-chat-tool-diff">
      {oldLines.map((line, index) => (
        <span class="is-removed" key={`old:${index}`}>- {line}</span>
      ))}
      {newLines.map((line, index) => (
        <span class="is-added" key={`new:${index}`}>+ {line}</span>
      ))}
    </pre>
  );
}

function toolActivityTitle(message: ChatDockMessage): string {
  const syscall = toolSyscall(message);
  const target = toolPathTarget(message) || "file";
  const tone = toolEntryTone(message);
  const running = tone === "running";
  const failed = tone === "error";
  const warning = tone === "warning";
  const denied = message.toolOutcome === "denied";

  if (syscall === "fs.read") {
    if (warning) return denied ? `Read access denied for ${target}` : `Stopped reading ${target}`;
    return failed ? `Could not read ${target}` : running ? `Reading ${target}` : `Read ${target}`;
  }
  if (syscall === "fs.write") {
    if (warning) return denied ? `Write access denied for ${target}` : `Stopped writing ${target}`;
    return failed ? `Could not write ${target}` : running ? `Writing ${target}` : `Wrote ${target}`;
  }
  if (syscall === "fs.edit") {
    if (warning) return denied ? `Edit access denied for ${target}` : `Stopped editing ${target}`;
    return failed ? `Could not edit ${target}` : running ? `Editing ${target}` : `Edited ${target}`;
  }
  if (syscall === "fs.delete") {
    if (warning) return denied ? `Delete access denied for ${target}` : `Stopped deleting ${target}`;
    return failed ? `Could not delete ${target}` : running ? `Deleting ${target}` : `Deleted ${target}`;
  }
  if (syscall === "fs.search") {
    if (warning) return denied ? "Search access denied" : "Stopped searching files";
    return failed ? "Search failed" : running ? "Searching files" : "Searched files";
  }
  if (syscall === "shell.exec") {
    const input = shellInputText(message);
    if (warning) {
      return denied ? "Command access denied" : "Command cancelled";
    }
    if (failed) {
      return input ? `Failed ${truncateInline(input, 72)}` : "Command failed";
    }
    if (running) {
      return input ? `Running ${truncateInline(input, 72)}` : "Running command";
    }
    return input ? `Ran ${truncateInline(input, 72)}` : "Ran shell input";
  }
  if (syscall === "codemode.exec" || syscall === "codemode.run") {
    if (warning) return denied ? "CodeMode access denied" : "CodeMode cancelled";
    return failed ? "CodeMode failed" : running ? "Running CodeMode script" : "Ran CodeMode script";
  }
  if (syscall === "sys.mcp.call") {
    if (warning) return denied ? "MCP tool access denied" : "MCP tool cancelled";
    return failed ? "MCP tool failed" : running ? "Calling MCP tool" : "Called MCP tool";
  }

  const name = toolDisplayName(message);
  if (warning) return `${name} ${denied ? "denied" : "cancelled"}`;
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
  if (tone === "warning") {
    return message.text || (message.toolOutcome === "denied" ? "Tool access denied." : "Tool call cancelled.");
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

function toolGroupStatus(tools: readonly ChatDockMessage[]): ChatTranscriptToolTone {
  return chatTranscriptToolGroupTone(tools);
}

function toolGroupTitle(tools: readonly ChatDockMessage[]): string {
  const status = toolGroupStatus(tools);
  if (status === "error") {
    const failed = [...tools].reverse().find((message) => toolEntryTone(message) === "error");
    return failed ? lowercaseFirst(toolActivityTitle(failed)) : "activity needs attention";
  }
  if (status === "warning") {
    const expected = [...tools].reverse().find((message) => toolEntryTone(message) === "warning");
    return expected ? lowercaseFirst(toolActivityTitle(expected)) : "activity stopped";
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

function isBackupModelOnlyMessage(message: ChatDockMessage): boolean {
  return normalizedRole(message.role) === "assistant"
    && Boolean(message.backupModel)
    && !message.text.trim()
    && !reasoningText(message);
}

function isToolMessage(message: ChatDockMessage): boolean {
  const role = normalizedRole(message.role);
  return role === "tool" || role === "toolResult";
}

function activityEntryForMessage(message: ChatDockMessage): TranscriptActivityEntry | null {
  if (isBackupModelOnlyMessage(message)) {
    return { kind: "backup", message };
  }
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
    const stableKey = firstMessage?.id || identifier;
    items.push({
      kind: "activityGroup",
      entries,
      id: `activity-group:${identifier}:${stableKey}`,
      index: startIndex,
    });
  }

  return items;
}

function estimateMessageHeight(message: ChatDockMessage): number {
  const role = normalizedRole(message.role);
  const textLength = message.text.length + (message.thinking?.join("\n\n").length ?? 0);
  const mediaHeight = (message.media?.length ?? 0) * 92;
  if (role === "user") {
    return Math.max(72, 44 + Math.ceil(textLength / 48) * 22 + mediaHeight);
  }
  if (role === "assistant") {
    return Math.max(86, 52 + Math.ceil(textLength / 72) * 23 + mediaHeight);
  }
  if (role === "system") {
    return Math.max(64, 44 + Math.ceil(textLength / 80) * 18);
  }
  return Math.max(120, 92 + Math.ceil(textLength / 72) * 18);
}

function estimateRenderItemHeight(item: TranscriptRenderItem, active: boolean): number {
  if (item.kind === "activityGroup") {
    const status = activityGroupStatus(item.entries, active);
    const expanded = status === "running";
    return expanded ? Math.max(112, 76 + item.entries.length * 42) : 58;
  }
  return estimateMessageHeight(item.message);
}

function estimateKeyForRenderItem(item: TranscriptRenderItem): string {
  if (item.kind === "activityGroup") {
    const signature = item.entries
      .map((entry) => `${entry.kind}:${entry.message.id}:${entry.message.status ?? ""}:${entry.message.toolOutcome ?? ""}:${entry.message.text.length}:${reasoningText(entry.message).length}:${entry.message.backupModel ? "backup" : ""}`)
      .join("|");
    return `${item.id}:${signature}`;
  }
  return `${item.id}:${item.message.status ?? ""}:${item.message.toolOutcome ?? ""}:${item.message.text.length}:${reasoningText(item.message).length}:${item.message.backupModel ? "backup" : ""}:${item.message.media?.length ?? 0}`;
}

function buildVirtualEntries({
  activeActivityGroupId,
  feedback,
  hasOlderMessages,
  loadingOlderMessages,
  renderItems,
}: {
  activeActivityGroupId: string | null;
  feedback: readonly ChatFeedbackEntry[];
  hasOlderMessages: boolean;
  loadingOlderMessages: boolean;
  renderItems: TranscriptRenderItem[];
}): TranscriptVirtualEntry[] {
  const entries: TranscriptVirtualEntry[] = [];
  if (hasOlderMessages || loadingOlderMessages) {
    entries.push({
      alwaysRender: true,
      estimateHeight: 30,
      estimateKey: `older:${loadingOlderMessages}`,
      key: "older-loader",
      kind: "olderLoader",
    });
  }
  for (const item of renderItems) {
    const active = item.kind === "activityGroup" && item.id === activeActivityGroupId;
    entries.push({
      alwaysRender: item.kind === "activityGroup" && activityGroupStatus(item.entries, active) === "running",
      estimateHeight: estimateRenderItemHeight(item, active),
      estimateKey: estimateKeyForRenderItem(item),
      item,
      key: item.id,
      kind: "item",
    });
  }
  for (const entry of feedback) {
    entries.push({
      alwaysRender: entry.status === "running",
      estimateHeight: 34,
      estimateKey: `${entry.status}|${entry.label}`,
      feedback: entry,
      key: `feedback:${entry.id}`,
      kind: "feedback",
    });
  }
  return entries;
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
        {message.text ? <div class="gsv-chat-user-message-text gsv-prose">{message.text}</div> : null}
        {message.media?.length ? (
          <div class="gsv-chat-media-list">
            {message.media.map((media, index) => (
              <ChatMediaAttachment key={`${message.id}:media:${index}`} media={media} processId={processId} />
            ))}
          </div>
        ) : null}
        <div class="gsv-chat-user-message-meta gsv-sublabel">
          {message.time ? <span>{message.time}</span> : null}
          {origin ? <span title={origin}>{origin}</span> : null}
          {message.messageId && onBranch ? (
            <Hint text="Branch a new conversation from this message" position="top-end">
              <button type="button" class="gsv-chat-copy" onClick={() => onBranch(message.messageId as number)}>
                BRANCH
              </button>
            </Hint>
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
  const tone = toolEntryTone(message);
  const status = toolStatusLabel(message);
  const identifier = message.toolCallId || message.runId || message.id;
  const output = message.role === "tool" && message.status === "planning"
    ? "Preparing tool call."
    : message.text;
  const argsText = formatToolDetailValue(message.toolArgs);
  const outputText = formatToolDetailValue(message.toolOutput);
  const hasDetails = Boolean(argsText.trim() || outputText.trim());

  return (
    <article class={`gsv-chat-tool-card is-${tone}${message.role === "tool" ? " is-pending" : ""}`}>
      <span class="gsv-chat-tool-corner is-top-left" aria-hidden="true" />
      <span class="gsv-chat-tool-corner is-top-right" aria-hidden="true" />
      <span class="gsv-chat-tool-corner is-bottom-left" aria-hidden="true" />
      <span class="gsv-chat-tool-corner is-bottom-right" aria-hidden="true" />

      <header class="gsv-chat-tool-card-head">
        <span class="gsv-chat-tool-card-dot" aria-hidden="true" />
        <strong class="gsv-prose">{title}</strong>
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

function activityGroupStatus(
  entries: readonly TranscriptActivityEntry[],
  active = false,
): ChatTranscriptToolTone {
  return chatTranscriptActivityGroupTone(entries, active);
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

function activityGroupTitle(
  entries: readonly TranscriptActivityEntry[],
  active: boolean,
): string {
  const tools = entries.filter((entry) => entry.kind === "tool").map((entry) => entry.message);
  const backups = entries.filter((entry) => entry.kind === "backup");
  const status = activityGroupStatus(entries, active);
  const duration = activityDuration(entries);

  if (status === "done" && duration && entries.length > 1) {
    return tools.length > 0 ? `worked for ${duration}` : `reasoned for ${duration}`;
  }
  if (tools.length > 0) {
    return toolGroupTitle(tools);
  }
  if (backups.length > 0) {
    return status === "running" ? "switching to backup model" : "used backup model";
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
    <Hint text={hasDetails ? (expanded ? `Hide ${label.toLowerCase()} · ${status}` : `Show ${label.toLowerCase()} · ${status}`) : status} position="left">
    <div class="gsv-chat-tool-entry-controls" aria-label={status}>
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
    </Hint>
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
        <strong class="gsv-prose">{message.streaming ? "Thinking" : "Reasoned"}</strong>
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

function BackupModelEntry({ message }: { message: ChatDockMessage }) {
  const [expanded, setExpanded] = useState(false);
  const backupModel = message.backupModel;
  const details = backupModel ? backupModelDetails(backupModel) : "";
  const running = message.streaming === true || message.status === "running";
  return (
    <div class={`gsv-chat-tool-entry gsv-chat-backup-model-entry${running ? " is-running" : " is-done"}`}>
      <span class="gsv-chat-tool-entry-status" aria-hidden="true" />
      <div class="gsv-chat-tool-entry-main">
        <strong class="gsv-prose">{running ? "Switching to backup model" : "Backup model used"}</strong>
      </div>
      <EntryControls
        expanded={expanded}
        hasDetails={Boolean(details)}
        label="DETAILS"
        status={running ? "RUNNING" : "DONE"}
        onToggle={() => setExpanded((value) => !value)}
      />
      {details && expanded ? (
        <div class="gsv-chat-tool-entry-detail-body">
          <pre>{details}</pre>
        </div>
      ) : null}
    </div>
  );
}

function ToolEntry({ tool }: { tool: ChatDockMessage }) {
  const [expanded, setExpanded] = useState(false);
  const tone = toolEntryTone(tool);
  const details = toolDetailSections(tool);
  const hasDetails = details.length > 0;
  return (
    <div class={`gsv-chat-tool-entry is-${tone}`}>
      <span class="gsv-chat-tool-entry-status" aria-hidden="true" />
      <div class="gsv-chat-tool-entry-main">
        <strong class="gsv-prose">{toolActivityTitle(tool)}</strong>
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
          {details.map((section, index) => (
            <div class="gsv-chat-tool-detail-section" key={`${section.label}:${index}`}>
              <small>{section.label}</small>
              {section.body}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function RunActivityCard({
  active,
  entries,
}: {
  active: boolean;
  entries: readonly TranscriptActivityEntry[];
}) {
  const status = activityGroupStatus(entries, active);
  const [expanded, setExpanded] = useState(status === "running");
  const wasRunningRef = useRef(status === "running");
  const runId = entries.find((entry) => entry.message.runId)?.message.runId;
  const title = activityGroupTitle(entries, active);
  const warningTool = status === "warning"
    ? [...entries].reverse().find((entry) => entry.kind === "tool" && toolEntryTone(entry.message) === "warning")
    : null;
  const statusLabel = status === "error"
    ? "ERROR"
    : status === "running"
      ? "RUNNING"
      : warningTool
        ? toolStatusLabel(warningTool.message)
        : "DONE";

  useEffect(() => {
    if (status === "running" && !wasRunningRef.current) {
      setExpanded(true);
    }
    wasRunningRef.current = status === "running";
  }, [status]);

  return (
    <article class={`gsv-chat-tool-group-card is-${status}`}>
      <span class="gsv-chat-tool-corner is-top-left" aria-hidden="true" />
      <span class="gsv-chat-tool-corner is-top-right" aria-hidden="true" />
      <span class="gsv-chat-tool-corner is-bottom-left" aria-hidden="true" />
      <span class="gsv-chat-tool-corner is-bottom-right" aria-hidden="true" />

      <header class="gsv-chat-tool-group-head">
        <span class="gsv-chat-tool-group-dot" aria-hidden="true" />
        <strong class="gsv-prose">{title}</strong>
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
            {entries.map((entry, index) => {
              if (entry.kind === "backup") {
                return <BackupModelEntry key={`backup:${entry.message.id}:${index}`} message={entry.message} />;
              }
              if (entry.kind === "reasoning") {
                return <ReasoningEntry key={`reasoning:${entry.message.id}:${index}`} message={entry.message} />;
              }
              return <ToolEntry key={`tool:${entry.message.toolCallId || entry.message.id}:${index}`} tool={entry.message} />;
            })}
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
  const hasMeta = Boolean(message.backupModel || reasoning);

  return (
    <>
      <SystemMessage
        text={assistantText}
        time={message.time}
        meta={hasMeta ? (
          <>
            {message.backupModel ? <BackupModelBadge backupModel={message.backupModel} /> : null}
            {reasoning ? (
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
          </>
        ) : null}
        copyLabel={copyButtonLabel(copied, failed)}
        copyDisabled={!assistantText.trim()}
        copyFailed={failed}
        copyTitle={copied ? "Copied" : "Copy message"}
        copyAriaLabel={copied ? "Copied assistant message" : "Copy assistant message"}
        onCopy={onCopy}
      >
        <AssistantText text={assistantText} streaming={message.streaming === true} />
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
          <div class="gsv-chat-message-head gsv-sublabel">
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
        <div class="gsv-chat-message-meta gsv-sublabel">
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

function VirtualTranscriptRow({
  children,
  item,
  setItemNode,
}: {
  children: ComponentChildren;
  item: VirtualTranscriptItem<TranscriptVirtualEntry>;
  setItemNode(key: string, estimateKey: string, node: HTMLElement | null): void;
}) {
  const setNode = useCallback((node: HTMLElement | null) => {
    setItemNode(item.entry.key, item.entry.estimateKey ?? String(Math.round(item.entry.estimateHeight)), node);
  }, [item.entry, setItemNode]);
  return (
    <div
      class="gsv-chat-transcript-virtual-item"
      ref={setNode}
      style={{ transform: `translateY(${item.top}px)` }}
    >
      {children}
    </div>
  );
}

function TranscriptRenderItemView({
  activeActivityGroupId,
  copyState,
  item,
  onBranch,
  onCopy,
  processId,
}: {
  activeActivityGroupId: string | null;
  copyState: CopyState | null;
  item: TranscriptRenderItem;
  onBranch?: (messageId: number) => void;
  onCopy: (message: ChatDockMessage, messageId: string) => void;
  processId: string;
}) {
  if (item.kind === "activityGroup") {
    return <RunActivityCard active={item.id === activeActivityGroupId} entries={item.entries} />;
  }

  const message = item.message;
  const messageRole = normalizedRole(message.role);
  const messageId = `${messageRole}:${message.id}:${item.index}`;
  const copied = copyState?.id === messageId && copyState.status === "copied";
  const failed = copyState?.id === messageId && copyState.status === "failed";

  return messageRole === "user" ? (
    <UserMessage
      copied={copied}
      failed={failed}
      message={message}
      processId={processId}
      onCopy={() => onCopy(message, messageId)}
      onBranch={onBranch}
    />
  ) : (
    <ProcessMessage
      copied={copied}
      failed={failed}
      message={message}
      processId={processId}
      onCopy={() => onCopy(message, messageId)}
    />
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
      <strong class="gsv-listitem">{title}</strong>
      <span class="gsv-prose">{description}</span>
      {action ? <div class="gsv-chat-empty-action">{action}</div> : null}
    </div>
  );
}

function nestedScrollerCanScrollUp(target: EventTarget | null, boundary: HTMLElement): boolean {
  let element = target instanceof Element ? target : null;
  while (element && element !== boundary) {
    const overflowY = window.getComputedStyle(element).overflowY;
    if (
      (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay")
      && element.scrollHeight > element.clientHeight
      && element.scrollTop > 0
    ) {
      return true;
    }
    element = element.parentElement;
  }
  return false;
}

export function ChatTranscript({
  action,
  activeRunId = null,
  emptyDescription = "Process history will appear here when a conversation is available.",
  emptyTitle = "No active conversation",
  errorMessage = "Process history could not be loaded.",
  conversationId = null,
  feedback = [],
  hasOlderMessages = false,
  loadingOlderMessages = false,
  messages,
  onBranch,
  onLoadOlder,
  processId = "",
  state = "ready",
}: ChatTranscriptProps) {
  const [copyState, setCopyState] = useState<CopyState | null>(null);
  const copyResetTimer = useRef<ReturnType<typeof globalThis.setTimeout> | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const scrollAnchorRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
  const lastTranscriptIdentityRef = useRef("");
  const [showJumpLatest, setShowJumpLatest] = useState(false);
  const [viewport, setViewport] = useState<TranscriptViewport>(EMPTY_VIEWPORT);
  const renderItems = useMemo(() => buildTranscriptRenderItems(messages), [messages]);
  const activeActivityGroupId = useMemo(() => {
    const groups = renderItems.filter((item) => item.kind === "activityGroup");
    const activeIndex = chatTranscriptActiveGroupIndex(
      groups.map((group) => group.entries),
      activeRunId,
    );
    return activeIndex >= 0 ? groups[activeIndex].id : null;
  }, [activeRunId, renderItems]);
  const virtualEntries = useMemo(() => buildVirtualEntries({
    activeActivityGroupId,
    feedback,
    hasOlderMessages,
    loadingOlderMessages,
    renderItems,
  }), [activeActivityGroupId, feedback, hasOlderMessages, loadingOlderMessages, renderItems]);
  const virtual = useVirtualTranscript({
    entries: virtualEntries,
    scrollTop: viewport.scrollTop,
    viewportHeight: viewport.height,
  });

  useEffect(() => () => {
    if (copyResetTimer.current !== null) {
      globalThis.clearTimeout(copyResetTimer.current);
    }
  }, []);

  const updateViewportForNode = useCallback((node: HTMLDivElement) => {
    setViewport((current) => {
      const next = {
        height: node.clientHeight,
        scrollTop: node.scrollTop,
      };
      return current.height === next.height && current.scrollTop === next.scrollTop
        ? current
        : next;
    });
  }, []);

  const setTranscriptRef = useCallback((node: HTMLDivElement | null) => {
    transcriptRef.current = node;
    if (node) {
      lastScrollTopRef.current = node.scrollTop;
      updateViewportForNode(node);
    }
  }, [updateViewportForNode]);

  useLayoutEffect(() => {
    const node = transcriptRef.current;
    if (!node) {
      return undefined;
    }
    const update = () => updateViewportForNode(node);
    update();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", update);
      return () => window.removeEventListener("resize", update);
    }
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, [updateViewportForNode]);

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

  const scrollToLatest = useCallback(() => {
    const node = transcriptRef.current;
    if (!node) {
      return;
    }
    node.scrollTop = node.scrollHeight;
    lastScrollTopRef.current = node.scrollTop;
    stickToBottomRef.current = true;
    setShowJumpLatest(false);
    updateViewportForNode(node);
  }, [updateViewportForNode]);

  const handleScroll = () => {
    const node = transcriptRef.current;
    if (!node) {
      return;
    }
    setViewport((current) => current.scrollTop === node.scrollTop
      ? current
      : { ...current, scrollTop: node.scrollTop });
    const userScrolledUp = node.scrollTop < lastScrollTopRef.current;
    lastScrollTopRef.current = node.scrollTop;
    const atBottom = chatTranscriptIsAtBottom(node);
    stickToBottomRef.current = nextChatTranscriptBottomFollow({
      atBottom,
      following: stickToBottomRef.current,
      userScrolledUp,
    });
    setShowJumpLatest(!atBottom);
    if (hasOlderMessages && !loadingOlderMessages && node.scrollTop <= 96 && onLoadOlder) {
      loadOlderWithAnchor();
    }
  };

  const handleWheel = (event: WheelEvent) => {
    const node = transcriptRef.current;
    if (!node || !chatTranscriptShouldPauseFollowForWheel({
      defaultPrevented: event.defaultPrevented,
      deltaY: event.deltaY,
      nestedScrollerCanScrollUp: nestedScrollerCanScrollUp(event.target, node),
      transcript: node,
    })) {
      return;
    }
    const previousScrollTop = node.scrollTop;
    stickToBottomRef.current = nextChatTranscriptBottomFollow({
      atBottom: chatTranscriptIsAtBottom(node),
      following: stickToBottomRef.current,
      userScrolledUp: true,
    });
    requestAnimationFrame(() => {
      const currentNode = transcriptRef.current;
      if (
        currentNode === node
        && currentNode.scrollTop === previousScrollTop
        && chatTranscriptIsAtBottom(currentNode)
      ) {
        stickToBottomRef.current = true;
      }
    });
  };

  const loadOlderWithAnchor = () => {
    const node = transcriptRef.current;
    if (!node || !hasOlderMessages || loadingOlderMessages || !onLoadOlder) {
      return;
    }
    stickToBottomRef.current = false;
    scrollAnchorRef.current = {
      scrollHeight: node.scrollHeight,
      scrollTop: node.scrollTop,
    };
    void Promise.resolve(onLoadOlder()).catch(() => {});
  };

  const transcriptIdentity = `${processId}:${conversationId ?? ""}`;
  const tailMessage = messages[messages.length - 1];
  const tailKey = `${transcriptIdentity}:${messages.length}:${tailMessage?.id ?? "empty"}`;
  const feedbackKey = feedback.map((entry) => `${entry.id}:${entry.status}:${entry.label}`).join("|");

  useLayoutEffect(() => {
    const anchor = scrollAnchorRef.current;
    const node = transcriptRef.current;
    if (!node) {
      return undefined;
    }

    const previousIdentity = lastTranscriptIdentityRef.current;
    const identityChanged = previousIdentity !== transcriptIdentity;
    lastTranscriptIdentityRef.current = transcriptIdentity;

    if (identityChanged || messages.length === 0) {
      stickToBottomRef.current = true;
    }

    if (anchor) {
      const frame = requestAnimationFrame(() => {
        const anchoredNode = transcriptRef.current;
        scrollAnchorRef.current = null;
        if (!anchoredNode) {
          return;
        }
        anchoredNode.scrollTop = anchoredNode.scrollHeight - anchor.scrollHeight + anchor.scrollTop;
        lastScrollTopRef.current = anchoredNode.scrollTop;
        updateViewportForNode(anchoredNode);
      });
      return () => cancelAnimationFrame(frame);
    }

    if (!stickToBottomRef.current || messages.length === 0) {
      return undefined;
    }

    node.scrollTop = node.scrollHeight;
    lastScrollTopRef.current = node.scrollTop;
    setShowJumpLatest(false);
    updateViewportForNode(node);
    const frame = requestAnimationFrame(() => {
      const latestNode = transcriptRef.current;
      if (!latestNode || !stickToBottomRef.current) {
        return;
      }
      latestNode.scrollTop = latestNode.scrollHeight;
      lastScrollTopRef.current = latestNode.scrollTop;
      setShowJumpLatest(false);
      updateViewportForNode(latestNode);
    });
    return () => cancelAnimationFrame(frame);
  }, [feedbackKey, messages.length, tailKey, transcriptIdentity, updateViewportForNode, virtual.totalHeight]);

  return (
    <div
      class="gsv-chat-transcript"
      aria-live="polite"
      ref={setTranscriptRef}
      onScroll={handleScroll}
      onWheel={handleWheel}
    >
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
        <div class="gsv-chat-transcript-virtual" style={{ height: `${virtual.totalHeight}px` }}>
          {virtual.items.map((item) => (
            <VirtualTranscriptRow
              item={item}
              key={item.entry.key}
              setItemNode={virtual.setItemNode}
            >
              {item.entry.kind === "olderLoader" ? (
                <button
                  type="button"
                  class="gsv-chat-load-older"
                  disabled={loadingOlderMessages}
                  onClick={loadOlderWithAnchor}
                >
                  {loadingOlderMessages ? "LOADING" : "LOAD OLDER"}
                </button>
              ) : item.entry.kind === "feedback" ? (
                <ChatFeedbackMessage
                  label={item.entry.feedback.label}
                  status={item.entry.feedback.status}
                />
              ) : (
                <TranscriptRenderItemView
                  activeActivityGroupId={activeActivityGroupId}
                  copyState={copyState}
                  item={item.entry.item}
                  onBranch={onBranch}
                  onCopy={copyMessage}
                  processId={processId}
                />
              )}
            </VirtualTranscriptRow>
          ))}
        </div>
      )}
      {showJumpLatest ? (
        <button type="button" class="gsv-chat-jump-latest" onClick={scrollToLatest}>
          LATEST
        </button>
      ) : null}
    </div>
  );
}
