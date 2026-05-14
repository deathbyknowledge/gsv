import type { FitAddonLike, ShellBackend, TerminalLike, TerminalOptions } from "./types";
import type { ShellElements } from "./layout";
import { setStatus } from "./layout";
import { createCommandHistory } from "./history";
import { currentTarget, selectedTargetUnavailable } from "./targets";

export type TerminalFactory = {
  Terminal: new (options?: TerminalOptions) => TerminalLike;
  FitAddon: new () => FitAddonLike;
};

export type ShellTerminalController = {
  terminal: TerminalLike;
  fitAddon: FitAddonLike;
  scheduleFit: (syncLine?: boolean) => void;
};

export function createShellTerminalController(
  elements: ShellElements,
  terminalFactory: TerminalFactory,
  backend: ShellBackend,
): ShellTerminalController {
  const terminal = new terminalFactory.Terminal({
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
  const fitAddon = new terminalFactory.FitAddon();
  const history = createCommandHistory();
  const username = localStorage.getItem("gsv.ui.gateway.username") || "user";
  let currentLine = "";
  let running = false;
  let pendingFit = 0;

  function syncAppViewportHeight(): void {
    const viewportHeight = window.visualViewport?.height ?? window.innerHeight ?? document.documentElement.clientHeight;
    if (Number.isFinite(viewportHeight) && viewportHeight > 0) {
      elements.root.style.setProperty("--shell-app-height", `${Math.floor(viewportHeight)}px`);
    }
  }

  function currentPath(): string {
    const value = elements.cwdInput.value ? elements.cwdInput.value.trim() : "";
    return value || "~";
  }

  function estimateTerminalColumns(): number {
    const width = elements.terminalNode.clientWidth || window.innerWidth || 320;
    return Math.max(20, Math.floor(width / 8));
  }

  function promptText(): string {
    const target = currentTarget(elements.targetSelect);
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
    terminal.write(promptText());
  }

  function syncCurrentLine(): void {
    terminal.write("\r\x1b[2K");
    terminal.write(promptText() + currentLine);
  }

  function clearTerminal(): void {
    terminal.reset();
    currentLine = "";
    writePrompt();
  }

  async function runCommand(command: string): Promise<void> {
    const trimmed = String(command || "").trim();
    if (!trimmed || running) {
      return;
    }

    if (selectedTargetUnavailable(elements.targetSelect)) {
      const target = currentTarget(elements.targetSelect);
      terminal.write("\r\n");
      terminal.write(`\x1b[38;2;255;214;153mTarget ${target} is offline. Select an online target or gsv before running commands.\x1b[0m\r\n`);
      currentLine = "";
      writePrompt();
      setStatus(elements, "error", "Shell target is offline");
      return;
    }

    history.push(trimmed);
    running = true;
    setStatus(elements, "working", "Shell running command");
    terminal.write("\r\n");

    try {
      const response = await backend.execCommand({
        input: trimmed,
        target: currentTarget(elements.targetSelect),
        cwd: elements.cwdInput.value ?? "",
        timeoutMs: elements.timeoutInput.value ?? "",
        yieldMs: elements.yieldInput.value ?? "",
        background: elements.backgroundInput.checked ?? false,
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
      setStatus(elements, "ready", "Shell ready");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      terminal.write(`\x1b[38;2;255;182;173m${message.replaceAll("\n", "\r\n")}\x1b[0m\r\n`);
      setStatus(elements, "error", "Shell command failed");
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
      fitAddon.fit();
      if (syncLine && !running) {
        syncCurrentLine();
      }
    });
  }

  function syncViewportAndFit(syncLine = true): void {
    syncAppViewportHeight();
    scheduleFit(syncLine);
  }

  syncAppViewportHeight();
  terminal.loadAddon(fitAddon);
  elements.terminalNode.replaceChildren();
  terminal.open(elements.terminalNode);
  fitAddon.fit();
  terminal.focus();
  writePrompt();

  terminal.onData((data) => {
    if (running) {
      return;
    }

    switch (data) {
      case "\r":
        void runCommand(currentLine);
        return;
      case "\u007f":
        if (currentLine.length > 0) {
          currentLine = currentLine.slice(0, -1);
          terminal.write("\b \b");
        }
        return;
      case "\u001b[A":
        currentLine = history.navigate(-1, currentLine);
        syncCurrentLine();
        return;
      case "\u001b[B":
        currentLine = history.navigate(1, currentLine);
        syncCurrentLine();
        return;
      case "\u0003":
        currentLine = "";
        terminal.write("^C\r\n");
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
    terminal.write(data);
  });

  for (const node of [elements.targetSelect, elements.cwdInput, elements.timeoutInput, elements.yieldInput, elements.backgroundInput]) {
    node.addEventListener("change", () => {
      if (!running && currentLine.length === 0) {
        syncCurrentLine();
      }
      scheduleFit();
    });
  }

  elements.settingsToggle.addEventListener("click", () => {
    const shouldOpen = elements.optionsNode.hidden;
    elements.optionsNode.hidden = !shouldOpen;
    elements.settingsToggle.setAttribute("aria-expanded", String(shouldOpen));
    scheduleFit(true);
  });

  elements.statusNode.addEventListener("click", () => {
    terminal.focus();
  });

  window.addEventListener("resize", () => {
    syncViewportAndFit(true);
  });

  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", () => {
      syncViewportAndFit(true);
    });
    window.visualViewport.addEventListener("scroll", () => {
      syncViewportAndFit(true);
    });
  }

  if (typeof ResizeObserver !== "undefined") {
    const resizeObserver = new ResizeObserver(() => {
      scheduleFit(true);
    });
    resizeObserver.observe(elements.terminalNode);
    resizeObserver.observe(elements.root);
  }

  return { terminal, fitAddon, scheduleFit };
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
