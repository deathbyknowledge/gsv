import { getBackend } from "@gsv/package/browser";
import { consumePendingAppOpen } from "@gsv/package/host";

type GhosttyModule = {
  init: () => Promise<void>;
  Terminal: new (options: Record<string, unknown>) => TerminalLike;
  FitAddon: new () => FitAddonLike;
};

type FitAddonLike = {
  fit: () => void;
};

type TerminalLike = {
  loadAddon: (addon: FitAddonLike) => void;
  open: (element: Element) => void;
  focus: () => void;
  write: (value: string) => void;
  reset: () => void;
  onData: (handler: (value: string) => void) => void;
};

type ShellDevice = {
  deviceId: string;
  label: string;
  online: boolean;
};

type ShellState = {
  devices: ShellDevice[];
};

type TranscriptEntry = {
  id: string;
  target: string;
  command: string;
  stdout: string;
  stderr: string;
};

type ShellBackend = {
  loadState(args: Record<string, never>): Promise<ShellState>;
  execCommand(args: {
    input: string;
    target: string;
    cwd?: string;
    timeoutMs?: string;
    yieldMs?: string;
    background?: boolean;
  }): Promise<{ entry: TranscriptEntry }>;
};

declare global {
  interface Window {
    __GSV_GHOSTTY__?: Promise<GhosttyModule>;
  }
}

const SHELL_LAYOUT = `
  <main class="shell-app">
    <section class="shell-toolbar">
      <label class="shell-field shell-field-target">
        <span>Target</span>
        <select data-shell-target></select>
      </label>
      <label class="shell-field shell-field-cwd">
        <span>Working directory</span>
        <input data-shell-cwd type="text" value="" placeholder="Optional" spellcheck="false" />
      </label>
      <button class="shell-status-indicator" data-shell-status data-kind="booting" type="button" aria-label="Shell loading" title="Shell loading" aria-live="polite">
        <span class="shell-status-dot" aria-hidden="true"></span>
        <span class="shell-status-label" data-shell-status-label>Loading</span>
      </button>
      <button class="shell-settings-toggle" data-shell-settings-toggle type="button" aria-expanded="false" aria-controls="shell-options" title="Shell options">
        <span aria-hidden="true">⚙</span>
        <span class="shell-settings-label">Options</span>
      </button>
      <div class="shell-options" id="shell-options" data-shell-options hidden>
        <label class="shell-field">
          <span>Timeout (ms)</span>
          <input data-shell-timeout type="text" inputmode="numeric" value="" placeholder="30000" />
        </label>
        <label class="shell-field">
          <span>Yield (ms)</span>
          <input data-shell-yield type="text" inputmode="numeric" value="" placeholder="2000" />
        </label>
        <label class="shell-toggle-row">
          <input data-shell-background type="checkbox" />
          <span class="shell-toggle">Run in background</span>
        </label>
      </div>
    </section>
    <section class="shell-stage">
      <div class="shell-terminal-wrap">
        <div class="shell-terminal" data-shell-terminal>
          <div class="shell-terminal-state" data-shell-boot-state>
            <div class="shell-terminal-state-title" data-shell-boot-title>Starting shell</div>
            <div class="shell-terminal-state-message" data-shell-boot-message>Loading terminal runtime...</div>
          </div>
        </div>
      </div>
    </section>
  </main>
`;

const root = document.getElementById("root");
if (root) {
  root.innerHTML = SHELL_LAYOUT;
}
if (!window.__GSV_GHOSTTY__) {
  window.__GSV_GHOSTTY__ = import("https://cdn.jsdelivr.net/npm/ghostty-web@0.4.0/+esm");
}

const streamNode = document.querySelector<HTMLElement>("[data-shell-terminal]");
const statusNode = document.querySelector<HTMLElement>("[data-shell-status]");
const statusLabelNode = document.querySelector<HTMLElement>("[data-shell-status-label]");
const targetSelect = document.querySelector<HTMLSelectElement>("[data-shell-target]");
const settingsToggle = document.querySelector<HTMLButtonElement>("[data-shell-settings-toggle]");
const optionsNode = document.querySelector<HTMLElement>("[data-shell-options]");
const bootTitleNode = document.querySelector<HTMLElement>("[data-shell-boot-title]");
const bootMessageNode = document.querySelector<HTMLElement>("[data-shell-boot-message]");
function readFrameLaunchUrl(): URL | null {
  try {
    const frame = window.frameElement;
    if (!(frame instanceof HTMLIFrameElement)) {
      return null;
    }
    const raw = frame.getAttribute("src")?.trim() || frame.src?.trim() || "";
    if (!raw) {
      return null;
    }
    return new URL(raw, window.location.origin);
  } catch {
    return null;
  }
}

function readLaunchUrl(): URL {
  const current = new URL(window.location.href);
  const frame = readFrameLaunchUrl();
  if (!frame) {
    return current;
  }

  const currentHasWindowId = current.searchParams.has("windowId");
  const currentHasExplicitState = current.searchParams.has("target") || current.searchParams.has("path") || current.searchParams.has("cwd");
  if (currentHasWindowId && currentHasExplicitState) {
    return current;
  }

  const frameHasWindowId = frame.searchParams.has("windowId");
  const frameHasExplicitState = frame.searchParams.has("target") || frame.searchParams.has("path") || frame.searchParams.has("cwd");
  if (!frameHasWindowId && !frameHasExplicitState) {
    return current;
  }

  return frame;
}

const WINDOW_ID = readLaunchUrl().searchParams.get("windowId")?.trim() || "";
const cwdInput = document.querySelector<HTMLInputElement>("[data-shell-cwd]");
const timeoutInput = document.querySelector<HTMLInputElement>("[data-shell-timeout]");
const yieldInput = document.querySelector<HTMLInputElement>("[data-shell-yield]");
const backgroundInput = document.querySelector<HTMLInputElement>("[data-shell-background]");

let terminal: TerminalLike | null = null;
let fitAddon: FitAddonLike | null = null;

let username = localStorage.getItem("gsv.ui.gateway.username") || "user";
let currentLine = "";
let history: string[] = [];
let historyCursor: number | null = null;
let historyDraft = "";
let running = false;
let pendingFit = 0;

function statusLabel(kind: string): string {
  switch (kind) {
    case "booting":
      return "Loading";
    case "working":
      return "Running";
    case "ready":
      return "Ready";
    case "error":
      return "Error";
    default:
      return kind;
  }
}

function setStatus(kind: string, title?: string, label?: string): void {
  if (!statusNode) {
    return;
  }
  const nextLabel = label ?? statusLabel(kind);
  const nextTitle = title ?? `Shell ${kind}`;
  statusNode.dataset.kind = kind;
  statusNode.title = nextTitle;
  statusNode.setAttribute("aria-label", nextTitle);
  if (statusLabelNode) {
    statusLabelNode.textContent = nextLabel;
  }
}

function setBootState(title: string, message: string): void {
  if (bootTitleNode) {
    bootTitleNode.textContent = title;
  }
  if (bootMessageNode) {
    bootMessageNode.textContent = message;
  }
}

function readActiveThreadContext(): { cwd: string; workspaceId: string } | null {
  try {
    const raw = localStorage.getItem("gsv.activeThreadContext.v1");
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { cwd?: unknown; workspaceId?: unknown } | null;
    if (!parsed || typeof parsed !== "object") return null;
    const cwd = typeof parsed.cwd === "string" ? parsed.cwd.trim() : "";
    const workspaceId = typeof parsed.workspaceId === "string" ? parsed.workspaceId.trim() : "";
    if (!cwd) return null;
    return { cwd, workspaceId };
  } catch {
    return null;
  }
}

function readRouteParams(): { target: string | null; cwd: string | null } {
  const url = readLaunchUrl();
  const routeFromUrl = {
    target: url.searchParams.get("target")?.trim() || null,
    cwd: url.searchParams.get("path")?.trim() || url.searchParams.get("cwd")?.trim() || null,
  };

  const pending = consumePendingAppOpen(WINDOW_ID);
  if (pending?.target === "shell") {
    const payload = pending.payload && typeof pending.payload === "object" ? pending.payload as Record<string, unknown> : null;
    const context = payload?.context && typeof payload.context === "object" ? payload.context as Record<string, unknown> : null;
    const target = (
      (typeof payload?.device === "string" && payload.device.trim() ? payload.device.trim() : null)
      ?? (typeof payload?.deviceId === "string" && payload.deviceId.trim() ? payload.deviceId.trim() : null)
      ?? (typeof payload?.target === "string" && payload.target.trim() ? payload.target.trim() : null)
      ?? routeFromUrl.target
    );
    const cwd = typeof payload?.cwd === "string" && payload.cwd.trim()
      ? payload.cwd.trim()
      : (typeof context?.cwd === "string" && context.cwd.trim() ? context.cwd.trim() : routeFromUrl.cwd);
    const nextRoute = { target, cwd };
    console.debug("[shell] consumed pending app open", {
      windowId: WINDOW_ID,
      pending,
      route: nextRoute,
    });
    return nextRoute;
  }

  const nextRoute = {
    target: routeFromUrl.target,
    cwd: routeFromUrl.cwd,
  };
  console.debug("[shell] using url route", {
    windowId: WINDOW_ID,
    route: nextRoute,
    href: window.location.href,
    launchHref: url.toString(),
  });
  return nextRoute;
}

function currentTarget(): string {
  return targetSelect && targetSelect.value ? targetSelect.value : "gsv";
}

function currentPath(): string {
  const value = cwdInput && cwdInput.value ? cwdInput.value.trim() : "";
  return value || "~";
}

function estimateTerminalColumns(): number {
  const width = streamNode?.clientWidth || window.innerWidth || 320;
  return Math.max(20, Math.floor(width / 8));
}

function truncateMiddle(value: string, maxLength: number): string {
  const normalized = String(value || "");
  if (normalized.length <= maxLength) {
    return normalized;
  }
  if (maxLength <= 3) {
    return normalized.slice(0, maxLength);
  }
  const leftLength = Math.ceil((maxLength - 3) / 2);
  const rightLength = Math.floor((maxLength - 3) / 2);
  return `${normalized.slice(0, leftLength)}...${normalized.slice(normalized.length - rightLength)}`;
}

function compactPath(path: string, maxLength: number): string {
  const normalized = path || "~";
  if (normalized.length <= maxLength) {
    return normalized;
  }

  const parts = normalized.split("/").filter(Boolean);
  const last = parts[parts.length - 1] || normalized;
  const parent = parts.length > 1 ? parts[parts.length - 2] : "";
  const candidates = [
    parent ? `.../${parent}/${last}` : `.../${last}`,
    `.../${last}`,
    truncateMiddle(last, Math.max(4, maxLength - 4)),
  ];
  for (const candidate of candidates) {
    if (candidate.length <= maxLength) {
      return candidate;
    }
  }
  return truncateMiddle(normalized, maxLength);
}

function promptText(): string {
  const target = currentTarget();
  const path = currentPath();
  const fullPrompt = `${username}@${target}:${path} $ `;
  const columns = estimateTerminalColumns();
  const maxPromptLength = Math.min(72, Math.max(18, Math.floor(columns * 0.44)));
  if (fullPrompt.length <= maxPromptLength) {
    return fullPrompt;
  }

  const compactUser = truncateMiddle(username, 10);
  const compactTarget = truncateMiddle(target, 14);
  const userPrefix = `${compactUser}@${compactTarget}:`;
  const userPathBudget = maxPromptLength - userPrefix.length - 3;
  if (userPathBudget >= 6) {
    return `${userPrefix}${compactPath(path, userPathBudget)} $ `;
  }

  const targetPrefix = `${compactTarget}:`;
  const targetPathBudget = maxPromptLength - targetPrefix.length - 3;
  if (targetPathBudget >= 6) {
    return `${targetPrefix}${compactPath(path, targetPathBudget)} $ `;
  }

  const pathBudget = maxPromptLength - 3;
  if (pathBudget >= 6) {
    return `${compactPath(path, pathBudget)} $ `;
  }

  return "$ ";
}

function writePrompt(): void {
  terminal?.write(promptText());
}

function syncCurrentLine(): void {
  if (!terminal) {
    return;
  }
  terminal.write("\r\x1b[2K");
  terminal.write(promptText() + currentLine);
}

function pushHistory(command: string): void {
  const trimmed = String(command || "").trim();
  if (!trimmed) return;
  if (history[history.length - 1] !== trimmed) {
    history.push(trimmed);
  }
  if (history.length > 200) {
    history = history.slice(-200);
  }
  historyCursor = null;
  historyDraft = "";
}

function navigateHistory(direction: number): void {
  if (history.length === 0) return;
  if (historyCursor === null) {
    historyDraft = currentLine;
    historyCursor = history.length;
  }
  const nextIndex = historyCursor + direction;
  if (nextIndex < 0) {
    historyCursor = 0;
  } else if (nextIndex > history.length) {
    historyCursor = history.length;
  } else {
    historyCursor = nextIndex;
  }
  currentLine = historyCursor === history.length ? historyDraft : (history[historyCursor] || "");
  syncCurrentLine();
}

function clearTerminal(): void {
  if (!terminal) {
    return;
  }
  terminal.reset();
  currentLine = "";
  writePrompt();
}

function setSelectedTarget(target: string | null | undefined): void {
  if (!targetSelect) {
    return;
  }
  const normalizedTarget = target?.trim() || "";
  const availableOption = Array.from(targetSelect.options).find((option) => option.value === normalizedTarget);
  targetSelect.value = availableOption ? normalizedTarget : "gsv";
}

function selectedTargetUnavailable(): boolean {
  if (!targetSelect) {
    return false;
  }
  return targetSelect.selectedOptions[0]?.disabled === true;
}

function renderTargetOptions(devices: ShellDevice[], requestedTarget?: string | null): void {
  if (!targetSelect) {
    return;
  }
  const options: Array<{ value: string; label: string; disabled?: boolean }> = [{ value: "gsv", label: "Kernel (gsv)" }];
  const normalizedRequestedTarget = requestedTarget?.trim() || "";
  if (normalizedRequestedTarget && normalizedRequestedTarget !== "gsv" && !devices.some((device) => device.deviceId === normalizedRequestedTarget)) {
    options.push({ value: normalizedRequestedTarget, label: `${normalizedRequestedTarget} · requested target` });
  }
  options.push(
    ...devices.map((device) => {
      const labelBase = device.label && device.label !== device.deviceId
        ? `${device.label} · ${device.deviceId}`
        : device.deviceId;
      return {
        value: device.deviceId,
        label: `${labelBase} · ${device.online ? "online" : "offline"}`,
        disabled: !device.online,
      };
    }),
  );
  targetSelect.innerHTML = options
    .map((option) => (
      `<option value="${escapeHtml(option.value)}"${option.disabled ? " disabled" : ""}>${escapeHtml(option.label)}</option>`
    ))
    .join("");
  setSelectedTarget(normalizedRequestedTarget);
}

function escapeHtml(value: string): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function runCommand(backend: ShellBackend, command: string): Promise<void> {
  const trimmed = String(command || "").trim();
  if (!trimmed || running || !terminal) {
    return;
  }

  if (selectedTargetUnavailable()) {
    const target = currentTarget();
    terminal.write("\r\n");
    terminal.write(`\x1b[38;2;255;214;153mTarget ${target} is offline. Select an online target or gsv before running commands.\x1b[0m\r\n`);
    currentLine = "";
    writePrompt();
    setStatus("error", "Shell target is offline");
    return;
  }

  pushHistory(trimmed);
  running = true;
  setStatus("working", "Shell running command");
  terminal.write("\r\n");

  try {
    const response = await backend.execCommand({
      input: trimmed,
      target: currentTarget(),
      cwd: cwdInput?.value ?? "",
      timeoutMs: timeoutInput?.value ?? "",
      yieldMs: yieldInput?.value ?? "",
      background: backgroundInput?.checked ?? false,
    });

    const entry = response.entry;
    if (entry.stdout && entry.stdout.length > 0) {
      terminal.write(entry.stdout.replaceAll("\n", "\r\n"));
      if (!entry.stdout.endsWith("\n")) {
        terminal.write("\r\n");
      }
    }
    if (entry.stderr && entry.stderr.length > 0) {
      terminal.write(`\x1b[38;2;255;182;173m${entry.stderr.replaceAll("\n", "\r\n")}\x1b[0m`);
      if (!entry.stderr.endsWith("\n")) {
        terminal.write("\r\n");
      }
    }
    setStatus("ready", "Shell ready");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    terminal.write(`\x1b[38;2;255;182;173m${message.replaceAll("\n", "\r\n")}\x1b[0m\r\n`);
    setStatus("error", "Shell command failed");
  } finally {
    running = false;
    currentLine = "";
    writePrompt();
  }
}

function scheduleFit(syncLine = false): void {
  if (pendingFit) {
    window.cancelAnimationFrame(pendingFit);
  }
  pendingFit = window.requestAnimationFrame(() => {
    pendingFit = 0;
    fitAddon?.fit();
    if (syncLine && terminal && !running) {
      syncCurrentLine();
    }
  });
}

async function boot(): Promise<void> {
  if (!root) {
    throw new Error("shell root missing");
  }
  if (!streamNode || !statusNode || !targetSelect || !settingsToggle || !optionsNode || !cwdInput || !timeoutInput || !yieldInput || !backgroundInput) {
    throw new Error("Shell UI is incomplete.");
  }

  setStatus("booting", "Loading terminal runtime", "Loading");
  setBootState("Starting shell", "Loading terminal runtime...");
  const ghostty = await window.__GSV_GHOSTTY__;
  if (!ghostty) {
    throw new Error("Terminal runtime failed to load.");
  }

  setBootState("Connecting shell", "Loading targets and launch context...");
  const route = readRouteParams();
  const backend = await getBackend<ShellBackend>();
  const state = await backend.loadState({});
  renderTargetOptions(state.devices, route.target);
  console.debug("[shell] boot state", {
    windowId: WINDOW_ID,
    route,
    devices: state.devices.map((device) => device.deviceId),
  });
  if (route.cwd) {
    cwdInput.value = route.cwd;
  } else {
    const activeThread = readActiveThreadContext();
    if (activeThread && !cwdInput.value.trim()) {
      cwdInput.value = activeThread.cwd;
    }
  }

  if (route.target) {
    setSelectedTarget(route.target);
    console.debug("[shell] applied target route", {
      requestedTarget: route.target,
      selectedTarget: targetSelect.value,
    });
  }

  setBootState("Opening terminal", "Preparing the interactive session...");
  await ghostty.init();
  terminal = new ghostty.Terminal({
    fontFamily: "JetBrains Mono, SFMono-Regular, Consolas, monospace",
    fontSize: 13,
    theme: {
      background: "#07111d",
      foreground: "#e3edf7",
      cursor: "#7fc6ff",
      black: "#07111d",
      red: "#ff9d8f",
      green: "#9dd3a8",
      yellow: "#e4d39a",
      blue: "#7fc6ff",
      magenta: "#c4a6ff",
      cyan: "#88d4ff",
      white: "#e3edf7",
      brightBlack: "#5f7388",
      brightRed: "#ffb6ad",
      brightGreen: "#b9e6c0",
      brightYellow: "#f0e1ad",
      brightBlue: "#a9dcff",
      brightMagenta: "#d7c0ff",
      brightCyan: "#b1e8ff",
      brightWhite: "#f6fbff",
    },
    cursorBlink: true,
    cursorStyle: "bar",
    convertEol: true,
  });
  fitAddon = new ghostty.FitAddon();
  terminal.loadAddon(fitAddon);
  streamNode.replaceChildren();
  terminal.open(streamNode);
  fitAddon.fit();
  terminal.focus();
  writePrompt();
  setStatus("ready", "Shell ready");

  terminal.onData((data) => {
    if (running) {
      return;
    }

    switch (data) {
      case "\r":
        void runCommand(backend, currentLine);
        return;
      case "\u007f":
        if (currentLine.length > 0) {
          currentLine = currentLine.slice(0, -1);
          terminal?.write("\b \b");
        }
        return;
      case "\u001b[A":
        navigateHistory(-1);
        return;
      case "\u001b[B":
        navigateHistory(1);
        return;
      case "\u0003":
        currentLine = "";
        terminal?.write("^C\r\n");
        writePrompt();
        return;
      case "\u000c":
        clearTerminal();
        return;
      default:
        break;
    }

    if (data === "\n") {
      return;
    }

    currentLine += data;
    terminal?.write(data);
  });

  for (const node of [targetSelect, cwdInput, timeoutInput, yieldInput, backgroundInput]) {
    node.addEventListener("change", () => {
      if (!running && currentLine.length === 0) {
        syncCurrentLine();
      }
      scheduleFit();
    });
  }

  settingsToggle.addEventListener("click", () => {
    const shouldOpen = optionsNode.hidden;
    optionsNode.hidden = !shouldOpen;
    settingsToggle.setAttribute("aria-expanded", String(shouldOpen));
    scheduleFit(true);
  });

  statusNode.addEventListener("click", () => {
    terminal?.focus();
  });

  window.addEventListener("resize", () => {
    scheduleFit(true);
  });

  if (typeof ResizeObserver !== "undefined") {
    const resizeObserver = new ResizeObserver(() => {
      scheduleFit(true);
    });
    resizeObserver.observe(streamNode);
    resizeObserver.observe(root);
  }
}

void boot().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  setStatus("error", message);
  if (streamNode) {
    streamNode.innerHTML = `<div class="shell-boot-error"><h1>Shell unavailable</h1><p>${escapeHtml(message)}</p></div>`;
  }
});
