import DOMPurify from "dompurify";
import { marked } from "marked";

import type { AppInstance, AppRuntimeContext } from "./app-runtime";
import type { ProcHistoryResult } from "./gateway-client";
import type { AppElementContext, AppKernelClient, GsvAppElement } from "./app-sdk";

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

type AssistantRunView = {
  runId: string | null;
  rowNode: HTMLElement;
  markdownNode: HTMLElement;
  toolListNode: HTMLElement;
  markdownSource: string;
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

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
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

function createTextRow(role: ChatRole, text: string): HTMLElement {
  const row = document.createElement("article");
  row.className = `chat-row chat-row-${role}`;

  const roleNode = document.createElement("div");
  roleNode.className = "chat-row-role";
  roleNode.textContent = role;

  const textNode = document.createElement("pre");
  textNode.className = "chat-row-text";
  textNode.textContent = text;

  row.append(roleNode, textNode);
  return row;
}

function createAssistantRunRow(runId: string | null): AssistantRunView {
  const rowNode = document.createElement("article");
  rowNode.className = "chat-row chat-row-assistant";
  if (runId) {
    rowNode.dataset.runId = runId;
  }

  const roleNode = document.createElement("div");
  roleNode.className = "chat-row-role";
  roleNode.textContent = "assistant";

  const bodyNode = document.createElement("div");
  bodyNode.className = "chat-row-body";

  const markdownNode = document.createElement("div");
  markdownNode.className = "chat-markdown";

  const toolListNode = document.createElement("div");
  toolListNode.className = "tool-list";

  bodyNode.append(markdownNode, toolListNode);
  rowNode.append(roleNode, bodyNode);

  return {
    runId,
    rowNode,
    markdownNode,
    toolListNode,
    markdownSource: "",
  };
}

function setRunMarkdown(run: AssistantRunView, markdown: string): void {
  run.markdownSource = markdown;
  run.markdownNode.innerHTML = toMarkdownHtml(run.markdownSource);
}

function appendRunMarkdown(run: AssistantRunView, chunk: string): void {
  setRunMarkdown(run, `${run.markdownSource}${chunk}`);
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
  const card = document.createElement("article");
  card.className = "tool-card is-pending";
  card.dataset.callId = callId;

  const header = document.createElement("header");
  header.className = "tool-card-head";

  const title = document.createElement("h4");
  title.className = "tool-card-title";
  title.textContent = toolName;

  const status = document.createElement("span");
  status.className = "tool-card-status";
  status.textContent = "running";

  header.append(title, status);

  const syscallNode = document.createElement("p");
  syscallNode.className = "tool-card-subtle";
  syscallNode.textContent = syscall ? `syscall: ${syscall}` : "";

  const inputNode = renderToolCallInput(toolName, args);
  inputNode.classList.add("tool-input");

  const resultNode = document.createElement("div");
  resultNode.className = "tool-result";
  resultNode.hidden = true;

  card.append(header, syscallNode, inputNode, resultNode);
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

  const statusNode = card.querySelector<HTMLElement>(".tool-card-status");
  if (statusNode) {
    if (result.toolName === "Shell" && outputRecord?.backgrounded === true) {
      statusNode.textContent = "backgrounded";
    } else if (result.toolName === "Shell" && exitCode !== null) {
      statusNode.textContent = `exit ${exitCode}`;
    } else {
      statusNode.textContent = effectiveOk ? "done" : "error";
    }
  }

  const resultNode = card.querySelector<HTMLElement>(".tool-result");
  if (!resultNode) {
    return;
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
    syscall: asString(record.syscall),
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
    syscall: asString(record.syscall),
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
      syscall: asString(item.syscall),
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
    syscall: asString(record.syscall),
  };
}

function mapHistoryRole(role: string): ChatRole {
  if (role === "assistant") return "assistant";
  if (role === "user") return "user";
  return "system";
}

function createChatAppController(client: AppKernelClient): AppInstance {
  let composerInput: HTMLTextAreaElement | null = null;
  let composerButton: HTMLButtonElement | null = null;
  let logNode: HTMLElement | null = null;
  let composeNode: HTMLFormElement | null = null;
  let mounted = false;
  let suspended = false;
  let wasConnected = false;
  let loadedConnectionId: string | null = null;
  let historySyntheticRunCounter = 0;

  const runViewsByRunId = new Map<string, AssistantRunView>();
  const toolCardsByCallId = new Map<string, HTMLElement>();
  let lastAssistantRun: AssistantRunView | null = null;

  const cleanup = new Set<() => void>();

  const scrollLogToBottom = (): void => {
    if (!logNode) return;
    logNode.scrollTop = logNode.scrollHeight;
  };

  const appendRowNode = (node: HTMLElement): void => {
    if (!logNode) {
      return;
    }

    logNode.appendChild(node);
    scrollLogToBottom();
  };

  const appendTextRow = (role: ChatRole, text: string): void => {
    appendRowNode(createTextRow(role, text));
  };

  const createRun = (runId: string | null): AssistantRunView => {
    const run = createAssistantRunRow(runId);
    appendRowNode(run.rowNode);

    if (runId) {
      runViewsByRunId.set(runId, run);
    }

    lastAssistantRun = run;
    return run;
  };

  const ensureRun = (runId: string | null): AssistantRunView => {
    if (runId) {
      const existing = runViewsByRunId.get(runId);
      if (existing) {
        return existing;
      }
    }

    return createRun(runId);
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
    toolCardsByCallId.set(callId, card);
    return card;
  };

  const resetTimeline = (): void => {
    if (!logNode) {
      return;
    }

    logNode.innerHTML = "";
    runViewsByRunId.clear();
    toolCardsByCallId.clear();
    lastAssistantRun = null;
  };

  const loadHistory = async (connectionId: string | null): Promise<void> => {
    if (!logNode) {
      return;
    }

    let history: ProcHistoryResult;
    try {
      history = await client.getHistory(80);
    } catch (error) {
      appendTextRow("system", `failed to load history: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    if (!history.ok) {
      appendTextRow("system", `history error: ${history.error}`);
      return;
    }

    resetTimeline();

    for (const entry of history.messages) {
      if (entry.role === "assistant") {
        const parsed = extractAssistantHistory(entry.content);
        const syntheticRunId = `hist-run-${historySyntheticRunCounter++}`;
        const run = createRun(syntheticRunId);

        if (parsed.text.trim()) {
          setRunMarkdown(run, parsed.text);
        }

        for (const toolCall of parsed.toolCalls) {
          ensureToolCard(run, toolCall.callId, toolCall.toolName, toolCall.args, toolCall.syscall);
        }

        continue;
      }

      if (entry.role === "toolResult") {
        const parsedResult = extractToolResultHistory(entry.content);
        if (!parsedResult) {
          appendTextRow("system", prettyJson(entry.content));
          continue;
        }

        let run = lastAssistantRun;
        if (!run) {
          run = createRun(`hist-run-${historySyntheticRunCounter++}`);
        }

        const callId = parsedResult.callId ?? `hist-result-${historySyntheticRunCounter++}`;
        const card = ensureToolCard(run, callId, parsedResult.toolName, {}, parsedResult.syscall);
        applyToolResult(card, parsedResult);
        continue;
      }

      const role = mapHistoryRole(entry.role);
      appendTextRow(role, prettyJson(entry.content));
    }

    if (history.messages.length === 0) {
      appendTextRow("system", "No messages yet. Send your first prompt.");
    }

    loadedConnectionId = connectionId;
  };

  const applyConnectionStatus = (status: ChatStatus): void => {
    const connected = status.state === "connected";
    if (composeNode) {
      composeNode.hidden = !connected;
    }
    if (composerInput) {
      composerInput.disabled = !connected || suspended;
    }
    if (composerButton) {
      composerButton.disabled = !connected || suspended;
    }

    if (!connected && wasConnected) {
      appendTextRow("system", "session disconnected");
    }

    if (connected && status.connectionId !== loadedConnectionId) {
      void loadHistory(status.connectionId);
    }

    wasConnected = connected;
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

    if (signal === "chat.text") {
      const text = asString(record.text) ?? "";
      if (!text) {
        return;
      }

      const run = ensureRun(runId);
      appendRunMarkdown(run, text);
      return;
    }

    if (signal === "chat.tool_call") {
      const parsedCall = parseToolCallSignal(payload);
      if (!parsedCall) {
        return;
      }

      const run = ensureRun(runId);
      ensureToolCard(run, parsedCall.callId, parsedCall.toolName, parsedCall.args, parsedCall.syscall);
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
        const run = ensureRun(runId);
        card = ensureToolCard(run, targetCallId, parsedResult.toolName, {}, parsedResult.syscall);
      }

      applyToolResult(card, parsedResult);
      return;
    }

    if (signal === "chat.complete") {
      if (runId) {
        runViewsByRunId.delete(runId);
      }

      const error = asString(record.error);
      if (error) {
        appendTextRow("system", `error: ${error}`);
        return;
      }

      const finalText = asString(record.text) ?? "";
      if (!finalText.trim()) {
        return;
      }

      const run = runId ? runViewsByRunId.get(runId) ?? null : null;
      if (run && run.markdownSource.trim().length === 0) {
        setRunMarkdown(run, finalText);
        return;
      }

      if (!run) {
        const fallbackRun = ensureRun(runId);
        if (fallbackRun.markdownSource.trim().length === 0) {
          setRunMarkdown(fallbackRun, finalText);
        }
      }
    }
  };

  return {
    mount: (container, _context: AppRuntimeContext) => {
      container.innerHTML = `
        <section class="chat-app">
          <section class="chat-log" data-chat-log>
            <article class="chat-row chat-row-system">
              <div class="chat-row-role">system</div>
              <pre class="chat-row-text">Unlock desktop session to use chat.</pre>
            </article>
          </section>

          <form class="chat-composer" data-chat-compose hidden>
            <textarea
              data-chat-input
              rows="3"
              placeholder="Type a message. Enter to send, Shift+Enter for newline."
            ></textarea>
            <button type="submit" class="runtime-btn" data-chat-send>Send</button>
          </form>
        </section>
      `;

      mounted = true;
      suspended = false;
      wasConnected = false;
      loadedConnectionId = null;

      const chatLog = container.querySelector<HTMLElement>("[data-chat-log]");
      const chatCompose = container.querySelector<HTMLFormElement>("[data-chat-compose]");
      const chatInput = container.querySelector<HTMLTextAreaElement>("[data-chat-input]");
      const sendButton = container.querySelector<HTMLButtonElement>("[data-chat-send]");

      if (!chatLog || !chatCompose || !chatInput || !sendButton) {
        throw new Error("Chat app markup is incomplete");
      }

      composerInput = chatInput;
      composerButton = sendButton;
      logNode = chatLog;
      composeNode = chatCompose;

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

        try {
          const result = await client.sendMessage(message);
          if (!result.ok) {
            appendTextRow("system", `send failed: ${result.error}`);
            return;
          }

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

      chatCompose.addEventListener("submit", onComposeSubmit);
      chatInput.addEventListener("keydown", onComposerKeyDown);

      cleanup.add(() => chatCompose.removeEventListener("submit", onComposeSubmit));
      cleanup.add(() => chatInput.removeEventListener("keydown", onComposerKeyDown));

      const offSignal = client.onSignal(onSignal);
      const offStatus = client.onStatus((status) => {
        applyConnectionStatus(status);
      });
      cleanup.add(offSignal);
      cleanup.add(offStatus);

      applyConnectionStatus(client.getStatus());
    },

    suspend: () => {
      suspended = true;
      if (composerInput) composerInput.disabled = true;
      if (composerButton) composerButton.disabled = true;
    },

    resume: () => {
      suspended = false;
      applyConnectionStatus(client.getStatus());
      composerInput?.focus();
    },

    terminate: () => {
      mounted = false;
      runViewsByRunId.clear();
      toolCardsByCallId.clear();
      lastAssistantRun = null;

      for (const fn of cleanup) {
        fn();
      }
      cleanup.clear();

      composerInput = null;
      composerButton = null;
      logNode = null;
      composeNode = null;
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
