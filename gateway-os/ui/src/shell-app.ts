import type { AppElementContext, GsvAppElement } from "./app-sdk";

type DeviceSummary = {
  deviceId: string;
  platform: string;
  version: string;
  online: boolean;
};

type DeviceListResult = {
  devices?: DeviceSummary[];
};

type ShellViewState = "ready" | "working" | "error" | "offline";
type ShellStatusKind = "idle" | "error";
type TranscriptStatus = "ok" | "error" | "backgrounded";

type ShellTranscriptEntry = {
  id: string;
  startedAt: number;
  completedAt: number;
  target: string;
  command: string;
  status: TranscriptStatus;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  note: string | null;
  raw: unknown;
};

type ShellSessionEntry = {
  id: string;
  status: string;
  running: boolean;
  command: string;
  pid: number | null;
  startedAt: number | null;
  runtimeMs: number | null;
  tail: string;
};

type LooseRecord = Record<string, unknown>;

const SESSION_REFRESH_MS = 8_000;
const TRANSCRIPT_LIMIT = 120;

function defineElement(tagName: string, constructor: CustomElementConstructor): void {
  if (!customElements.get(tagName)) {
    customElements.define(tagName, constructor);
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function asRecord(value: unknown): LooseRecord | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as LooseRecord;
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

function normalizeTarget(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : "gsv";
}

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatTimestampMs(value: number): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return date.toLocaleString();
}

function formatRuntimeMs(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value < 0) {
    return "—";
  }
  if (value < 1_000) {
    return `${Math.floor(value)}ms`;
  }

  const seconds = value / 1_000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60);
  return `${minutes}m ${remainder}s`;
}

function normalizeSessions(payload: unknown): ShellSessionEntry[] {
  const record = asRecord(payload);
  if (!record) {
    return [];
  }

  const fromProcesses = Array.isArray(record.processes) ? record.processes : [];
  if (fromProcesses.length > 0) {
    const parsed: ShellSessionEntry[] = [];
    for (let index = 0; index < fromProcesses.length; index += 1) {
      const row = asRecord(fromProcesses[index]);
      if (!row) {
        continue;
      }
      const pid = asNumber(row.pid);
      const command = asString(row.command) ?? "";
      const running = asBoolean(row.running) ?? false;
      const startedAt = asNumber(row.startedAt);
      const exitCode = asNumber(row.exitCode);

      parsed.push({
        id: `pid:${pid ?? index}`,
        status: running ? "running" : (exitCode === null ? "stopped" : `exit ${exitCode}`),
        running,
        command,
        pid,
        startedAt,
        runtimeMs: null,
        tail: "",
      });
    }

    parsed.sort((left, right) => {
      if (left.running !== right.running) {
        return left.running ? -1 : 1;
      }
      return (right.startedAt ?? 0) - (left.startedAt ?? 0);
    });
    return parsed;
  }

  const fromSessions = Array.isArray(record.sessions) ? record.sessions : [];
  if (fromSessions.length === 0) {
    return [];
  }

  const parsed: ShellSessionEntry[] = [];
  for (let index = 0; index < fromSessions.length; index += 1) {
    const row = asRecord(fromSessions[index]);
    if (!row) {
      continue;
    }

    const sessionId = asString(row.sessionId) ?? `session-${index}`;
    const status = asString(row.status) ?? "unknown";
    const running = status.toLowerCase() === "running";
    const pid = asNumber(row.pid);
    const startedAt = asNumber(row.startedAt);
    const runtimeMs = asNumber(row.runtimeMs);
    const command = asString(row.command) ?? "";
    const tail = asString(row.tail) ?? "";

    parsed.push({
      id: sessionId,
      status,
      running,
      command,
      pid,
      startedAt,
      runtimeMs,
      tail,
    });
  }

  parsed.sort((left, right) => {
    if (left.running !== right.running) {
      return left.running ? -1 : 1;
    }
    return (right.startedAt ?? 0) - (left.startedAt ?? 0);
  });
  return parsed;
}

function normalizeTranscriptEntry(
  payload: unknown,
  startedAt: number,
  target: string,
  command: string,
): ShellTranscriptEntry {
  const completedAt = Date.now();
  const record = asRecord(payload);
  const defaultEntry: ShellTranscriptEntry = {
    id: `${startedAt}-${Math.random().toString(36).slice(2, 8)}`,
    startedAt,
    completedAt,
    target,
    command,
    status: "ok",
    exitCode: null,
    stdout: "",
    stderr: "",
    note: null,
    raw: payload,
  };

  if (!record) {
    defaultEntry.stdout = prettyJson(payload);
    return defaultEntry;
  }

  const explicitOk = asBoolean(record.ok);
  const statusText = (asString(record.status) ?? "").toLowerCase();
  const exitCode = asNumber(record.exitCode);
  const stdout =
    asString(record.stdout) ??
    (statusText === "completed" || statusText === "failed" ? asString(record.output) : null) ??
    "";
  const stderr = asString(record.stderr) ?? "";
  const errorText = asString(record.error);

  defaultEntry.exitCode = exitCode;
  defaultEntry.stdout = stdout;
  defaultEntry.stderr = stderr;

  const backgrounded =
    asBoolean(record.backgrounded) === true ||
    (statusText === "running" && asString(record.sessionId) !== null);

  if (backgrounded) {
    defaultEntry.status = "backgrounded";
    const sessionId = asString(record.sessionId);
    defaultEntry.note = sessionId ? `Background session ${sessionId}` : "Command backgrounded";
    return defaultEntry;
  }

  if (explicitOk === false || statusText === "failed" || errorText) {
    defaultEntry.status = "error";
    defaultEntry.stderr = errorText ?? defaultEntry.stderr;
    return defaultEntry;
  }

  if (exitCode !== null && exitCode !== 0) {
    defaultEntry.status = "error";
    defaultEntry.note = `Exit ${exitCode}`;
    return defaultEntry;
  }

  defaultEntry.status = "ok";
  if (exitCode !== null) {
    defaultEntry.note = `Exit ${exitCode}`;
  }
  return defaultEntry;
}

class GsvShellAppElement extends HTMLElement implements GsvAppElement {
  private context: AppElementContext | null = null;
  private kernelState: "disconnected" | "connecting" | "connected" = "disconnected";
  private suspended = false;
  private isExecuting = false;
  private isRefreshingSessions = false;
  private statusKind: ShellStatusKind = "idle";
  private statusText = "";

  private target = "gsv";
  private command = "";
  private workdir = "";
  private timeout = "";
  private yieldMs = "";
  private background = false;

  private devices: DeviceSummary[] = [];
  private sessions: ShellSessionEntry[] = [];
  private transcript: ShellTranscriptEntry[] = [];
  private commandHistory: string[] = [];
  private historyCursor: number | null = null;
  private historyDraft = "";

  private sessionRefreshTimer: number | null = null;
  private unsubscribeStatus: (() => void) | null = null;

  private readonly onClick = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    const actionNode = target.closest<HTMLElement>("[data-action]");
    if (!actionNode) {
      return;
    }

    const action = actionNode.dataset.action;
    if (!action) {
      return;
    }

    if (action === "run") {
      void this.runCommand();
      return;
    }
    if (action === "clear-transcript") {
      this.transcript = [];
      this.render();
      return;
    }
    if (action === "refresh-sessions") {
      void this.loadDeviceSuggestions();
      void this.loadSessions(true);
    }
  };

  private readonly onInput = (event: Event): void => {
    const target = event.target;
    if (
      !(target instanceof HTMLInputElement) &&
      !(target instanceof HTMLTextAreaElement) &&
      !(target instanceof HTMLSelectElement)
    ) {
      return;
    }

    const field = target.dataset.field;
    if (!field) {
      return;
    }

    switch (field) {
      case "target-select":
        if (!(target instanceof HTMLSelectElement)) {
          return;
        }
        this.target = target.value;
        if (normalizeTarget(this.target) === "gsv") {
          this.sessions = [];
        } else {
          void this.loadSessions(false);
        }
        this.render();
        break;
      case "command":
        this.command = target.value;
        this.historyCursor = null;
        this.historyDraft = "";
        break;
      case "workdir":
        this.workdir = target.value;
        break;
      case "timeout":
        this.timeout = target.value;
        break;
      case "yieldMs":
        this.yieldMs = target.value;
        break;
      case "background":
        if (target instanceof HTMLInputElement) {
          this.background = target.checked;
        }
        break;
      default:
        break;
    }
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    const target = event.target;
    if (!(target instanceof HTMLTextAreaElement)) {
      return;
    }
    if (target.dataset.field !== "command") {
      return;
    }

    if (
      !event.shiftKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      event.key === "ArrowUp" &&
      target.selectionStart === 0 &&
      target.selectionEnd === 0
    ) {
      event.preventDefault();
      this.navigateHistory(-1, target);
      return;
    }

    if (
      !event.shiftKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      event.key === "ArrowDown" &&
      target.selectionStart === target.value.length &&
      target.selectionEnd === target.value.length
    ) {
      event.preventDefault();
      this.navigateHistory(1, target);
      return;
    }

    if (event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }

    event.preventDefault();
    void this.runCommand();
  };

  async gsvMount(context: AppElementContext): Promise<void> {
    this.context = context;
    this.kernelState = context.kernel.getStatus().state;
    this.suspended = false;

    this.unsubscribeStatus?.();
    this.unsubscribeStatus = context.kernel.onStatus((status) => {
      this.kernelState = status.state;
      if (status.state === "connected" && !this.suspended) {
        void this.loadDeviceSuggestions();
        void this.loadSessions(false);
        this.startSessionRefresh();
      } else {
        this.stopSessionRefresh();
      }
      this.render();
    });

    this.addEventListener("click", this.onClick);
    this.addEventListener("input", this.onInput);
    this.addEventListener("keydown", this.onKeyDown);

    this.render();
    if (this.kernelState === "connected") {
      await this.loadDeviceSuggestions();
      await this.loadSessions(false);
      this.startSessionRefresh();
    }
  }

  async gsvSuspend(): Promise<void> {
    this.suspended = true;
    this.stopSessionRefresh();
    this.render();
  }

  async gsvResume(): Promise<void> {
    this.suspended = false;
    if (this.kernelState === "connected") {
      await this.loadDeviceSuggestions();
      await this.loadSessions(false);
      this.startSessionRefresh();
    }
    this.render();
  }

  async gsvUnmount(): Promise<void> {
    this.stopSessionRefresh();
    this.removeEventListener("click", this.onClick);
    this.removeEventListener("input", this.onInput);
    this.removeEventListener("keydown", this.onKeyDown);
    this.unsubscribeStatus?.();
    this.unsubscribeStatus = null;

    this.context = null;
    this.sessions = [];
    this.devices = [];
    this.transcript = [];
    this.kernelState = "disconnected";
    this.suspended = false;
    this.isExecuting = false;
    this.isRefreshingSessions = false;
    this.statusKind = "idle";
    this.statusText = "";
    this.command = "";
    this.workdir = "";
    this.timeout = "";
    this.yieldMs = "";
    this.background = false;
    this.commandHistory = [];
    this.historyCursor = null;
    this.historyDraft = "";
  }

  private setStatus(kind: ShellStatusKind, text: string): void {
    this.statusKind = kind;
    this.statusText = text;
  }

  private describeViewState(): { kind: ShellViewState; label: string; detail: string } {
    if (this.kernelState !== "connected") {
      return {
        kind: "offline",
        label: "offline",
        detail: "Kernel is not connected.",
      };
    }

    if (this.statusKind === "error" && this.statusText.length > 0) {
      return {
        kind: "error",
        label: "error",
        detail: this.statusText,
      };
    }

    if (this.isExecuting || this.isRefreshingSessions) {
      return {
        kind: "working",
        label: this.isExecuting ? "running" : "refreshing",
        detail: this.isExecuting ? "Executing command." : "Refreshing remote sessions.",
      };
    }

    return {
      kind: "ready",
      label: "ready",
      detail: "Shell is ready.",
    };
  }

  private isNearBottom(): boolean {
    const node = this.querySelector<HTMLElement>("[data-shell-log]");
    if (!node) {
      return true;
    }
    const remaining = node.scrollHeight - node.scrollTop - node.clientHeight;
    return remaining < 96;
  }

  private scrollToBottom(): void {
    const node = this.querySelector<HTMLElement>("[data-shell-log]");
    if (!node) {
      return;
    }
    node.scrollTop = node.scrollHeight;
  }

  private pushTranscript(entry: ShellTranscriptEntry): void {
    const shouldStick = this.isNearBottom();
    this.transcript = [...this.transcript, entry].slice(-TRANSCRIPT_LIMIT);
    this.render();

    if (shouldStick) {
      window.requestAnimationFrame(() => {
        this.scrollToBottom();
      });
    }
  }

  private startSessionRefresh(): void {
    if (this.sessionRefreshTimer !== null) {
      return;
    }
    this.sessionRefreshTimer = window.setInterval(() => {
      if (
        this.suspended ||
        this.kernelState !== "connected" ||
        this.isExecuting ||
        this.isRefreshingSessions
      ) {
        return;
      }
      void this.loadDeviceSuggestions();
      if (normalizeTarget(this.target) !== "gsv") {
        void this.loadSessions(false);
      }
    }, SESSION_REFRESH_MS);
  }

  private navigateHistory(direction: -1 | 1, textarea: HTMLTextAreaElement): void {
    if (this.commandHistory.length === 0) {
      return;
    }

    if (this.historyCursor === null) {
      this.historyDraft = this.command;
      this.historyCursor = this.commandHistory.length;
    }

    const nextIndex = this.historyCursor + direction;
    if (nextIndex < 0) {
      this.historyCursor = 0;
    } else if (nextIndex > this.commandHistory.length) {
      this.historyCursor = this.commandHistory.length;
    } else {
      this.historyCursor = nextIndex;
    }

    if (this.historyCursor === this.commandHistory.length) {
      this.command = this.historyDraft;
    } else {
      this.command = this.commandHistory[this.historyCursor] ?? "";
    }

    textarea.value = this.command;
    const cursor = this.command.length;
    textarea.setSelectionRange(cursor, cursor);
  }

  private rememberCommand(command: string): void {
    const trimmed = command.trim();
    if (!trimmed) {
      return;
    }

    const last = this.commandHistory[this.commandHistory.length - 1];
    if (last !== trimmed) {
      this.commandHistory.push(trimmed);
    }
    if (this.commandHistory.length > 200) {
      this.commandHistory = this.commandHistory.slice(-200);
    }
    this.historyCursor = null;
    this.historyDraft = "";
  }

  private stopSessionRefresh(): void {
    if (this.sessionRefreshTimer === null) {
      return;
    }
    window.clearInterval(this.sessionRefreshTimer);
    this.sessionRefreshTimer = null;
  }

  private async loadDeviceSuggestions(): Promise<void> {
    const context = this.context;
    if (!context || this.kernelState !== "connected" || this.suspended) {
      return;
    }

    try {
      const payload = await context.kernel.request<DeviceListResult>("sys.device.list", {});
      const next = Array.isArray(payload.devices) ? payload.devices : [];
      next.sort((left, right) => left.deviceId.localeCompare(right.deviceId));
      this.devices = next;
      const normalizedTarget = normalizeTarget(this.target);
      if (
        normalizedTarget !== "gsv" &&
        !next.some((device) => device.deviceId === normalizedTarget)
      ) {
        this.target = "gsv";
        this.sessions = [];
      }
      this.render();
    } catch {
      // Device suggestions are optional for shell usage.
      this.devices = [];
      this.render();
    }
  }

  private async loadSessions(surfaceErrors: boolean): Promise<void> {
    const context = this.context;
    if (!context || this.kernelState !== "connected" || this.suspended) {
      return;
    }

    const target = normalizeTarget(this.target);
    if (target === "gsv") {
      this.sessions = [];
      this.isRefreshingSessions = false;
      this.render();
      return;
    }

    this.isRefreshingSessions = true;
    this.render();
    try {
      const payload = await context.kernel.request("shell.list", { target });
      this.sessions = normalizeSessions(payload);
      if (surfaceErrors) {
        this.setStatus("idle", "");
      }
    } catch (error) {
      this.sessions = [];
      if (surfaceErrors) {
        this.setStatus("error", error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (!this.context) {
        return;
      }
      this.isRefreshingSessions = false;
      this.render();
    }
  }

  private parseOptionalPositiveInt(raw: string): number | null {
    const trimmed = raw.trim();
    if (!trimmed) {
      return null;
    }
    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return null;
    }
    return parsed;
  }

  private async runCommand(): Promise<void> {
    const context = this.context;
    if (!context || this.kernelState !== "connected" || this.suspended || this.isExecuting) {
      return;
    }

    const command = this.command.trim();
    if (!command) {
      this.setStatus("error", "Command is required.");
      this.render();
      return;
    }
    this.rememberCommand(command);

    const normalizedTarget = normalizeTarget(this.target);
    if (
      normalizedTarget !== "gsv" &&
      !this.devices.some((device) => device.deviceId === normalizedTarget)
    ) {
      this.setStatus("error", `Unknown target: ${normalizedTarget}`);
      this.render();
      return;
    }
    const timeout = this.parseOptionalPositiveInt(this.timeout);
    const yieldMs = this.parseOptionalPositiveInt(this.yieldMs);
    const args: LooseRecord = { command };

    if (normalizedTarget !== "gsv") {
      args.target = normalizedTarget;
    }
    if (this.workdir.trim()) {
      args.workdir = this.workdir.trim();
    }
    if (timeout !== null) {
      args.timeout = timeout;
    }
    if (this.background) {
      args.background = true;
      if (yieldMs !== null) {
        args.yieldMs = yieldMs;
      }
    }

    this.isExecuting = true;
    this.setStatus("idle", "");
    this.render();

    const startedAt = Date.now();
    try {
      const payload = await context.kernel.request("shell.exec", args);
      const entry = normalizeTranscriptEntry(payload, startedAt, normalizedTarget, command);
      this.command = "";
      this.pushTranscript(entry);
      if (entry.status === "backgrounded") {
        await this.loadSessions(false);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus("error", message);
      this.pushTranscript({
        id: `${startedAt}-${Math.random().toString(36).slice(2, 8)}`,
        startedAt,
        completedAt: Date.now(),
        target: normalizedTarget,
        command,
        status: "error",
        exitCode: null,
        stdout: "",
        stderr: message,
        note: "Request failed",
        raw: { error: message },
      });
    } finally {
      if (!this.context) {
        return;
      }
      this.isExecuting = false;
      this.render();
    }
  }

  private renderTranscript(): string {
    if (this.transcript.length === 0) {
      return `<p class="config-empty muted">No commands yet. Run one to populate this terminal log.</p>`;
    }

    return this.transcript
      .map((entry) => {
        const statusClass =
          entry.status === "error" ? "is-error" : entry.status === "backgrounded" ? "is-backgrounded" : "is-ok";

        const streamNodes: string[] = [];
        if (entry.stdout.trim().length > 0) {
          streamNodes.push(`
            <pre class="shell-entry-stream is-stdout">${escapeHtml(entry.stdout)}</pre>
          `);
        }
        if (entry.stderr.trim().length > 0) {
          streamNodes.push(`
            <pre class="shell-entry-stream is-stderr">${escapeHtml(entry.stderr)}</pre>
          `);
        }

        if (streamNodes.length === 0) {
          streamNodes.push(`<p class="muted">No output.</p>`);
        }

        const details = prettyJson(entry.raw);

        return `
          <article class="shell-entry shell-entry-cli">
            <div class="shell-cli-command-row">
              <span class="shell-cli-prompt">${escapeHtml(entry.target)}$</span>
              <code class="shell-cli-command">${escapeHtml(entry.command)}</code>
            </div>
            <p class="shell-cli-meta ${statusClass}">
              ${escapeHtml(entry.status === "backgrounded" ? "backgrounded" : entry.status)}
              · ${escapeHtml(formatTimestampMs(entry.startedAt))}
              · ${escapeHtml(formatRuntimeMs(entry.completedAt - entry.startedAt))}
              ${entry.exitCode === null ? "" : ` · exit ${entry.exitCode}`}
              ${entry.note ? ` · ${escapeHtml(entry.note)}` : ""}
            </p>
            <div class="shell-entry-body">
              ${streamNodes.join("")}
              <details class="shell-entry-raw">
                <summary>Raw result</summary>
                <pre>${escapeHtml(details)}</pre>
              </details>
            </div>
          </article>
        `;
      })
      .join("");
  }

  private renderSessions(): string {
    if (normalizeTarget(this.target) === "gsv") {
      return `<p class="config-empty muted">Remote sessions appear when target is set to a connected device.</p>`;
    }

    if (this.sessions.length === 0) {
      return `<p class="config-empty muted">No active or recent remote shell sessions.</p>`;
    }

    return this.sessions
      .map((entry) => {
        const statusClass = entry.running ? "is-running" : "is-stopped";
        return `
          <article class="shell-session-row">
            <div class="shell-session-head">
              <strong>${escapeHtml(entry.id)}</strong>
              <span class="shell-session-status ${statusClass}">${escapeHtml(entry.status)}</span>
            </div>
            <p class="muted">${entry.command ? `<code>${escapeHtml(entry.command)}</code>` : "No command metadata."}</p>
            <p class="muted">
              pid ${entry.pid === null ? "—" : entry.pid}
              · started ${escapeHtml(entry.startedAt === null ? "—" : formatTimestampMs(entry.startedAt))}
              · runtime ${escapeHtml(formatRuntimeMs(entry.runtimeMs))}
            </p>
            ${entry.tail.trim()
              ? `<pre class="shell-session-tail">${escapeHtml(entry.tail)}</pre>`
              : ""}
          </article>
        `;
      })
      .join("");
  }

  private render(): void {
    const context = this.context;
    if (!context) {
      this.innerHTML = "";
      return;
    }

    const state = this.describeViewState();
    const target = normalizeTarget(this.target);
    const targetSelectValue =
      target === "gsv" || this.devices.some((device) => device.deviceId === target)
        ? target
        : "gsv";
    const canRun = this.kernelState === "connected" && !this.suspended && !this.isExecuting;
    const canRefreshSessions =
      this.kernelState === "connected" &&
      !this.suspended &&
      !this.isRefreshingSessions &&
      target !== "gsv";

    const targetOptions = [
      `<option value="gsv"${targetSelectValue === "gsv" ? " selected" : ""}>Kernel (gsv)</option>`,
      ...this.devices.map((device) => {
        const suffix = device.online ? " · online" : " · offline";
        const selected = targetSelectValue === device.deviceId ? " selected" : "";
        return `<option value="${escapeHtml(device.deviceId)}"${selected}>${escapeHtml(device.deviceId + suffix)}</option>`;
      }),
    ].join("");

    this.innerHTML = `
      <section class="app-grid shell-app">
        <header class="shell-page-header">
          <div class="shell-page-copy">
            <p class="eyebrow">Command Surface</p>
            <h1>Shell</h1>
            <p>Execute commands on the kernel or connected device targets from a single workspace.</p>
          </div>
          <div class="shell-toolbar-row">
            <span class="config-state-icon is-${escapeHtml(state.kind)}" title="${escapeHtml(state.detail)}" aria-label="${escapeHtml(state.label)}">
              <span class="config-state-dot" aria-hidden="true"></span>
            </span>
            <button
              type="button"
              class="runtime-btn config-icon-btn${this.isRefreshingSessions ? " is-busy" : ""}"
              data-action="refresh-sessions"
              title="Refresh remote sessions"
              aria-label="Refresh remote sessions"
              ${canRefreshSessions ? "" : "disabled"}
            >
              <span aria-hidden="true">↻</span>
            </button>
          </div>
        </header>

        <section class="shell-controls control-form-grid">
          <label>
            Target
            <select
              data-field="target-select"
              ${this.suspended ? "disabled" : ""}
            >
              ${targetOptions}
            </select>
          </label>
          <label>
            Working Directory
            <input
              data-field="workdir"
              type="text"
              value="${escapeHtml(this.workdir)}"
              placeholder="/root"
              ${this.suspended ? "disabled" : ""}
            />
          </label>
          <label>
            Timeout (ms)
            <input
              data-field="timeout"
              type="text"
              inputmode="numeric"
              value="${escapeHtml(this.timeout)}"
              placeholder="30000"
              ${this.suspended ? "disabled" : ""}
            />
          </label>
          <label>
            Yield (ms)
            <input
              data-field="yieldMs"
              type="text"
              inputmode="numeric"
              value="${escapeHtml(this.yieldMs)}"
              placeholder="2000"
              ${this.suspended ? "disabled" : ""}
            />
          </label>
          <label class="config-checkbox shell-checkbox">
            <input
              data-field="background"
              type="checkbox"
              ${this.background ? "checked" : ""}
              ${this.suspended ? "disabled" : ""}
            />
            Run in background
          </label>
        </section>

        <section class="shell-compose control-form-grid single">
          <label>
            Command
            <div class="shell-compose-editor">
              <span class="shell-compose-prompt">${escapeHtml(target)}$</span>
              <textarea
                data-field="command"
                placeholder="Enter command (Shift+Enter for newline)"
                ${this.suspended ? "disabled" : ""}
              >${escapeHtml(this.command)}</textarea>
            </div>
          </label>
          <div class="shell-compose-actions">
            <button type="button" class="runtime-btn" data-action="run" ${canRun ? "" : "disabled"}>
              ${this.isExecuting ? "Running..." : "Run"}
            </button>
            <button
              type="button"
              class="runtime-btn"
              data-action="clear-transcript"
              ${this.transcript.length > 0 && !this.suspended ? "" : "disabled"}
            >
              Clear Log
            </button>
          </div>
        </section>

        <section class="shell-layout">
          <div class="shell-output" data-shell-log>
            ${this.renderTranscript()}
          </div>
          <aside class="shell-sessions">
            <h2>Remote Sessions</h2>
            <p class="muted">Target <code>${escapeHtml(target)}</code></p>
            <div class="shell-session-list">
              ${this.renderSessions()}
            </div>
          </aside>
        </section>

        ${this.statusKind === "error" && this.statusText
          ? `<p class="control-error-text">${escapeHtml(this.statusText)}</p>`
          : ""}
      </section>
    `;
  }
}

export function ensureShellAppRegistered(): void {
  defineElement("gsv-shell-app", GsvShellAppElement);
}
