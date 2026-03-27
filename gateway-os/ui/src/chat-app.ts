import DOMPurify from "dompurify";
import { marked } from "marked";

import type { AppInstance, AppRuntimeContext } from "./app-runtime";
import { OPEN_APP_EVENT, type OpenAppEventDetail } from "./app-link";
import {
  TARGET_CHAT_PROCESS_EVENT,
  consumePendingChatProcess,
  type TargetChatProcessEventDetail,
} from "./chat-process-link";
import type { ProcHistoryResult } from "./gateway-client";
import type { AppElementContext, AppKernelClient, GsvAppElement } from "./app-sdk";
import {
  getActiveThreadContext,
  normalizeThreadContext,
  setActiveThreadContext,
  type ThreadContext,
} from "./thread-context";

type ChatRole = "user" | "assistant" | "system";

type ChatStatus = {
  state: "disconnected" | "connecting" | "connected";
  connectionId: string | null;
};

type ToolCallSummary = {
  toolName: string;
  callId: string;
  args: unknown;
  syscall?: string | null;
};

type ToolResultSummary = {
  toolName: string;
  callId: string | null;
  ok: boolean;
  output?: unknown;
  error?: string;
  syscall?: string | null;
};

type RecentThreadProcess = {
  pid: string;
  label: string | null;
  cwd: string;
  createdAt: number;
};

type RecentThreadEntry = {
  workspaceId: string;
  ownerUid: number;
  label: string | null;
  kind: "thread" | "app" | "shared";
  state: "active" | "archived";
  createdAt: number;
  updatedAt: number;
  defaultBranch: string;
  headCommit: string | null;
  activeProcess: RecentThreadProcess | null;
  processCount: number;
};

type WorkspaceListResult = {
  workspaces?: RecentThreadEntry[];
};

type AssistantRunState = "streaming" | "complete" | "error";

type AssistantRunView = {
  runId: string | null;
  rowNode: HTMLElement;
  statusNode: HTMLElement;
  markdownNode: HTMLElement;
  toolListNode: HTMLElement;
  markdownSource: string;
  state: AssistantRunState;
  timestampMs: number;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function safeText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (value === null || value === undefined) {
    return "";
  }

  return String(value);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatMessageContent(value: unknown): string {
  return typeof value === "string" ? value : prettyJson(value);
}

function normalizeTimestampMs(value: unknown): number | null {
  const numeric = asNumber(value);
  if (numeric === null) {
    return null;
  }

  // Accept seconds values and normalize to milliseconds.
  if (numeric > 0 && numeric < 1_000_000_000_000) {
    return Math.floor(numeric * 1_000);
  }

  return Math.floor(numeric);
}

function formatTimestamp(ms: number): string {
  const date = new Date(ms);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

function formatRelativeTime(ms: number): string {
  const deltaMs = ms - Date.now();
  const absDeltaMs = Math.abs(deltaMs);

  if (absDeltaMs < 60_000) {
    return "just now";
  }

  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["day", 24 * 60 * 60_000],
    ["hour", 60 * 60_000],
    ["minute", 60_000],
  ];

  for (const [unit, unitMs] of units) {
    if (absDeltaMs >= unitMs) {
      const value = Math.round(deltaMs / unitMs);
      return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(value, unit);
    }
  }

  return "just now";
}

function maybeParseJsonString(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) {
    return value;
  }

  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return value;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function normalizeToolOutput(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  return maybeParseJsonString(value);
}

function toMarkdownHtml(markdown: string): string {
  const html = marked.parse(markdown, {
    gfm: true,
    breaks: true,
  }) as string;

  return DOMPurify.sanitize(html);
}

function createTextRow(
  role: ChatRole,
  text: string,
  options?: {
    timestampMs?: number;
  },
): HTMLElement {
  const row = document.createElement("article");
  row.className = `chat-row chat-row-${role}`;

  const footNode = document.createElement("div");
  footNode.className = "chat-row-foot";

  const roleNode = document.createElement("div");
  roleNode.className = "chat-row-role";
  roleNode.textContent = role;

  const timestampMs = options?.timestampMs ?? Date.now();
  const metaNode = document.createElement("div");
  metaNode.className = "chat-row-meta";
  metaNode.textContent = formatTimestamp(timestampMs);

  const textNode = document.createElement("pre");
  textNode.className = "chat-row-text";
  textNode.textContent = text;

  if (role === "system") {
    footNode.append(roleNode, metaNode);
  } else {
    footNode.append(metaNode);
  }

  row.append(textNode, footNode);
  return row;
}

function createAssistantRunRow(runId: string | null, timestampMs = Date.now()): AssistantRunView {
  const rowNode = document.createElement("article");
  rowNode.className = "chat-row chat-row-assistant is-streaming";
  if (runId) {
    rowNode.dataset.runId = runId;
  }

  const footNode = document.createElement("div");
  footNode.className = "chat-row-foot";

  const statusNode = document.createElement("div");
  statusNode.className = "chat-run-status";
  statusNode.textContent = `${formatTimestamp(timestampMs)} · running`;

  const bodyNode = document.createElement("div");
  bodyNode.className = "chat-row-body";

  const markdownNode = document.createElement("div");
  markdownNode.className = "chat-markdown";

  const toolListNode = document.createElement("div");
  toolListNode.className = "tool-list";

  footNode.append(statusNode);
  bodyNode.append(markdownNode, toolListNode);
  rowNode.append(bodyNode, footNode);

  return {
    runId,
    rowNode,
    statusNode,
    markdownNode,
    toolListNode,
    markdownSource: "",
    state: "streaming",
    timestampMs,
  };
}

function setRunMarkdown(run: AssistantRunView, markdown: string): void {
  run.markdownSource = markdown;
  run.markdownNode.innerHTML = toMarkdownHtml(run.markdownSource);
  run.rowNode.classList.toggle("has-markdown", run.markdownSource.trim().length > 0);
}

function appendRunMarkdown(run: AssistantRunView, chunk: string): void {
  setRunMarkdown(run, `${run.markdownSource}${chunk}`);
}

function setRunState(run: AssistantRunView, state: AssistantRunState, detail?: string): void {
  run.state = state;
  run.rowNode.classList.toggle("is-streaming", state === "streaming");
  run.rowNode.classList.toggle("is-complete", state === "complete");
  run.rowNode.classList.toggle("is-error", state === "error");

  const prefix = formatTimestamp(run.timestampMs);
  if (detail) {
    run.statusNode.textContent = `${prefix} · ${detail}`;
    return;
  }

  if (state === "streaming") {
    run.statusNode.textContent = `${prefix} · running`;
    return;
  }

  if (state === "error") {
    run.statusNode.textContent = `${prefix} · error`;
    return;
  }

  run.statusNode.textContent = run.toolListNode.childElementCount > 0 ? `${prefix} · done + tools` : `${prefix} · done`;
}

function addMetaRow(parent: HTMLElement, label: string, value: unknown): void {
  if (value === undefined || value === null) {
    return;
  }

  const row = document.createElement("div");
  row.className = "tool-meta-row";

  const labelNode = document.createElement("span");
  labelNode.className = "tool-meta-label";
  labelNode.textContent = label;

  const valueNode = document.createElement("span");
  valueNode.className = "tool-meta-value";
  valueNode.textContent = safeText(value);

  row.append(labelNode, valueNode);
  parent.appendChild(row);
}

function renderToolCallInput(toolName: string, args: unknown): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "tool-meta";

  const record = asRecord(args);
  if (!record) {
    addMetaRow(wrapper, "input", prettyJson(args));
    return wrapper;
  }

  switch (toolName) {
    case "Read":
      addMetaRow(wrapper, "path", record.path);
      addMetaRow(wrapper, "offset", record.offset);
      addMetaRow(wrapper, "limit", record.limit);
      break;
    case "Search":
      addMetaRow(wrapper, "pattern", record.pattern);
      addMetaRow(wrapper, "path", record.path);
      addMetaRow(wrapper, "include", record.include);
      break;
    case "Shell":
      addMetaRow(wrapper, "command", record.command);
      addMetaRow(wrapper, "target", record.target);
      addMetaRow(wrapper, "workdir", record.workdir);
      addMetaRow(wrapper, "timeout", record.timeout);
      break;
    case "Write": {
      addMetaRow(wrapper, "path", record.path);
      const content = asString(record.content);
      if (content) {
        addMetaRow(wrapper, "bytes", content.length);
      }
      break;
    }
    case "Edit":
      addMetaRow(wrapper, "path", record.path);
      addMetaRow(wrapper, "replaceAll", record.replaceAll);
      break;
    case "Delete":
      addMetaRow(wrapper, "path", record.path);
      break;
    default:
      break;
  }

  const jsonNode = document.createElement("details");
  jsonNode.className = "tool-json";
  const summaryNode = document.createElement("summary");
  summaryNode.textContent = "Input";
  const preNode = document.createElement("pre");
  preNode.textContent = prettyJson(args);
  jsonNode.append(summaryNode, preNode);
  wrapper.appendChild(jsonNode);

  return wrapper;
}

function renderReadOutput(output: unknown): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "tool-result-view";

  const normalized = normalizeToolOutput(output);
  const record = asRecord(normalized);
  if (!record) {
    const pre = document.createElement("pre");
    pre.className = "tool-result-pre";
    pre.textContent = safeText(normalized);
    wrap.appendChild(pre);
    return wrap;
  }

  if (record.ok === false) {
    const error = asString(record.error) ?? "read failed";
    const errorNode = document.createElement("p");
    errorNode.className = "tool-error";
    errorNode.textContent = error;
    wrap.appendChild(errorNode);
    return wrap;
  }

  addMetaRow(wrap, "path", record.path);
  addMetaRow(wrap, "size", record.size);

  const directories = Array.isArray(record.directories) ? record.directories : null;
  const files = Array.isArray(record.files) ? record.files : null;

  if (directories || files) {
    addMetaRow(wrap, "directories", directories?.length ?? 0);
    addMetaRow(wrap, "files", files?.length ?? 0);

    const pre = document.createElement("pre");
    pre.className = "tool-result-pre";
    const list: string[] = [];
    for (const dir of directories ?? []) {
      list.push(`dir: ${safeText(dir)}`);
    }
    for (const file of files ?? []) {
      list.push(`file: ${safeText(file)}`);
    }
    pre.textContent = list.slice(0, 80).join("\n");
    wrap.appendChild(pre);
    return wrap;
  }

  const content = record.content;
  if (typeof content === "string") {
    const pre = document.createElement("pre");
    pre.className = "tool-result-pre";
    pre.textContent = content;
    wrap.appendChild(pre);
    return wrap;
  }

  if (Array.isArray(content)) {
    const textParts = content
      .map((item) => {
        const block = asRecord(item);
        if (!block) return "";
        if (block.type === "text" && typeof block.text === "string") {
          return block.text;
        }
        if (block.type === "image") {
          return "[image block]";
        }
        return "";
      })
      .filter((entry) => entry.length > 0);

    const pre = document.createElement("pre");
    pre.className = "tool-result-pre";
    pre.textContent = textParts.join("\n");
    wrap.appendChild(pre);
    return wrap;
  }

  const pre = document.createElement("pre");
  pre.className = "tool-result-pre";
  pre.textContent = prettyJson(normalized);
  wrap.appendChild(pre);
  return wrap;
}

function renderSearchOutput(output: unknown): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "tool-result-view";

  const normalized = normalizeToolOutput(output);
  const record = asRecord(normalized);
  if (!record) {
    const pre = document.createElement("pre");
    pre.className = "tool-result-pre";
    pre.textContent = safeText(normalized);
    wrap.appendChild(pre);
    return wrap;
  }

  if (record.ok === false) {
    const error = asString(record.error) ?? "search failed";
    const errorNode = document.createElement("p");
    errorNode.className = "tool-error";
    errorNode.textContent = error;
    wrap.appendChild(errorNode);
    return wrap;
  }

  addMetaRow(wrap, "count", record.count);
  addMetaRow(wrap, "truncated", record.truncated);

  const matches = Array.isArray(record.matches) ? record.matches : [];
  const pre = document.createElement("pre");
  pre.className = "tool-result-pre";
  pre.textContent = matches
    .slice(0, 120)
    .map((item) => {
      const match = asRecord(item);
      if (!match) return safeText(item);
      const path = safeText(match.path);
      const line = safeText(match.line);
      const content = safeText(match.content);
      return `${path}:${line}: ${content}`;
    })
    .join("\n");
  wrap.appendChild(pre);
  return wrap;
}

function renderWriteOutput(output: unknown): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "tool-result-view";

  const normalized = normalizeToolOutput(output);
  const record = asRecord(normalized);
  if (!record) {
    const pre = document.createElement("pre");
    pre.className = "tool-result-pre";
    pre.textContent = safeText(normalized);
    wrap.appendChild(pre);
    return wrap;
  }

  if (record.ok === false) {
    const error = asString(record.error) ?? "write failed";
    const errorNode = document.createElement("p");
    errorNode.className = "tool-error";
    errorNode.textContent = error;
    wrap.appendChild(errorNode);
    return wrap;
  }

  addMetaRow(wrap, "path", record.path);
  addMetaRow(wrap, "bytes", record.size);
  return wrap;
}

function renderEditOutput(output: unknown): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "tool-result-view";

  const normalized = normalizeToolOutput(output);
  const record = asRecord(normalized);
  if (!record) {
    const pre = document.createElement("pre");
    pre.className = "tool-result-pre";
    pre.textContent = safeText(normalized);
    wrap.appendChild(pre);
    return wrap;
  }

  if (record.ok === false) {
    const error = asString(record.error) ?? "edit failed";
    const errorNode = document.createElement("p");
    errorNode.className = "tool-error";
    errorNode.textContent = error;
    wrap.appendChild(errorNode);
    return wrap;
  }

  addMetaRow(wrap, "path", record.path);
  addMetaRow(wrap, "replacements", record.replacements);
  return wrap;
}

function renderDeleteOutput(output: unknown): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "tool-result-view";

  const normalized = normalizeToolOutput(output);
  const record = asRecord(normalized);
  if (!record) {
    const pre = document.createElement("pre");
    pre.className = "tool-result-pre";
    pre.textContent = safeText(normalized);
    wrap.appendChild(pre);
    return wrap;
  }

  if (record.ok === false) {
    const error = asString(record.error) ?? "delete failed";
    const errorNode = document.createElement("p");
    errorNode.className = "tool-error";
    errorNode.textContent = error;
    wrap.appendChild(errorNode);
    return wrap;
  }

  addMetaRow(wrap, "path", record.path);
  return wrap;
}

function renderShellOutput(output: unknown): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "tool-result-view";

  const normalized = normalizeToolOutput(output);
  const record = asRecord(normalized);
  if (!record) {
    const pre = document.createElement("pre");
    pre.className = "tool-result-pre";
    pre.textContent = safeText(normalized);
    wrap.appendChild(pre);
    return wrap;
  }

  if (record.ok === false) {
    const error = asString(record.error) ?? "shell command failed";
    const errorNode = document.createElement("p");
    errorNode.className = "tool-error";
    errorNode.textContent = error;
    wrap.appendChild(errorNode);
    return wrap;
  }

  addMetaRow(wrap, "pid", record.pid);
  addMetaRow(wrap, "exitCode", record.exitCode);
  addMetaRow(wrap, "backgrounded", record.backgrounded);

  const stdout = asString(record.stdout);
  if (stdout && stdout.length > 0) {
    const block = document.createElement("section");
    block.className = "tool-stream";
    const title = document.createElement("h4");
    title.textContent = "stdout";
    const pre = document.createElement("pre");
    pre.className = "tool-result-pre";
    pre.textContent = stdout;
    block.append(title, pre);
    wrap.appendChild(block);
  }

  const stderr = asString(record.stderr);
  if (stderr && stderr.length > 0) {
    const block = document.createElement("section");
    block.className = "tool-stream tool-stream-stderr";
    const title = document.createElement("h4");
    title.textContent = "stderr";
    const pre = document.createElement("pre");
    pre.className = "tool-result-pre";
    pre.textContent = stderr;
    block.append(title, pre);
    wrap.appendChild(block);
  }

  if (!stdout && !stderr) {
    const pre = document.createElement("pre");
    pre.className = "tool-result-pre";
    pre.textContent = prettyJson(normalized);
    wrap.appendChild(pre);
  }

  return wrap;
}

function renderGenericOutput(output: unknown): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "tool-result-view";

  const normalized = normalizeToolOutput(output);
  const pre = document.createElement("pre");
  pre.className = "tool-result-pre";
  if (typeof normalized === "string") {
    pre.textContent = normalized;
  } else {
    pre.textContent = prettyJson(normalized);
  }

  wrap.appendChild(pre);
  return wrap;
}

function isToolKind(
  toolName: string,
  syscall: string | null | undefined,
  expectedName: string,
  expectedSyscall: string,
): boolean {
  return toolName === expectedName || syscall === expectedSyscall;
}

function inferToolSyscall(toolName: string, syscall: string | null | undefined): string | null {
  if (syscall && syscall.length > 0) {
    return syscall;
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
    default:
      return null;
  }
}

type ToolCardPresentation = {
  iconKind: "shell" | "read" | "search" | "write" | "edit" | "delete" | "generic";
  title: string;
  context?: string;
  targetKind: "gsv" | "device";
  targetLabel: string;
};

function truncateInline(value: string, maxLength = 80): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.slice(0, maxLength)}...`;
}

function truncateBlock(value: string, maxLength = 1_800): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}\n...[truncated]`;
}

function basenamePath(path: string): string {
  const normalized = path.replace(/\/+$/g, "");
  if (!normalized) {
    return path;
  }
  const segments = normalized.split("/");
  return segments[segments.length - 1] || normalized;
}

function toDomId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function resolveToolTarget(args: unknown): { kind: "gsv" | "device"; label: string } {
  const record = asRecord(args);
  const raw = asString(record?.target)?.trim() ?? "";

  if (!raw || raw === "gsv" || raw === "gateway" || raw === "<init>" || raw === "init" || raw === "local") {
    return { kind: "gsv", label: "gsv" };
  }

  if (raw.startsWith("device:")) {
    return { kind: "device", label: raw.slice("device:".length) || raw };
  }

  if (raw.startsWith("driver:")) {
    return { kind: "device", label: raw.slice("driver:".length) || raw };
  }

  return { kind: "device", label: raw };
}

function describeToolCard(toolName: string, args: unknown, syscall?: string | null): ToolCardPresentation {
  const record = asRecord(args);
  const path = asString(record?.path);
  const target = resolveToolTarget(args);

  if (isToolKind(toolName, syscall, "Shell", "shell.exec")) {
    const command = asString(record?.command);
    const workdir = asString(record?.workdir);

    const contextParts: string[] = [];
    if (workdir) contextParts.push(`workdir ${truncateInline(workdir, 36)}`);

    return {
      iconKind: "shell",
      title: command ? `Run ${truncateInline(command)}` : "Run command",
      context: contextParts.join(" · ") || undefined,
      targetKind: target.kind,
      targetLabel: target.label,
    };
  }

  if (isToolKind(toolName, syscall, "Read", "fs.read")) {
    return {
      iconKind: "read",
      title: path ? `Read ${basenamePath(path)}` : "Read file",
      targetKind: target.kind,
      targetLabel: target.label,
    };
  }

  if (isToolKind(toolName, syscall, "Search", "fs.search")) {
    const pattern = asString(record?.pattern);
    return {
      iconKind: "search",
      title: pattern ? `Search ${truncateInline(pattern, 42)}` : "Search workspace",
      context: path ? truncateInline(path, 48) : undefined,
      targetKind: target.kind,
      targetLabel: target.label,
    };
  }

  if (isToolKind(toolName, syscall, "Write", "fs.write")) {
    return {
      iconKind: "write",
      title: path ? `Write ${basenamePath(path)}` : "Write file",
      targetKind: target.kind,
      targetLabel: target.label,
    };
  }

  if (isToolKind(toolName, syscall, "Edit", "fs.edit")) {
    return {
      iconKind: "edit",
      title: path ? `Edit ${basenamePath(path)}` : "Edit file",
      targetKind: target.kind,
      targetLabel: target.label,
    };
  }

  if (isToolKind(toolName, syscall, "Delete", "fs.delete")) {
    return {
      iconKind: "delete",
      title: path ? `Delete ${basenamePath(path)}` : "Delete file",
      targetKind: target.kind,
      targetLabel: target.label,
    };
  }

  return {
    iconKind: "generic",
    title: toolName,
    targetKind: target.kind,
    targetLabel: target.label,
  };
}

function createToolPreviewLine(text: string, className = "tool-preview-line"): HTMLElement {
  const line = document.createElement("p");
  line.className = className;
  line.textContent = text;
  return line;
}

function createToolPreviewPre(text: string, className = "tool-preview-pre"): HTMLElement {
  const pre = document.createElement("pre");
  pre.className = className;
  pre.textContent = truncateBlock(text);
  return pre;
}

function renderToolResultPreview(
  toolName: string,
  syscall: string | null | undefined,
  output: unknown,
  ok: boolean,
  error?: string,
): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "tool-preview-content";

  const normalized = normalizeToolOutput(output);
  const record = asRecord(normalized);
  const recordError = asString(record?.error);

  if (!ok || record?.ok === false) {
    const message = error ?? recordError ?? "Tool call failed.";
    wrapper.appendChild(createToolPreviewLine(message, "tool-preview-line tool-preview-line-error"));
    return wrapper;
  }

  if (isToolKind(toolName, syscall, "Shell", "shell.exec")) {
    const stdout = asString(record?.stdout);
    const stderr = asString(record?.stderr);
    if (stdout && stdout.trim().length > 0) {
      wrapper.appendChild(createToolPreviewPre(stdout));
    }
    if (stderr && stderr.trim().length > 0) {
      wrapper.appendChild(createToolPreviewPre(stderr, "tool-preview-pre tool-preview-pre-error"));
    }
    if ((!stdout || stdout.trim().length === 0) && (!stderr || stderr.trim().length === 0)) {
      wrapper.appendChild(createToolPreviewLine("Command completed."));
    }
    return wrapper;
  }

  if (isToolKind(toolName, syscall, "Read", "fs.read")) {
    const directories = Array.isArray(record?.directories) ? record.directories : [];
    const files = Array.isArray(record?.files) ? record.files : [];
    if (directories.length > 0 || files.length > 0) {
      wrapper.appendChild(createToolPreviewLine(`Listed ${directories.length} dirs and ${files.length} files.`));
      const names = [
        ...directories.slice(0, 8).map((value) => `dir: ${safeText(value)}`),
        ...files.slice(0, 8).map((value) => `file: ${safeText(value)}`),
      ];
      if (names.length > 0) {
        wrapper.appendChild(createToolPreviewPre(names.join("\n")));
      }
      return wrapper;
    }

    if (typeof record?.content === "string") {
      wrapper.appendChild(createToolPreviewPre(record.content));
      return wrapper;
    }

    if (Array.isArray(record?.content)) {
      const textParts = record.content
        .map((item) => {
          const block = asRecord(item);
          if (!block) return "";
          if (block.type === "text" && typeof block.text === "string") {
            return block.text;
          }
          return "";
        })
        .filter((entry) => entry.length > 0);
      if (textParts.length > 0) {
        wrapper.appendChild(createToolPreviewPre(textParts.join("\n")));
        return wrapper;
      }
    }

    wrapper.appendChild(createToolPreviewLine("Read completed."));
    return wrapper;
  }

  if (isToolKind(toolName, syscall, "Search", "fs.search")) {
    const matches = Array.isArray(record?.matches) ? record.matches : [];
    const count = asNumber(record?.count) ?? matches.length;
    wrapper.appendChild(createToolPreviewLine(`${count} matches.`));
    if (matches.length > 0) {
      const lines = matches
        .slice(0, 10)
        .map((item) => {
          const match = asRecord(item);
          if (!match) return safeText(item);
          const matchPath = safeText(match.path);
          const line = safeText(match.line);
          const content = safeText(match.content);
          return `${basenamePath(matchPath)}:${line}: ${content}`;
        });
      wrapper.appendChild(createToolPreviewPre(lines.join("\n")));
    }
    return wrapper;
  }

  if (isToolKind(toolName, syscall, "Write", "fs.write")) {
    const bytes = asNumber(record?.size);
    wrapper.appendChild(createToolPreviewLine(bytes === null ? "Write completed." : `Wrote ${bytes} bytes.`));
    return wrapper;
  }

  if (isToolKind(toolName, syscall, "Edit", "fs.edit")) {
    const replacements = asNumber(record?.replacements);
    wrapper.appendChild(
      createToolPreviewLine(replacements === null ? "Edit completed." : `${replacements} replacement${replacements === 1 ? "" : "s"}.`),
    );
    return wrapper;
  }

  if (isToolKind(toolName, syscall, "Delete", "fs.delete")) {
    wrapper.appendChild(createToolPreviewLine("Delete completed."));
    return wrapper;
  }

  if (typeof normalized === "string") {
    wrapper.appendChild(createToolPreviewPre(normalized));
    return wrapper;
  }

  wrapper.appendChild(createToolPreviewPre(prettyJson(normalized)));
  return wrapper;
}

function renderToolResultOutput(
  toolName: string,
  syscall: string | null | undefined,
  output: unknown,
): HTMLElement {
  if (isToolKind(toolName, syscall, "Read", "fs.read")) {
    return renderReadOutput(output);
  }
  if (isToolKind(toolName, syscall, "Search", "fs.search")) {
    return renderSearchOutput(output);
  }
  if (isToolKind(toolName, syscall, "Shell", "shell.exec")) {
    return renderShellOutput(output);
  }
  if (isToolKind(toolName, syscall, "Write", "fs.write")) {
    return renderWriteOutput(output);
  }
  if (isToolKind(toolName, syscall, "Edit", "fs.edit")) {
    return renderEditOutput(output);
  }
  if (isToolKind(toolName, syscall, "Delete", "fs.delete")) {
    return renderDeleteOutput(output);
  }

  switch (toolName) {
    default:
      return renderGenericOutput(output);
  }
}

function createToolCard(toolName: string, callId: string, args: unknown, syscall?: string | null): HTMLElement {
  const presentation = describeToolCard(toolName, args, syscall);
  const detailsId = `tool-details-${toDomId(callId)}`;
  const resolvedSyscall = inferToolSyscall(toolName, syscall);

  const card = document.createElement("article");
  card.className = "tool-card is-pending";
  card.dataset.callId = callId;

  const header = document.createElement("header");
  header.className = "tool-card-head";

  const lead = document.createElement("div");
  lead.className = "tool-card-lead";

  const icon = document.createElement("span");
  icon.className = `tool-kind-icon tool-kind-${presentation.iconKind}`;
  icon.setAttribute("aria-hidden", "true");

  const title = document.createElement("h4");
  title.className = "tool-card-title";
  title.textContent = presentation.title;

  const meta = document.createElement("div");
  meta.className = "tool-card-meta";

  const target = document.createElement("span");
  target.className = `tool-target-badge ${presentation.targetKind === "gsv" ? "is-gsv" : "is-device"}`;
  target.setAttribute(
    "title",
    presentation.targetKind === "gsv"
      ? "Runs on GSV host"
      : `Runs on device "${presentation.targetLabel}"`,
  );
  target.setAttribute("aria-label", target.getAttribute("title") ?? "Tool target");

  const status = document.createElement("span");
  status.className = "tool-status-badge is-running";
  status.setAttribute("title", "Running");
  status.setAttribute("aria-label", "Running");

  const detailsToggle = document.createElement("button");
  detailsToggle.type = "button";
  detailsToggle.className = "tool-meta-icon-btn tool-details-toggle";
  detailsToggle.setAttribute("title", "Show details");
  detailsToggle.setAttribute("aria-label", "Show details");
  detailsToggle.setAttribute("aria-expanded", "false");
  detailsToggle.setAttribute("aria-controls", detailsId);

  lead.append(icon, title);
  meta.append(target, status, detailsToggle);
  header.append(lead, meta);

  const contextNode = document.createElement("p");
  contextNode.className = "tool-card-context";
  contextNode.textContent = presentation.context ?? "";
  contextNode.hidden = !presentation.context;

  const previewNode = document.createElement("div");
  previewNode.className = "tool-preview";
  previewNode.appendChild(createToolPreviewLine("Running..."));

  const detailsBody = document.createElement("div");
  detailsBody.className = "tool-details-body";
  detailsBody.id = detailsId;
  detailsBody.hidden = true;

  const syscallNode = document.createElement("p");
  syscallNode.className = "tool-card-subtle";
  syscallNode.dataset.syscallInfo = "true";
  syscallNode.textContent = resolvedSyscall ? `syscall: ${resolvedSyscall}` : "syscall: unknown";

  const inputNode = renderToolCallInput(toolName, args);
  inputNode.classList.add("tool-input");

  const resultNode = document.createElement("div");
  resultNode.className = "tool-result";
  resultNode.hidden = true;

  const setDetailsOpen = (open: boolean): void => {
    detailsBody.hidden = !open;
    detailsToggle.classList.toggle("is-open", open);
    detailsToggle.setAttribute("aria-expanded", open ? "true" : "false");
    detailsToggle.setAttribute("title", open ? "Hide details" : "Show details");
    detailsToggle.setAttribute("aria-label", open ? "Hide details" : "Show details");
  };

  detailsToggle.addEventListener("click", () => {
    setDetailsOpen(detailsBody.hidden);
  });

  detailsBody.append(syscallNode, inputNode, resultNode);
  setDetailsOpen(false);

  card.append(header, contextNode, previewNode, detailsBody);
  return card;
}

function applyToolResult(card: HTMLElement, result: ToolResultSummary): void {
  const normalizedOutput = normalizeToolOutput(result.output);
  const outputRecord = asRecord(normalizedOutput);
  const toolLevelOk = asBoolean(outputRecord?.ok);
  const exitCode = asNumber(outputRecord?.exitCode);
  const nonZeroExit = result.toolName === "Shell" && exitCode !== null && exitCode !== 0;
  const effectiveOk = result.ok && toolLevelOk !== false && !nonZeroExit;

  card.classList.remove("is-pending", "is-ok", "is-error");
  card.classList.add(effectiveOk ? "is-ok" : "is-error");

  const statusNode = card.querySelector<HTMLElement>(".tool-status-badge");
  if (statusNode) {
    const statusTooltip =
      result.toolName === "Shell" && outputRecord?.backgrounded === true
        ? "Backgrounded"
        : result.toolName === "Shell" && exitCode !== null
          ? `Exit ${exitCode}`
          : effectiveOk
            ? "Done"
            : "Error";
    statusNode.classList.remove("is-running", "is-done", "is-error");
    statusNode.classList.add(effectiveOk ? "is-done" : "is-error");
    statusNode.setAttribute("title", statusTooltip);
    statusNode.setAttribute("aria-label", statusTooltip);
  }

  const resultNode = card.querySelector<HTMLElement>(".tool-result");
  const previewNode = card.querySelector<HTMLElement>(".tool-preview");
  const detailsBody = card.querySelector<HTMLElement>(".tool-details-body");
  const detailsToggle = card.querySelector<HTMLButtonElement>(".tool-details-toggle");
  const syscallInfoNode = card.querySelector<HTMLElement>(".tool-card-subtle[data-syscall-info='true']");
  if (!resultNode) {
    return;
  }

  if (syscallInfoNode) {
    const resolvedSyscall = inferToolSyscall(result.toolName, result.syscall);
    if (resolvedSyscall) {
      syscallInfoNode.textContent = `syscall: ${resolvedSyscall}`;
    }
  }

  if (previewNode) {
    previewNode.innerHTML = "";
    previewNode.appendChild(
      renderToolResultPreview(
        result.toolName,
        result.syscall,
        normalizedOutput,
        effectiveOk,
        result.error,
      ),
    );
  }

  resultNode.innerHTML = "";
  resultNode.hidden = false;

  if (!effectiveOk) {
    const outputError = asString(outputRecord?.error);
    const explicitError = outputError ?? result.error;
    if (explicitError) {
      const errorNode = document.createElement("p");
      errorNode.className = "tool-error";
      errorNode.textContent = explicitError;
      resultNode.appendChild(errorNode);
    }
  }

  resultNode.appendChild(renderToolResultOutput(result.toolName, result.syscall, normalizedOutput));
  if (detailsBody && detailsToggle && !effectiveOk) {
    detailsBody.hidden = false;
    detailsToggle.classList.add("is-open");
    detailsToggle.setAttribute("aria-expanded", "true");
    detailsToggle.setAttribute("title", "Hide details");
    detailsToggle.setAttribute("aria-label", "Hide details");
  }
}

function parseToolCallSignal(payload: unknown): ToolCallSummary | null {
  const record = asRecord(payload);
  if (!record) {
    return null;
  }

  const toolName = asString(record.name);
  const callId = asString(record.callId);
  if (!toolName || !callId) {
    return null;
  }

  return {
    toolName,
    callId,
    args: record.args,
    syscall: inferToolSyscall(toolName, asString(record.syscall)),
  };
}

function parseToolResultSignal(payload: unknown): ToolResultSummary | null {
  const record = asRecord(payload);
  if (!record) {
    return null;
  }

  const toolName = asString(record.name);
  if (!toolName) {
    return null;
  }

  return {
    toolName,
    callId: asString(record.callId),
    ok: record.ok === true,
    output: normalizeToolOutput(record.output),
    error: asString(record.error) ?? undefined,
    syscall: inferToolSyscall(toolName, asString(record.syscall)),
  };
}

function extractAssistantHistory(content: unknown): {
  text: string;
  toolCalls: ToolCallSummary[];
} {
  const textFallback = typeof content === "string" ? content : "";
  const record = asRecord(content);
  if (!record) {
    return { text: textFallback, toolCalls: [] };
  }

  const text = asString(record.text) ?? textFallback;
  const rawToolCalls = Array.isArray(record.toolCalls) ? record.toolCalls : [];

  const toolCalls: ToolCallSummary[] = [];
  for (let index = 0; index < rawToolCalls.length; index += 1) {
    const item = asRecord(rawToolCalls[index]);
    if (!item) {
      continue;
    }

    const toolName = asString(item.name);
    if (!toolName) {
      continue;
    }

      const callId = asString(item.id) ?? asString(item.callId) ?? `hist-call-${Date.now()}-${index}`;
      const args: unknown = item.arguments ?? item.args ?? {};
      toolCalls.push({
        toolName,
        callId,
        args,
        syscall: inferToolSyscall(toolName, asString(item.syscall)),
      });
  }

  return { text, toolCalls };
}

function extractToolResultHistory(content: unknown): ToolResultSummary | null {
  const record = asRecord(content);
  if (!record) {
    return null;
  }

  const toolName = asString(record.toolName) ?? asString(record.name);
  if (!toolName) {
    return null;
  }

  const isError = record.isError === true;
  const ok = record.ok === true || !isError;

  return {
    toolName,
    callId: asString(record.toolCallId) ?? asString(record.callId),
    ok,
    output: normalizeToolOutput(record.output),
    error: asString(record.error) ?? undefined,
    syscall: inferToolSyscall(toolName, asString(record.syscall)),
  };
}

function mapHistoryRole(role: string): ChatRole {
  if (role === "assistant") return "assistant";
  if (role === "user") return "user";
  return "system";
}

function deriveThreadLabel(message: string): string | undefined {
  const firstLine = message
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  if (!firstLine) {
    return undefined;
  }

  return firstLine.length > 72 ? `${firstLine.slice(0, 69)}...` : firstLine;
}

function displayThreadLabel(entry: RecentThreadEntry): string {
  const label = entry.label?.trim();
  if (label) {
    return label;
  }
  return entry.workspaceId;
}

function createChatAppController(client: AppKernelClient): AppInstance {
  let composerInput: HTMLTextAreaElement | null = null;
  let composerButton: HTMLButtonElement | null = null;
  let composerAttachButton: HTMLButtonElement | null = null;
  let composerVoiceButton: HTMLButtonElement | null = null;
  let composerUploadTray: HTMLElement | null = null;
  let composerUploadButtons: HTMLButtonElement[] = [];
  let composerVoicePanel: HTMLElement | null = null;
  let threadsNode: HTMLElement | null = null;
  let threadStatusNode: HTMLElement | null = null;
  let threadNewButton: HTMLButtonElement | null = null;
  let threadRefreshButton: HTMLButtonElement | null = null;
  let openFilesButton: HTMLButtonElement | null = null;
  let openShellButton: HTMLButtonElement | null = null;
  let logNode: HTMLElement | null = null;
  let composeNode: HTMLFormElement | null = null;
  let mounted = false;
  let suspended = false;
  let voiceMode = false;
  let uploadExpanded = false;
  let wasConnected = false;
  let loadedConnectionId: string | null = null;
  let loadedPid: string | null = null;
  let activeThreadContext: ThreadContext | null = getActiveThreadContext();
  let activePid: string | null = activeThreadContext?.pid ?? null;
  let appWindowId: string | null = null;
  let recentThreads: RecentThreadEntry[] = [];
  let threadsLoading = false;
  let threadsError = "";
  let historySyntheticRunCounter = 0;

  const textRunViewsByRunId = new Map<string, AssistantRunView>();
  const toolRunViewsByRunId = new Map<string, AssistantRunView>();
  const toolCardsByCallId = new Map<string, HTMLElement>();
  const toolCardOwnersByCallId = new Map<string, AssistantRunView>();
  const pendingRunIds = new Set<string>();
  let lastAssistantTextRun: AssistantRunView | null = null;
  let lastAssistantToolRun: AssistantRunView | null = null;

  const cleanup = new Set<() => void>();
  const scrollLogToBottom = (): void => {
    if (!logNode) return;
    logNode.scrollTop = logNode.scrollHeight;
  };

  const isNearBottom = (thresholdPx = 96): boolean => {
    if (!logNode) {
      return true;
    }
    const distance = logNode.scrollHeight - (logNode.scrollTop + logNode.clientHeight);
    return distance <= thresholdPx;
  };

  const maybeScrollToBottom = (shouldStick: boolean): void => {
    if (!shouldStick) {
      return;
    }
    scrollLogToBottom();
  };

  const setUploadExpanded = (open: boolean): void => {
    uploadExpanded = open;
    if (composeNode) {
      composeNode.dataset.uploadOpen = open ? "true" : "false";
    }
    if (composerUploadTray) {
      composerUploadTray.hidden = !open;
    }
    if (composerAttachButton) {
      composerAttachButton.dataset.state = open ? "open" : "closed";
      composerAttachButton.setAttribute("aria-expanded", open ? "true" : "false");
      composerAttachButton.title = open ? "Close media options" : "Add media";
    }
  };

  const setVoiceMode = (active: boolean): void => {
    voiceMode = active;
    if (composeNode) {
      composeNode.dataset.voice = active ? "true" : "false";
    }
    if (composerVoicePanel) {
      composerVoicePanel.hidden = !active;
    }
    if (composerVoiceButton) {
      composerVoiceButton.dataset.state = active ? "active" : "idle";
      composerVoiceButton.setAttribute("aria-pressed", active ? "true" : "false");
      composerVoiceButton.title = active ? "Stop voice mode" : "Start voice mode";
    }
  };

  const renderThreadRail = (): void => {
    if (!threadsNode || !threadStatusNode) {
      return;
    }

    const connected = client.getStatus().state === "connected";
    const hasActiveThread = activeThreadContext !== null;

    if (threadNewButton) {
      threadNewButton.disabled = suspended;
    }
    if (threadRefreshButton) {
      threadRefreshButton.disabled = suspended || !connected;
    }
    if (openFilesButton) {
      openFilesButton.disabled = !connected || !hasActiveThread;
    }
    if (openShellButton) {
      openShellButton.disabled = !connected || !hasActiveThread;
    }

    if (!connected) {
      threadStatusNode.hidden = false;
      threadStatusNode.textContent = "Unlock desktop session to browse threads.";
      threadsNode.innerHTML = "";
      return;
    }

    if (threadsLoading) {
      threadStatusNode.hidden = false;
      threadStatusNode.textContent = "Loading threads...";
      threadsNode.innerHTML = "";
      return;
    }

    if (threadsError) {
      threadStatusNode.hidden = false;
      threadStatusNode.textContent = threadsError;
      threadsNode.innerHTML = "";
      return;
    }

    if (recentThreads.length === 0) {
      threadStatusNode.hidden = false;
      threadStatusNode.textContent = "No threads yet. Send a message to start one.";
      threadsNode.innerHTML = "";
      return;
    }

    const activeWorkspaceId = activeThreadContext?.workspaceId ?? null;
    threadStatusNode.hidden = true;
    threadsNode.innerHTML = recentThreads
      .map((entry) => {
        const isActive = activeWorkspaceId !== null && entry.workspaceId === activeWorkspaceId;
        const state = entry.activeProcess ? "Live" : "Stored";
        const helpers = entry.processCount > 1 ? ` · ${entry.processCount} agents` : "";
        return `
          <button
            type="button"
            class="chat-thread-item${isActive ? " is-active" : ""}"
            data-chat-thread-action="open-thread"
            data-workspace-id="${escapeHtml(entry.workspaceId)}"
          >
            <span class="chat-thread-item-title">${escapeHtml(displayThreadLabel(entry))}</span>
            <span class="chat-thread-item-meta">${escapeHtml(`${state}${helpers} · ${formatRelativeTime(entry.updatedAt)}`)}</span>
          </button>
        `;
      })
      .join("");
  };

  const loadRecentThreads = async (): Promise<void> => {
    if (!mounted || suspended || client.getStatus().state !== "connected") {
      renderThreadRail();
      return;
    }

    threadsLoading = true;
    threadsError = "";
    renderThreadRail();

    try {
      const payload = await client.request<WorkspaceListResult>("sys.workspace.list", {
        kind: "thread",
        limit: 32,
      });
      recentThreads = Array.isArray(payload.workspaces) ? payload.workspaces : [];
      threadsError = "";
    } catch (error) {
      recentThreads = [];
      threadsError = error instanceof Error ? error.message : String(error);
    } finally {
      threadsLoading = false;
      renderThreadRail();
    }
  };

  const openCompanionApp = (appId: "files" | "shell"): void => {
    if (!activeThreadContext) {
      return;
    }

    window.dispatchEvent(
      new CustomEvent<OpenAppEventDetail>(OPEN_APP_EVENT, {
        detail: {
          appId,
          threadContext: activeThreadContext,
        },
      }),
    );
  };

  const updateComposerState = (status: ChatStatus): void => {
    const connected = status.state === "connected";
    const hasDraft = composerInput ? composerInput.value.trim().length > 0 : false;
    const hasPendingRun = pendingRunIds.size > 0;
    const interactive = connected && !suspended;

    if (composeNode) {
      composeNode.hidden = !connected;
      composeNode.dataset.connected = connected ? "true" : "false";
      composeNode.dataset.hasText = hasDraft ? "true" : "false";
      composeNode.dataset.busy = hasPendingRun ? "true" : "false";
    }

    if (!interactive) {
      setUploadExpanded(false);
      setVoiceMode(false);
    }

    if (hasDraft && uploadExpanded) {
      setUploadExpanded(false);
    }

    if (hasDraft && voiceMode) {
      setVoiceMode(false);
    }

    if (composerInput) {
      composerInput.disabled = !interactive || voiceMode;
    }
    if (composerAttachButton) {
      composerAttachButton.disabled = !interactive || voiceMode;
    }
    if (composerVoiceButton) {
      composerVoiceButton.disabled = !interactive;
    }
    if (composerUploadButtons.length > 0) {
      for (const button of composerUploadButtons) {
        button.disabled = !interactive;
      }
    }
    if (composerButton) {
      composerButton.disabled = !interactive || voiceMode || !hasDraft;
      if (voiceMode) {
        composerButton.dataset.state = "voice";
        composerButton.textContent = "Voice";
        composerButton.title = "Voice mode active";
        return;
      }
      if (hasPendingRun && hasDraft) {
        composerButton.dataset.state = "queue";
        composerButton.textContent = "Queue";
        composerButton.title = "Queue message while a run is in progress";
      } else if (hasPendingRun) {
        composerButton.dataset.state = "busy";
        composerButton.textContent = "Running";
        composerButton.title = "Run in progress";
      } else if (hasDraft) {
        composerButton.dataset.state = "ready";
        composerButton.textContent = "Send";
        composerButton.title = "Send message";
      } else {
        composerButton.dataset.state = "idle";
        composerButton.textContent = "Send";
        composerButton.title = "Write a message to send";
      }
    }

    renderThreadRail();
  };

  const appendRowNode = (
    node: HTMLElement,
    options?: {
      before?: HTMLElement | null;
      after?: HTMLElement | null;
    },
  ): void => {
    if (!logNode) {
      return;
    }

    const shouldStick = isNearBottom();
    const beforeNode = options?.before;
    const afterNode = options?.after;
    if (beforeNode && beforeNode.parentNode === logNode) {
      logNode.insertBefore(node, beforeNode);
    } else if (afterNode && afterNode.parentNode === logNode) {
      logNode.insertBefore(node, afterNode.nextSibling);
    } else {
      logNode.appendChild(node);
    }
    maybeScrollToBottom(shouldStick);
  };

  const appendTextRow = (role: ChatRole, text: string, timestampMs?: number): void => {
    appendRowNode(createTextRow(role, text, { timestampMs }));
  };

  const createRun = (
    kind: "text" | "tools",
    runId: string | null,
    timestampMs?: number,
    options?: {
      before?: HTMLElement | null;
      after?: HTMLElement | null;
    },
  ): AssistantRunView => {
    const run = createAssistantRunRow(runId, timestampMs);
    run.rowNode.dataset.channel = kind;
    appendRowNode(run.rowNode, options);

    if (runId) {
      if (kind === "text") {
        textRunViewsByRunId.set(runId, run);
      } else {
        toolRunViewsByRunId.set(runId, run);
      }
    }

    setRunState(run, "streaming");
    if (kind === "text") {
      lastAssistantTextRun = run;
    } else {
      lastAssistantToolRun = run;
    }
    return run;
  };

  const ensureTextRun = (runId: string | null, timestampMs?: number): AssistantRunView => {
    if (runId) {
      const existing = textRunViewsByRunId.get(runId);
      if (existing) {
        return existing;
      }
    }

    const toolRun = runId ? toolRunViewsByRunId.get(runId) ?? null : null;
    return createRun("text", runId, timestampMs, {
      before: toolRun?.rowNode ?? null,
    });
  };

  const ensureToolRun = (runId: string | null, timestampMs?: number): AssistantRunView => {
    if (runId) {
      const existing = toolRunViewsByRunId.get(runId);
      if (existing) {
        return existing;
      }
    }

    const textRun = runId ? textRunViewsByRunId.get(runId) ?? null : null;
    return createRun("tools", runId, timestampMs, {
      after: textRun?.rowNode ?? null,
    });
  };

  const ensureToolCard = (
    run: AssistantRunView,
    callId: string,
    toolName: string,
    args: unknown,
    syscall?: string | null,
  ): HTMLElement => {
    const existing = toolCardsByCallId.get(callId);
    if (existing) {
      return existing;
    }

    const card = createToolCard(toolName, callId, args, syscall);
    run.toolListNode.appendChild(card);
    if (run.state !== "error") {
      setRunState(run, "streaming", "running tools");
    }
    toolCardsByCallId.set(callId, card);
    toolCardOwnersByCallId.set(callId, run);
    return card;
  };

  const resetTimeline = (): void => {
    if (!logNode) {
      return;
    }

    logNode.innerHTML = "";
    textRunViewsByRunId.clear();
    toolRunViewsByRunId.clear();
    toolCardsByCallId.clear();
    toolCardOwnersByCallId.clear();
    pendingRunIds.clear();
    lastAssistantTextRun = null;
    lastAssistantToolRun = null;
  };

  const assignThreadContext = (
    context: ThreadContext | null,
    options?: { persist?: boolean },
  ): void => {
    activeThreadContext = context;
    activePid = context?.pid ?? null;
    if (options?.persist !== false) {
      setActiveThreadContext(context);
    }
    renderThreadRail();
  };

  const activateThreadContext = async (threadContext: ThreadContext): Promise<void> => {
    assignThreadContext(threadContext);
    loadedConnectionId = null;
    loadedPid = null;

    const status = client.getStatus();
    if (status.state === "connected") {
      await loadHistory(status.connectionId);
      await loadRecentThreads();
    }
  };

  const openRecentThread = async (workspaceId: string): Promise<void> => {
    if (!client.isConnected()) {
      appendTextRow("system", "session is locked");
      return;
    }

    const entry = recentThreads.find((candidate) => candidate.workspaceId === workspaceId);
    if (!entry) {
      appendTextRow("system", `thread not found: ${workspaceId}`);
      return;
    }

    const liveContext = normalizeThreadContext({
      pid: entry.activeProcess?.pid,
      workspaceId: entry.workspaceId,
      cwd: entry.activeProcess?.cwd,
    });
    if (liveContext) {
      await activateThreadContext(liveContext);
      return;
    }

    try {
      const spawnResult = await client.spawnProcess({
        label: entry.label ?? undefined,
        workspace: {
          mode: "attach",
          workspaceId: entry.workspaceId,
        },
      });

      if (!spawnResult.ok) {
        appendTextRow("system", `thread reopen failed: ${spawnResult.error}`);
        return;
      }

      const reopenedContext = normalizeThreadContext({
        pid: spawnResult.pid,
        workspaceId: spawnResult.workspaceId,
        cwd: spawnResult.cwd,
      });

      if (!reopenedContext) {
        appendTextRow("system", "thread reopen failed: invalid proc.spawn result");
        return;
      }

      await activateThreadContext(reopenedContext);
    } catch (error) {
      appendTextRow("system", `thread reopen failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const resetToNewThread = (): void => {
    assignThreadContext(null);
    loadedConnectionId = client.getStatus().connectionId;
    loadedPid = null;
    if (client.getStatus().state === "connected") {
      renderNoThreadState(client.getStatus().connectionId);
    }
    composerInput?.focus();
  };

  const renderNoThreadState = (connectionId: string | null): void => {
    resetTimeline();
    appendTextRow("system", "No thread selected. Send a message to start a new thread.");
    loadedConnectionId = connectionId;
    loadedPid = null;
    updateComposerState(client.getStatus());
  };

  const loadHistory = async (connectionId: string | null): Promise<void> => {
    if (!logNode) {
      return;
    }
    if (!activePid) {
      renderNoThreadState(connectionId);
      return;
    }

    const mergedMessages: Array<{
      role: "user" | "assistant" | "system" | "toolResult";
      content: unknown;
      timestamp?: number;
    }> = [];
    let historyTotal = 0;
    let historyTruncated = false;
    let offset = 0;
    const limit = 200;
    const maxPages = 100;

    for (let page = 0; page < maxPages; page += 1) {
      let historyPage: ProcHistoryResult;
      try {
        historyPage = await client.getHistory(limit, activePid ?? undefined, offset);
      } catch (error) {
        appendTextRow("system", `failed to load history: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }

      if (!historyPage.ok) {
        appendTextRow("system", `history error: ${historyPage.error}`);
        return;
      }

      mergedMessages.push(...historyPage.messages);
      historyTotal = historyPage.messageCount;
      offset += historyPage.messages.length;
      historyTruncated = historyPage.truncated === true;

      if (!historyTruncated || historyPage.messages.length === 0 || offset >= historyTotal) {
        break;
      }
    }

    resetTimeline();

    for (const entry of mergedMessages) {
      const entryTimestampMs = normalizeTimestampMs(entry.timestamp) ?? undefined;

      if (entry.role === "assistant") {
        const parsed = extractAssistantHistory(entry.content);
        if (parsed.text.trim()) {
          const textRun = createRun("text", `hist-text-${historySyntheticRunCounter++}`, entryTimestampMs);
          setRunMarkdown(textRun, parsed.text);
          setRunState(textRun, "complete");
        }

        if (parsed.toolCalls.length > 0) {
          const toolRun = createRun("tools", `hist-tools-${historySyntheticRunCounter++}`, entryTimestampMs);
          for (const toolCall of parsed.toolCalls) {
            ensureToolCard(toolRun, toolCall.callId, toolCall.toolName, toolCall.args, toolCall.syscall);
          }
          setRunState(toolRun, "complete");
        }
        continue;
      }

      if (entry.role === "toolResult") {
        const parsedResult = extractToolResultHistory(entry.content);
        if (!parsedResult) {
          appendTextRow("system", formatMessageContent(entry.content), entryTimestampMs);
          continue;
        }

        let run = lastAssistantToolRun;
        if (!run) {
          run = createRun("tools", `hist-tools-${historySyntheticRunCounter++}`, entryTimestampMs);
        }

        const callId = parsedResult.callId ?? `hist-result-${historySyntheticRunCounter++}`;
        const card = ensureToolCard(run, callId, parsedResult.toolName, {}, parsedResult.syscall);
        applyToolResult(card, parsedResult);
        if (run.state !== "error") {
          setRunState(run, "complete");
        }
        continue;
      }

      const role = mapHistoryRole(entry.role);
      appendTextRow(role, formatMessageContent(entry.content), entryTimestampMs);
    }

    if (mergedMessages.length === 0) {
      appendTextRow("system", "No messages yet. Send your first prompt.");
    } else if (historyTruncated && offset < historyTotal) {
      appendTextRow("system", `history truncated at ${offset}/${historyTotal} messages`);
    }

    loadedConnectionId = connectionId;
    loadedPid = activePid;
    scrollLogToBottom();
    updateComposerState(client.getStatus());
  };

  const applyConnectionStatus = (status: ChatStatus): void => {
    const connected = status.state === "connected";
    updateComposerState(status);

    if (!connected && wasConnected) {
      pendingRunIds.clear();
      updateComposerState(status);
      appendTextRow("system", "session disconnected");
    }

    if (connected) {
      if (!wasConnected) {
        void loadRecentThreads();
      }
      if (!activePid) {
        if (status.connectionId !== loadedConnectionId || loadedPid !== null) {
          renderNoThreadState(status.connectionId);
        }
      } else if (status.connectionId !== loadedConnectionId || activePid !== loadedPid) {
        void loadHistory(status.connectionId);
      }
    }

    wasConnected = connected;
  };

  const clearPendingRun = (runId: string | null): void => {
    if (!runId) {
      return;
    }
    if (pendingRunIds.delete(runId)) {
      updateComposerState(client.getStatus());
    }
  };

  const onSignal = (signal: string, payload: unknown): void => {
    if (!mounted || !logNode) {
      return;
    }
    if (!signal.startsWith("chat.")) {
      return;
    }

    const record = asRecord(payload);
    if (!record) {
      return;
    }

    const runId = asString(record.runId);
    const signalTimestampMs = normalizeTimestampMs(record.timestamp) ?? Date.now();
    const shouldStick = isNearBottom();

    if (signal === "chat.text") {
      const text = asString(record.text) ?? "";
      if (!text) {
        return;
      }

      const run = ensureTextRun(runId, signalTimestampMs);
      appendRunMarkdown(run, text);
      if (run.state !== "error") {
        setRunState(run, "streaming", "streaming");
      }
      maybeScrollToBottom(shouldStick);
      return;
    }

    if (signal === "chat.tool_call") {
      const parsedCall = parseToolCallSignal(payload);
      if (!parsedCall) {
        return;
      }

      const run = ensureToolRun(runId, signalTimestampMs);
      ensureToolCard(run, parsedCall.callId, parsedCall.toolName, parsedCall.args, parsedCall.syscall);
      if (run.state !== "error") {
        setRunState(run, "streaming", "running tools");
      }
      maybeScrollToBottom(shouldStick);
      return;
    }

    if (signal === "chat.tool_result") {
      const parsedResult = parseToolResultSignal(payload);
      if (!parsedResult) {
        return;
      }

      const targetCallId = parsedResult.callId ?? `live-result-${Date.now()}`;
      let card = toolCardsByCallId.get(targetCallId) ?? null;

      if (!card) {
        const run = ensureToolRun(runId, signalTimestampMs);
        card = ensureToolCard(run, targetCallId, parsedResult.toolName, {}, parsedResult.syscall);
      }

      applyToolResult(card, parsedResult);
      const run =
        toolCardOwnersByCallId.get(targetCallId) ??
        (runId ? toolRunViewsByRunId.get(runId) ?? null : null) ??
        lastAssistantToolRun;
      if (run) {
        setRunState(run, card.classList.contains("is-error") ? "error" : "streaming", card.classList.contains("is-error") ? "tool error" : "running tools");
      }
      maybeScrollToBottom(shouldStick);
      return;
    }

    if (signal === "chat.complete") {
      const error = asString(record.error);
      if (error) {
        const textRun = runId ? textRunViewsByRunId.get(runId) ?? null : null;
        const toolRun = runId ? toolRunViewsByRunId.get(runId) ?? null : null;
        if (textRun) {
          setRunState(textRun, "error");
        }
        if (toolRun) {
          setRunState(toolRun, "error");
        }
        clearPendingRun(runId);
        if (runId) {
          textRunViewsByRunId.delete(runId);
          toolRunViewsByRunId.delete(runId);
        }
        appendTextRow("system", `error: ${error}`);
        maybeScrollToBottom(shouldStick);
        return;
      }

      const finalText = asString(record.text) ?? "";
      const textRun = runId ? textRunViewsByRunId.get(runId) ?? null : null;
      const toolRun = runId ? toolRunViewsByRunId.get(runId) ?? null : null;

      if (toolRun && toolRun.state !== "error") {
        setRunState(toolRun, "complete");
      }

      if (textRun) {
        if (finalText.trim() && textRun.markdownSource.trim().length === 0) {
          setRunMarkdown(textRun, finalText);
        }
        if (textRun.state !== "error") {
          setRunState(textRun, "complete");
        }
        clearPendingRun(runId);
        if (runId) {
          textRunViewsByRunId.delete(runId);
          toolRunViewsByRunId.delete(runId);
        }
        maybeScrollToBottom(shouldStick);
        return;
      }

      if (!finalText.trim()) {
        clearPendingRun(runId);
        if (runId) {
          textRunViewsByRunId.delete(runId);
          toolRunViewsByRunId.delete(runId);
        }
        maybeScrollToBottom(shouldStick);
        return;
      }

      const fallbackRun = ensureTextRun(runId, signalTimestampMs);
      if (fallbackRun.markdownSource.trim().length === 0) {
        setRunMarkdown(fallbackRun, finalText);
      }
      if (fallbackRun.state !== "error") {
        setRunState(fallbackRun, "complete");
      }
      clearPendingRun(runId);
      if (runId) {
        textRunViewsByRunId.delete(runId);
        toolRunViewsByRunId.delete(runId);
      }
      maybeScrollToBottom(shouldStick);
      void loadRecentThreads();
    }
  };

  return {
    mount: (container, context: AppRuntimeContext) => {
      container.innerHTML = `
        <section class="chat-app">
          <aside class="chat-thread-rail">
            <div class="chat-thread-rail-head">
              <button type="button" class="runtime-btn chat-thread-primary-btn" data-chat-thread-new>New Thread</button>
              <button
                type="button"
                class="runtime-btn chat-thread-icon-btn"
                data-chat-thread-refresh
                title="Refresh threads"
                aria-label="Refresh threads"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v6h-6" />
                </svg>
              </button>
            </div>
            <p class="chat-thread-status" data-chat-thread-status></p>
            <div class="chat-thread-list" data-chat-thread-list></div>
          </aside>

          <section class="chat-main">
            <div class="chat-toolbar">
              <div class="chat-toolbar-actions">
                <button type="button" class="runtime-btn chat-toolbar-btn" data-chat-open-files>Files</button>
                <button type="button" class="runtime-btn chat-toolbar-btn" data-chat-open-shell>Shell</button>
              </div>
            </div>

            <section class="chat-log" data-chat-log></section>

            <form class="chat-composer" data-chat-compose hidden>
              <div class="chat-compose-surface">
                <div class="chat-compose-action-cluster">
                  <button
                    type="button"
                    class="chat-action-btn chat-action-attach"
                    data-chat-attach-toggle
                    data-state="closed"
                    aria-label="Add media"
                    aria-expanded="false"
                    title="Add media"
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M12 5v14M5 12h14" />
                    </svg>
                  </button>
                  <div class="chat-upload-tray" data-chat-upload-tray hidden>
                    <button type="button" class="chat-upload-btn" data-chat-upload-action="camera" title="Camera">
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M5 8h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2Z" />
                        <path d="M9 8l1.4-2h3.2L15 8" />
                        <circle cx="12" cy="13" r="3" />
                      </svg>
                    </button>
                    <button type="button" class="chat-upload-btn" data-chat-upload-action="image" title="Image">
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <rect x="4" y="4" width="16" height="16" rx="2" />
                        <circle cx="9" cy="9" r="1.6" />
                        <path d="m20 15-4.2-4.2a1.8 1.8 0 0 0-2.6 0L6 18" />
                      </svg>
                    </button>
                    <button type="button" class="chat-upload-btn" data-chat-upload-action="file" title="File">
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
                        <path d="M14 3v5h5" />
                      </svg>
                    </button>
                  </div>
                </div>
                <textarea
                  data-chat-input
                  rows="3"
                  placeholder="Ask anything... Enter to send, Shift+Enter for newline."
                ></textarea>
                <button
                  type="button"
                  class="chat-action-btn chat-action-voice"
                  data-chat-voice-toggle
                  data-state="idle"
                  aria-label="Start voice mode"
                  aria-pressed="false"
                  title="Start voice mode"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M4 12h2m3-4v8m5-10v12m5-8v8m3-4v4" />
                  </svg>
                </button>
                <button type="submit" class="chat-send-btn" data-chat-send title="Send message">Send</button>
              </div>
              <div class="chat-voice-panel" data-chat-voice-panel hidden>
                <div class="chat-voice-orb" aria-hidden="true"></div>
                <div class="chat-voice-copy">
                  <p class="chat-voice-title">Voice mode preview</p>
                  <p class="chat-voice-hint">Voice capture is not wired yet. Press the voice button again to close.</p>
                </div>
              </div>
            </form>
          </section>
        </section>
      `;

      mounted = true;
      suspended = false;
      wasConnected = false;
      loadedConnectionId = null;
      loadedPid = null;
      activePid = null;
      appWindowId = context.windowId;

      const chatLog = container.querySelector<HTMLElement>("[data-chat-log]");
      const chatCompose = container.querySelector<HTMLFormElement>("[data-chat-compose]");
      const chatInput = container.querySelector<HTMLTextAreaElement>("[data-chat-input]");
      const sendButton = container.querySelector<HTMLButtonElement>("[data-chat-send]");
      const attachButton = container.querySelector<HTMLButtonElement>("[data-chat-attach-toggle]");
      const voiceButton = container.querySelector<HTMLButtonElement>("[data-chat-voice-toggle]");
      const uploadTray = container.querySelector<HTMLElement>("[data-chat-upload-tray]");
      const uploadButtons = Array.from(container.querySelectorAll<HTMLButtonElement>("[data-chat-upload-action]"));
      const voicePanel = container.querySelector<HTMLElement>("[data-chat-voice-panel]");
      const threadList = container.querySelector<HTMLElement>("[data-chat-thread-list]");
      const threadStatus = container.querySelector<HTMLElement>("[data-chat-thread-status]");
      const newThreadButton = container.querySelector<HTMLButtonElement>("[data-chat-thread-new]");
      const refreshThreadsButton = container.querySelector<HTMLButtonElement>("[data-chat-thread-refresh]");
      const filesButton = container.querySelector<HTMLButtonElement>("[data-chat-open-files]");
      const shellButton = container.querySelector<HTMLButtonElement>("[data-chat-open-shell]");

      if (
        !chatLog ||
        !chatCompose ||
        !chatInput ||
        !sendButton ||
        !attachButton ||
        !voiceButton ||
        !uploadTray ||
        !voicePanel ||
        !threadList ||
        !threadStatus ||
        !newThreadButton ||
        !refreshThreadsButton ||
        !filesButton ||
        !shellButton
      ) {
        throw new Error("Chat app markup is incomplete");
      }

      composerInput = chatInput;
      composerButton = sendButton;
      composerAttachButton = attachButton;
      composerVoiceButton = voiceButton;
      composerUploadTray = uploadTray;
      composerUploadButtons = uploadButtons;
      composerVoicePanel = voicePanel;
      threadsNode = threadList;
      threadStatusNode = threadStatus;
      threadNewButton = newThreadButton;
      threadRefreshButton = refreshThreadsButton;
      openFilesButton = filesButton;
      openShellButton = shellButton;
      logNode = chatLog;
      composeNode = chatCompose;
      setUploadExpanded(false);
      setVoiceMode(false);
      renderThreadRail();

      if (appWindowId) {
        const queuedContext = consumePendingChatProcess(appWindowId);
        const normalizedContext = normalizeThreadContext(queuedContext);
        if (normalizedContext) {
          assignThreadContext(normalizedContext);
        }
      }

      appendTextRow("system", "Unlock desktop session to use chat.");

      const onComposeSubmit = async (event: SubmitEvent): Promise<void> => {
        event.preventDefault();

        const message = chatInput.value.trim();
        if (!message) {
          return;
        }

        if (!client.isConnected()) {
          appendTextRow("system", "session is locked");
          return;
        }

        appendTextRow("user", message);
        chatInput.value = "";
        chatInput.focus();
        updateComposerState(client.getStatus());

        try {
          if (!activePid) {
            const spawnResult = await client.spawnProcess({
              label: deriveThreadLabel(message),
              workspace: {
                mode: "new",
                kind: "thread",
              },
            });

            if (!spawnResult.ok) {
              appendTextRow("system", `thread start failed: ${spawnResult.error}`);
              return;
            }

            const threadContext = normalizeThreadContext({
              pid: spawnResult.pid,
              workspaceId: spawnResult.workspaceId,
              cwd: spawnResult.cwd,
            });

            if (!threadContext) {
              appendTextRow("system", "thread start failed: invalid proc.spawn result");
              return;
            }

            assignThreadContext(threadContext);
            resetTimeline();
            appendTextRow("user", message);
            loadedConnectionId = client.getStatus().connectionId;
            loadedPid = threadContext.pid;
            void loadRecentThreads();
          }

          const result = await client.sendMessage(message, activePid ?? undefined);
          if (!result.ok) {
            appendTextRow("system", `send failed: ${result.error}`);
            return;
          }

          pendingRunIds.add(result.runId);
          updateComposerState(client.getStatus());

          if (result.queued) {
            appendTextRow("system", "message queued while process is busy");
          }
        } catch (error) {
          appendTextRow("system", `send failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      };

      const onComposerKeyDown = (event: KeyboardEvent): void => {
        if (event.key !== "Enter" || event.shiftKey) {
          return;
        }

        event.preventDefault();
        chatCompose.requestSubmit();
      };

      const onComposerInput = (): void => {
        if (chatInput.value.trim().length > 0) {
          setUploadExpanded(false);
        }
        updateComposerState(client.getStatus());
      };

      const onAttachToggle = (): void => {
        if (chatInput.value.trim().length > 0 || voiceMode) {
          return;
        }
        setUploadExpanded(!uploadExpanded);
        updateComposerState(client.getStatus());
      };

      const onVoiceToggle = (): void => {
        if (chatInput.value.trim().length > 0) {
          return;
        }
        const next = !voiceMode;
        setVoiceMode(next);
        if (next) {
          setUploadExpanded(false);
          chatInput.blur();
          updateComposerState(client.getStatus());
          return;
        }
        chatInput.focus();
        updateComposerState(client.getStatus());
      };

      const onUploadActionClick = (event: MouseEvent): void => {
        const button = event.currentTarget as HTMLButtonElement | null;
        if (!button) {
          return;
        }
        setUploadExpanded(false);
        const kind = button.dataset.chatUploadAction ?? "attachment";
        button.title = `${kind} support coming soon`;
        chatInput.focus();
      };

      const onThreadListClick = (event: MouseEvent): void => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) {
          return;
        }

        const actionNode = target.closest<HTMLElement>("[data-chat-thread-action]");
        if (!actionNode || actionNode.dataset.chatThreadAction !== "open-thread") {
          return;
        }

        const workspaceId = actionNode.dataset.workspaceId?.trim();
        if (!workspaceId) {
          return;
        }

        void openRecentThread(workspaceId);
      };

      const onNewThreadClick = (): void => {
        resetToNewThread();
      };

      const onRefreshThreadsClick = (): void => {
        void loadRecentThreads();
      };

      const onOpenFilesClick = (): void => {
        openCompanionApp("files");
      };

      const onOpenShellClick = (): void => {
        openCompanionApp("shell");
      };

      chatCompose.addEventListener("submit", onComposeSubmit);
      chatInput.addEventListener("keydown", onComposerKeyDown);
      chatInput.addEventListener("input", onComposerInput);
      attachButton.addEventListener("click", onAttachToggle);
      voiceButton.addEventListener("click", onVoiceToggle);
      threadList.addEventListener("click", onThreadListClick);
      newThreadButton.addEventListener("click", onNewThreadClick);
      refreshThreadsButton.addEventListener("click", onRefreshThreadsClick);
      filesButton.addEventListener("click", onOpenFilesClick);
      shellButton.addEventListener("click", onOpenShellClick);
      for (const uploadButton of uploadButtons) {
        uploadButton.addEventListener("click", onUploadActionClick);
      }

      cleanup.add(() => chatCompose.removeEventListener("submit", onComposeSubmit));
      cleanup.add(() => chatInput.removeEventListener("keydown", onComposerKeyDown));
      cleanup.add(() => chatInput.removeEventListener("input", onComposerInput));
      cleanup.add(() => attachButton.removeEventListener("click", onAttachToggle));
      cleanup.add(() => voiceButton.removeEventListener("click", onVoiceToggle));
      cleanup.add(() => threadList.removeEventListener("click", onThreadListClick));
      cleanup.add(() => newThreadButton.removeEventListener("click", onNewThreadClick));
      cleanup.add(() => refreshThreadsButton.removeEventListener("click", onRefreshThreadsClick));
      cleanup.add(() => filesButton.removeEventListener("click", onOpenFilesClick));
      cleanup.add(() => shellButton.removeEventListener("click", onOpenShellClick));
      cleanup.add(() => {
        for (const uploadButton of uploadButtons) {
          uploadButton.removeEventListener("click", onUploadActionClick);
        }
      });

      const offSignal = client.onSignal(onSignal);
      const offStatus = client.onStatus((status) => {
        applyConnectionStatus(status);
      });
      cleanup.add(offSignal);
      cleanup.add(offStatus);

      const onTargetProcess = (event: Event): void => {
        if (!(event instanceof CustomEvent)) {
          return;
        }
        const detail = event.detail as Partial<TargetChatProcessEventDetail> | null;
        if (detail?.windowId && appWindowId && detail.windowId !== appWindowId) {
          return;
        }
        const normalized = normalizeThreadContext(detail);
        if (!normalized) {
          return;
        }
        const targetWindowId = detail?.windowId;
        if (targetWindowId) {
          consumePendingChatProcess(targetWindowId);
        }
        assignThreadContext(normalized);
        loadedConnectionId = null;
        loadedPid = null;
        const status = client.getStatus();
        if (status.state === "connected") {
          void loadHistory(status.connectionId);
          void loadRecentThreads();
        }
      };
      window.addEventListener(TARGET_CHAT_PROCESS_EVENT, onTargetProcess as EventListener);
      cleanup.add(() => window.removeEventListener(TARGET_CHAT_PROCESS_EVENT, onTargetProcess as EventListener));

      applyConnectionStatus(client.getStatus());
    },

    suspend: () => {
      suspended = true;
      updateComposerState(client.getStatus());
    },

    resume: () => {
      suspended = false;
      applyConnectionStatus(client.getStatus());
      composerInput?.focus();
    },

    terminate: () => {
      mounted = false;
      textRunViewsByRunId.clear();
      toolRunViewsByRunId.clear();
      toolCardsByCallId.clear();
      toolCardOwnersByCallId.clear();
      pendingRunIds.clear();
      lastAssistantTextRun = null;
      lastAssistantToolRun = null;

      for (const fn of cleanup) {
        fn();
      }
      cleanup.clear();

      composerInput = null;
      composerButton = null;
      composerAttachButton = null;
      composerVoiceButton = null;
      composerUploadTray = null;
      composerUploadButtons = [];
      composerVoicePanel = null;
      threadsNode = null;
      threadStatusNode = null;
      threadNewButton = null;
      threadRefreshButton = null;
      openFilesButton = null;
      openShellButton = null;
      logNode = null;
      composeNode = null;
      voiceMode = false;
      uploadExpanded = false;
      recentThreads = [];
      threadsLoading = false;
      threadsError = "";
      loadedPid = null;
      activePid = null;
      appWindowId = null;
    },
  };
}

class GsvChatAppElement extends HTMLElement implements GsvAppElement {
  private controller: AppInstance | null = null;
  readonly gsvFullBleed = true;

  async gsvMount(context: AppElementContext): Promise<void> {
    await this.gsvUnmount();

    const controller = createChatAppController(context.kernel);
    this.controller = controller;
    await controller.mount(this, context);
  }

  async gsvSuspend(): Promise<void> {
    await this.controller?.suspend?.();
  }

  async gsvResume(): Promise<void> {
    await this.controller?.resume?.();
  }

  async gsvUnmount(): Promise<void> {
    if (!this.controller) {
      return;
    }

    const controller = this.controller;
    this.controller = null;
    await controller.terminate?.();
  }
}

export function ensureChatAppRegistered(): void {
  if (!customElements.get("gsv-chat-app")) {
    customElements.define("gsv-chat-app", GsvChatAppElement);
  }
}
