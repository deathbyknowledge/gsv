import type { AppElementContext, GsvAppElement } from "../app-sdk";
import {
  getActiveThreadContext,
  subscribeActiveThreadContext,
  type ThreadContext,
} from "../thread-context";

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

type ShellTranscriptEntry = {
  id: string;
  target: string;
  command: string;
  stdout: string;
  stderr: string;
};

type LooseRecord = Record<string, unknown>;

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

function normalizeTranscriptEntry(
  payload: unknown,
  requestStartedAt: number,
  target: string,
  command: string,
): ShellTranscriptEntry {
  const completedAt = Date.now();
  const record = asRecord(payload);
  const defaultEntry: ShellTranscriptEntry = {
    id: `${requestStartedAt}-${completedAt}`,
    target,
    command,
    stdout: "",
    stderr: "",
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

  defaultEntry.stdout = stdout;
  defaultEntry.stderr = stderr;

  const backgrounded =
    asBoolean(record.backgrounded) === true ||
    (statusText === "running" && asString(record.sessionId) !== null);

  if (backgrounded) {
    defaultEntry.stdout = "";
    defaultEntry.stderr = "";
    return defaultEntry;
  }

  if (explicitOk === false || statusText === "failed" || errorText) {
    defaultEntry.stderr = errorText ?? defaultEntry.stderr;
    return defaultEntry;
  }

  if (exitCode !== null && exitCode !== 0) {
    if (defaultEntry.stderr.trim().length === 0) {
      defaultEntry.stderr = `exit ${exitCode}`;
    }
    return defaultEntry;
  }
  return defaultEntry;
}

class GsvShellAppElement extends HTMLElement implements GsvAppElement {
  private context: AppElementContext | null = null;
  private kernelState: "disconnected" | "connecting" | "connected" = "disconnected";
  private suspended = false;
  private isExecuting = false;
  private isRefreshingDevices = false;
  private statusKind: ShellStatusKind = "idle";
  private statusText = "";

  private target = "gsv";
  private command = "";
  private workdir = "";
  private timeout = "";
  private yieldMs = "";
  private background = false;

  private devices: DeviceSummary[] = [];
  private transcript: ShellTranscriptEntry[] = [];
  private commandHistory: string[] = [];
  private historyCursor: number | null = null;
  private historyDraft = "";

  private unsubscribeStatus: (() => void) | null = null;
  private unsubscribeThreadContext: (() => void) | null = null;
  private activeThreadContext: ThreadContext | null = getActiveThreadContext();

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

    if (action === "clear-transcript") {
      this.transcript = [];
      this.render();
      return;
    }
    if (action === "refresh-sessions") {
      void this.loadDeviceSuggestions();
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
          this.workdir = this.preferredGsvWorkdir(this.activeThreadContext);
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
    if (!(target instanceof HTMLTextAreaElement) && !(target instanceof HTMLInputElement)) {
      return;
    }
    if (target.dataset.field !== "command") {
      return;
    }

    const selectionStart = target.selectionStart ?? target.value.length;
    const selectionEnd = target.selectionEnd ?? target.value.length;

    if (
      !event.shiftKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      event.key === "ArrowUp" &&
      selectionStart === 0 &&
      selectionEnd === 0
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
      selectionStart === target.value.length &&
      selectionEnd === target.value.length
    ) {
      event.preventDefault();
      this.navigateHistory(1, target);
      return;
    }

    if (event.key !== "Enter" || event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }
    if (target instanceof HTMLTextAreaElement && event.shiftKey) {
      return;
    }

    event.preventDefault();
    void this.runCommand();
  };

  async gsvMount(context: AppElementContext): Promise<void> {
    this.context = context;
    this.kernelState = context.kernel.getStatus().state;
    this.suspended = false;
    this.applyThreadContext(this.activeThreadContext);

    this.unsubscribeStatus?.();
    this.unsubscribeStatus = context.kernel.onStatus((status) => {
      const prev = this.kernelState;
      this.kernelState = status.state;
      if (prev !== "connected" && status.state === "connected" && !this.suspended) {
        void this.loadDeviceSuggestions();
      }
      this.render();
    });

    this.addEventListener("click", this.onClick);
    this.addEventListener("input", this.onInput);
    this.addEventListener("keydown", this.onKeyDown);
    this.unsubscribeThreadContext?.();
    this.unsubscribeThreadContext = subscribeActiveThreadContext((threadContext) => {
      this.applyThreadContext(threadContext);
    });

    this.render();
    window.requestAnimationFrame(() => {
      this.focusCommandInput();
    });
    if (this.kernelState === "connected") {
      await this.loadDeviceSuggestions();
      window.requestAnimationFrame(() => {
        this.focusCommandInput();
      });
    }
  }

  async gsvSuspend(): Promise<void> {
    this.suspended = true;
    this.render();
  }

  async gsvResume(): Promise<void> {
    this.suspended = false;
    if (this.kernelState === "connected") {
      await this.loadDeviceSuggestions();
      window.requestAnimationFrame(() => {
        this.focusCommandInput();
      });
    }
    this.render();
  }

  async gsvOnSignal(signal: string): Promise<void> {
    if (signal !== "device.status") {
      return;
    }
    if (this.suspended || this.kernelState !== "connected") {
      return;
    }
    await this.loadDeviceSuggestions();
  }

  async gsvUnmount(): Promise<void> {
    this.removeEventListener("click", this.onClick);
    this.removeEventListener("input", this.onInput);
    this.removeEventListener("keydown", this.onKeyDown);
    this.unsubscribeStatus?.();
    this.unsubscribeStatus = null;
    this.unsubscribeThreadContext?.();
    this.unsubscribeThreadContext = null;

    this.context = null;
    this.devices = [];
    this.transcript = [];
    this.kernelState = "disconnected";
    this.suspended = false;
    this.isExecuting = false;
    this.isRefreshingDevices = false;
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

  private preferredGsvWorkdir(threadContext: ThreadContext | null): string {
    return threadContext?.cwd ?? "";
  }

  private applyThreadContext(threadContext: ThreadContext | null): void {
    this.activeThreadContext = threadContext;
    if (normalizeTarget(this.target) !== "gsv") {
      return;
    }

    this.workdir = this.preferredGsvWorkdir(threadContext);
    this.render();
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

    if (this.isExecuting || this.isRefreshingDevices) {
      return {
        kind: "working",
        label: this.isExecuting ? "running" : "refreshing",
        detail: this.isExecuting ? "Executing command." : "Refreshing target list.",
      };
    }

    return {
      kind: "ready",
      label: "ready",
      detail: "Shell is ready.",
    };
  }

  private isNearBottom(): boolean {
    const node = this.querySelector<HTMLElement>("[data-shell-stream]");
    if (!node) {
      return true;
    }
    const remaining = node.scrollHeight - node.scrollTop - node.clientHeight;
    return remaining < 96;
  }

  private scrollToBottom(): void {
    const node = this.querySelector<HTMLElement>("[data-shell-stream]");
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

  private navigateHistory(
    direction: -1 | 1,
    inputNode: HTMLTextAreaElement | HTMLInputElement,
  ): void {
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

    inputNode.value = this.command;
    const cursor = this.command.length;
    inputNode.setSelectionRange(cursor, cursor);
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

  private focusCommandInput(): void {
    const input = this.querySelector<HTMLInputElement>("[data-field='command']");
    if (!input || input.disabled) {
      return;
    }
    input.focus();
    const cursor = input.value.length;
    input.setSelectionRange(cursor, cursor);
  }

  private async loadDeviceSuggestions(): Promise<void> {
    const context = this.context;
    if (!context || this.kernelState !== "connected" || this.suspended) {
      return;
    }

    this.isRefreshingDevices = true;
    this.render();
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
      }
      this.render();
    } catch {
      // Device suggestions are optional for shell usage.
      this.devices = [];
    } finally {
      if (!this.context) {
        return;
      }
      this.isRefreshingDevices = false;
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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus("error", message);
      this.pushTranscript({
        id: `${startedAt}-${Math.random().toString(36).slice(2, 8)}`,
        target: normalizedTarget,
        command,
        stdout: "",
        stderr: message,
      });
    } finally {
      if (!this.context) {
        return;
      }
      this.isExecuting = false;
      this.render();
      window.requestAnimationFrame(() => {
        this.focusCommandInput();
      });
    }
  }

  private renderTranscript(): string {
    if (this.transcript.length === 0) {
      return `<p class="shell-empty muted">No commands yet. Type one below and press Enter.</p>`;
    }

    return this.transcript
      .map((entry) => {
        const streamNodes: string[] = [];
        if (entry.stdout.trim().length > 0) {
          streamNodes.push(`
            <pre class="shell-log-stream is-stdout">${escapeHtml(entry.stdout)}</pre>
          `);
        }
        if (entry.stderr.trim().length > 0) {
          streamNodes.push(`
            <pre class="shell-log-stream is-stderr">${escapeHtml(entry.stderr)}</pre>
          `);
        }

        return `
          <article class="shell-log-entry">
            <div class="shell-log-command-row">
              <span class="shell-log-prompt">${escapeHtml(entry.target)}$</span>
              <code class="shell-log-command">${escapeHtml(entry.command)}</code>
            </div>
            ${streamNodes.join("")}
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
    const canCompose = this.kernelState === "connected" && !this.suspended && !this.isExecuting;
    const canRefreshSessions =
      this.kernelState === "connected" && !this.suspended && !this.isRefreshingDevices;
    const canClearLog = this.transcript.length > 0 && !this.suspended;

    const targetOptions = [
      `<option value="gsv"${targetSelectValue === "gsv" ? " selected" : ""}>Kernel (gsv)</option>`,
      ...this.devices.map((device) => {
        const suffix = device.online ? " · online" : " · offline";
        const selected = targetSelectValue === device.deviceId ? " selected" : "";
        return `<option value="${escapeHtml(device.deviceId)}"${selected}>${escapeHtml(device.deviceId + suffix)}</option>`;
      }),
    ].join("");

    this.innerHTML = `
      <section class="app-grid shell-app shell-terminal-app">
        <header class="shell-terminal-header">
          <div class="shell-terminal-header-main">
            <span class="config-state-icon is-${escapeHtml(state.kind)}" title="${escapeHtml(state.detail)}" aria-label="${escapeHtml(state.label)}">
              <span class="config-state-dot" aria-hidden="true"></span>
            </span>
            <label class="shell-target-inline">
              <span>Target</span>
              <select
                class="shell-target-select"
                data-field="target-select"
                ${this.suspended ? "disabled" : ""}
              >
                ${targetOptions}
              </select>
            </label>
            <span class="shell-state-text muted">${escapeHtml(state.label)}</span>
          </div>
          <div class="shell-terminal-header-actions">
            <button
              type="button"
              class="runtime-btn config-icon-btn${this.isRefreshingDevices ? " is-busy" : ""}"
              data-action="refresh-sessions"
              title="Refresh targets and sessions"
              aria-label="Refresh targets and sessions"
              ${canRefreshSessions ? "" : "disabled"}
            >
              <span aria-hidden="true">↻</span>
            </button>
            <button
              type="button"
              class="runtime-btn config-icon-btn"
              data-action="clear-transcript"
              title="Clear terminal log"
              aria-label="Clear terminal log"
              ${canClearLog ? "" : "disabled"}
            >
              <span aria-hidden="true">⌫</span>
            </button>
          </div>
        </header>

        <section class="shell-terminal-output" data-shell-log>
          <div class="shell-terminal-stream" data-shell-stream>
            ${this.renderTranscript()}
          </div>
          <div class="shell-terminal-compose-row">
            <span class="shell-terminal-compose-prompt">${escapeHtml(target)}$</span>
            <input
              data-field="command"
              type="text"
              value="${escapeHtml(this.command)}"
              placeholder="Type command and press Enter"
              autocomplete="off"
              spellcheck="false"
              ${canCompose ? "" : "disabled"}
            />
          </div>
        </section>

        <details class="shell-drawer shell-options-drawer">
          <summary>Options</summary>
          <div class="shell-drawer-body control-form-grid">
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
          </div>
        </details>

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
