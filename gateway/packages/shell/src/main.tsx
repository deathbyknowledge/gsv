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
    command: string;
    target: string;
    workdir?: string;
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

const streamNode = document.querySelector<HTMLElement>("[data-shell-terminal]");
const statusNode = document.querySelector<HTMLElement>("[data-shell-status]");
const targetSelect = document.querySelector<HTMLSelectElement>("[data-shell-target]");
const WINDOW_ID = new URL(window.location.href).searchParams.get("windowId")?.trim() || "";
const workdirInput = document.querySelector<HTMLInputElement>("[data-shell-workdir]");
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

function setStatus(kind: string, title?: string): void {
  if (!statusNode) {
    return;
  }
  statusNode.dataset.kind = kind;
  statusNode.title = title ?? `Shell ${kind}`;
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

function readRouteParams(): { target: string | null; workdir: string | null } {
  const url = new URL(window.location.href);
  const routeFromUrl = {
    target: url.searchParams.get("target")?.trim() || null,
    workdir: url.searchParams.get("path")?.trim() || url.searchParams.get("workdir")?.trim() || null,
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
    const workdir = typeof payload?.workdir === "string" && payload.workdir.trim()
      ? payload.workdir.trim()
      : (typeof context?.cwd === "string" && context.cwd.trim() ? context.cwd.trim() : routeFromUrl.workdir);
    const nextRoute = { target, workdir };
    console.debug("[shell] consumed pending app open", {
      windowId: WINDOW_ID,
      pending,
      route: nextRoute,
    });
    return nextRoute;
  }

  const nextRoute = {
    target: routeFromUrl.target,
    workdir: routeFromUrl.workdir,
  };
  console.debug("[shell] using url route", {
    windowId: WINDOW_ID,
    route: nextRoute,
    href: window.location.href,
  });
  return nextRoute;
}

function currentTarget(): string {
  return targetSelect && targetSelect.value ? targetSelect.value : "gsv";
}

function currentPath(): string {
  const value = workdirInput && workdirInput.value ? workdirInput.value.trim() : "";
  return value || "~";
}

function promptText(): string {
  return `${username}@${currentTarget()}:${currentPath()} $ `;
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

function renderTargetOptions(devices: ShellDevice[], requestedTarget?: string | null): void {
  if (!targetSelect) {
    return;
  }
  const options = [{ value: "gsv", label: "Kernel (gsv)" }];
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
      };
    }),
  );
  targetSelect.innerHTML = options
    .map((option) => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`)
    .join("");
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

  pushHistory(trimmed);
  running = true;
  setStatus("working", "Shell running command");
  terminal.write("\r\n");

  try {
    const response = await backend.execCommand({
      command: trimmed,
      target: currentTarget(),
      workdir: workdirInput?.value ?? "",
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

async function boot(): Promise<void> {
  if (!streamNode || !statusNode || !targetSelect || !workdirInput || !timeoutInput || !yieldInput || !backgroundInput) {
    throw new Error("Shell UI is incomplete.");
  }

  const ghostty = await window.__GSV_GHOSTTY__;
  if (!ghostty) {
    throw new Error("Terminal runtime failed to load.");
  }

  const route = readRouteParams();
  const backend = await getBackend<ShellBackend>();
  const state = await backend.loadState({});
  renderTargetOptions(state.devices, route.target);
  console.debug("[shell] boot state", {
    windowId: WINDOW_ID,
    route,
    devices: state.devices.map((device) => device.deviceId),
  });
  if (route.workdir) {
    workdirInput.value = route.workdir;
  } else {
    const activeThread = readActiveThreadContext();
    if (activeThread && !workdirInput.value.trim()) {
      workdirInput.value = activeThread.cwd;
    }
  }

  if (route.target) {
    targetSelect.value = route.target;
    console.debug("[shell] applied target route", {
      requestedTarget: route.target,
      selectedTarget: targetSelect.value,
    });
  }

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

  for (const node of [targetSelect, workdirInput, timeoutInput, yieldInput, backgroundInput]) {
    node.addEventListener("change", () => {
      if (!running && currentLine.length === 0) {
        syncCurrentLine();
      }
    });
  }

  window.addEventListener("resize", () => {
    fitAddon?.fit();
    terminal?.focus();
  });
}

void boot().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  setStatus("error", message);
  if (streamNode) {
    streamNode.innerHTML = `<div class="shell-boot-error"><h1>Shell unavailable</h1><p>${escapeHtml(message)}</p></div>`;
  }
});
