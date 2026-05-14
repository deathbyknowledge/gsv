export type ShellElements = {
  root: HTMLElement;
  terminalNode: HTMLElement;
  statusNode: HTMLElement;
  statusLabelNode: HTMLElement | null;
  targetSelect: HTMLSelectElement;
  settingsToggle: HTMLButtonElement;
  optionsNode: HTMLElement;
  bootTitleNode: HTMLElement | null;
  bootMessageNode: HTMLElement | null;
  cwdInput: HTMLInputElement;
  timeoutInput: HTMLInputElement;
  yieldInput: HTMLInputElement;
  backgroundInput: HTMLInputElement;
};

const SHELL_LAYOUT = `
  <main class="shell-app">
    <section class="shell-toolbar">
      <label class="shell-field shell-field-target">
        <span class="shell-field-label">Target</span>
        <select data-shell-target aria-label="Target"></select>
      </label>
      <label class="shell-field shell-field-cwd">
        <span class="shell-field-label">Working directory</span>
        <input data-shell-cwd type="text" value="" placeholder="Optional" spellcheck="false" aria-label="Working directory" />
      </label>
      <button class="shell-status-indicator" data-shell-status data-kind="booting" type="button" aria-label="Shell loading" title="Shell loading" aria-live="polite">
        <span class="shell-status-dot" aria-hidden="true"></span>
        <span class="shell-status-label" data-shell-status-label>Loading</span>
      </button>
      <button class="shell-settings-toggle" data-shell-settings-toggle type="button" aria-expanded="false" aria-controls="shell-options" title="Shell options">
        <span class="shell-settings-icon" aria-hidden="true">⚙</span>
        <span class="shell-settings-label">Options</span>
      </button>
      <div class="shell-options" id="shell-options" data-shell-options role="group" aria-label="Shell run options" hidden>
        <label class="shell-field">
          <span class="shell-field-label">Timeout (ms)</span>
          <input data-shell-timeout type="text" inputmode="numeric" value="" placeholder="30000" aria-label="Timeout in milliseconds" />
        </label>
        <label class="shell-field">
          <span class="shell-field-label">Yield (ms)</span>
          <input data-shell-yield type="text" inputmode="numeric" value="" placeholder="2000" aria-label="Yield in milliseconds" />
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

export function mountShellLayout(): ShellElements {
  const root = document.getElementById("root");
  if (!root) {
    throw new Error("shell root missing");
  }

  root.innerHTML = SHELL_LAYOUT;

  const terminalNode = document.querySelector<HTMLElement>("[data-shell-terminal]");
  const statusNode = document.querySelector<HTMLElement>("[data-shell-status]");
  const targetSelect = document.querySelector<HTMLSelectElement>("[data-shell-target]");
  const settingsToggle = document.querySelector<HTMLButtonElement>("[data-shell-settings-toggle]");
  const optionsNode = document.querySelector<HTMLElement>("[data-shell-options]");
  const cwdInput = document.querySelector<HTMLInputElement>("[data-shell-cwd]");
  const timeoutInput = document.querySelector<HTMLInputElement>("[data-shell-timeout]");
  const yieldInput = document.querySelector<HTMLInputElement>("[data-shell-yield]");
  const backgroundInput = document.querySelector<HTMLInputElement>("[data-shell-background]");

  if (!terminalNode || !statusNode || !targetSelect || !settingsToggle || !optionsNode || !cwdInput || !timeoutInput || !yieldInput || !backgroundInput) {
    throw new Error("Shell UI is incomplete.");
  }

  return {
    root,
    terminalNode,
    statusNode,
    statusLabelNode: document.querySelector<HTMLElement>("[data-shell-status-label]"),
    targetSelect,
    settingsToggle,
    optionsNode,
    bootTitleNode: document.querySelector<HTMLElement>("[data-shell-boot-title]"),
    bootMessageNode: document.querySelector<HTMLElement>("[data-shell-boot-message]"),
    cwdInput,
    timeoutInput,
    yieldInput,
    backgroundInput,
  };
}

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

export function setStatus(elements: ShellElements, kind: string, title?: string, label?: string): void {
  const nextLabel = label ?? statusLabel(kind);
  const nextTitle = title ?? `Shell ${kind}`;
  elements.statusNode.dataset.kind = kind;
  elements.statusNode.title = nextTitle;
  elements.statusNode.setAttribute("aria-label", nextTitle);
  if (elements.statusLabelNode) {
    elements.statusLabelNode.textContent = nextLabel;
  }
}

export function setBootState(elements: ShellElements, title: string, message: string): void {
  if (elements.bootTitleNode) {
    elements.bootTitleNode.textContent = title;
  }
  if (elements.bootMessageNode) {
    elements.bootMessageNode.textContent = message;
  }
}

export function escapeHtml(value: string): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function showBootError(elements: ShellElements | null, message: string): void {
  if (!elements) {
    return;
  }
  setStatus(elements, "error", message);
  elements.terminalNode.innerHTML = `<div class="shell-boot-error"><h1>Shell unavailable</h1><p>${escapeHtml(message)}</p></div>`;
}
