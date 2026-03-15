import type { AppElementContext, GsvAppElement } from "./app-sdk";

type AppCopy = {
  eyebrow: string;
  intro: string;
  cards: readonly {
    title: string;
    body: string;
  }[];
};

type ConfigEntry = {
  key: string;
  value: string;
};

const APP_COPY: Record<string, AppCopy> = {
  shell: {
    eyebrow: "Command Surface",
    intro: "Device-oriented shell execution with target routing and process-level identity.",
    cards: [
      {
        title: "Sessions",
        body: "Foreground/background command streams with signal forwarding.",
      },
      {
        title: "Targets",
        body: "Direct execution on connected devices through kernel dispatch.",
      },
      {
        title: "History",
        body: "Command logs with durable archiving and replay controls.",
      },
    ],
  },
  files: {
    eyebrow: "Workspace Surface",
    intro: "Virtual filesystem browser across /sys, /proc, /dev, and user workspaces.",
    cards: [
      {
        title: "Explorer",
        body: "Path navigation with mode bits and owner/group metadata.",
      },
      {
        title: "Editor",
        body: "Inline read/write/edit flows backed by kernel fs syscalls.",
      },
      {
        title: "Search",
        body: "Fast query over workspace files with mount-aware filtering.",
      },
    ],
  },
  sdk: {
    eyebrow: "SDK Example",
    intro: "Reference Web Component app implementing lifecycle, scoped kernel access, and shared theme tokens.",
    cards: [
      {
        title: "Lifecycle",
        body: "Uses gsvMount/gsvSuspend/gsvResume/gsvUnmount hooks.",
      },
      {
        title: "Kernel",
        body: "Receives a client limited to manifest syscalls.",
      },
      {
        title: "Theme",
        body: "Reads live OS theme tokens through the app SDK.",
      },
    ],
  },
};

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function resolveCopy(appId: string, fallbackDescription: string): AppCopy {
  return (
    APP_COPY[appId] ?? {
      eyebrow: "Application Surface",
      intro: fallbackDescription,
      cards: [
        {
          title: "Runtime",
          body: "SDK-managed application lifecycle.",
        },
      ],
    }
  );
}

function defineElement(tagName: string, constructor: CustomElementConstructor): void {
  if (!customElements.get(tagName)) {
    customElements.define(tagName, constructor);
  }
}

function compactPreview(value: string, maxLength = 120): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.slice(0, maxLength)}...`;
}

class GsvSurfaceElement extends HTMLElement implements GsvAppElement {
  private context: AppElementContext | null = null;
  private copyKey: string;
  private runtimeState: "running" | "suspended" = "running";
  private elapsedMs = 0;
  private startedAtMs: number | null = null;
  private tickerId: number | null = null;
  private unsubscribeStatus: (() => void) | null = null;
  private unsubscribeTheme: (() => void) | null = null;
  private kernelState = "offline";
  private themeLabel = "unknown";

  constructor(copyKey: string) {
    super();
    this.copyKey = copyKey;
  }

  async gsvMount(context: AppElementContext): Promise<void> {
    this.context = context;
    this.runtimeState = "running";
    this.elapsedMs = 0;
    this.startedAtMs = Date.now();
    this.kernelState = context.kernel.isConnected() ? "connected" : "disconnected";

    this.unsubscribeStatus = context.kernel.onStatus((status) => {
      this.kernelState = status.state;
      this.render();
    });

    this.unsubscribeTheme = context.theme.subscribe((snapshot) => {
      this.themeLabel = snapshot.themeId ?? "unknown";
      this.render();
    });

    this.startTicker();
    this.render();
  }

  async gsvSuspend(): Promise<void> {
    this.runtimeState = "suspended";
    this.stopTicker();
    this.render();
  }

  async gsvResume(): Promise<void> {
    this.runtimeState = "running";
    this.startTicker();
    this.render();
  }

  async gsvUnmount(): Promise<void> {
    this.stopTicker();
    this.unsubscribeStatus?.();
    this.unsubscribeStatus = null;
    this.unsubscribeTheme?.();
    this.unsubscribeTheme = null;
    this.context = null;
  }

  private startTicker(): void {
    if (this.tickerId !== null) {
      return;
    }

    this.startedAtMs = Date.now();
    this.tickerId = window.setInterval(() => {
      this.renderUptimeOnly();
    }, 1_000);
  }

  private stopTicker(): void {
    if (this.tickerId !== null) {
      window.clearInterval(this.tickerId);
      this.tickerId = null;
    }

    if (this.startedAtMs !== null) {
      this.elapsedMs += Date.now() - this.startedAtMs;
      this.startedAtMs = null;
    }
  }

  private getUptimeMs(): number {
    if (this.startedAtMs === null) {
      return this.elapsedMs;
    }
    return this.elapsedMs + (Date.now() - this.startedAtMs);
  }

  private renderUptimeOnly(): void {
    const node = this.querySelector<HTMLElement>("[data-runtime-uptime]");
    if (!node) {
      return;
    }
    node.textContent = `uptime ${formatDuration(this.getUptimeMs())}`;
  }

  private render(): void {
    const context = this.context;
    if (!context) {
      this.innerHTML = "";
      return;
    }

    const copy = resolveCopy(this.copyKey, context.manifest.description);
    const cardsMarkup = copy.cards
      .map((card) => `<article><h2>${escapeHtml(card.title)}</h2><p>${escapeHtml(card.body)}</p></article>`)
      .join("");
    const permissionTags = context.manifest.permissions
      .map((permission) => `<span class="app-tag">${escapeHtml(permission)}</span>`)
      .join("");

    const syscallTags = context.kernel.allowedSyscalls
      .map((syscall) => `<span class="app-tag">${escapeHtml(syscall)}</span>`)
      .join("");

    this.innerHTML = `
      <section class="app-grid">
        <p class="eyebrow">${escapeHtml(copy.eyebrow)}</p>
        <h1>${escapeHtml(context.manifest.name)}</h1>
        <p>${escapeHtml(copy.intro)}</p>
        <div class="app-tag-row">
          <span class="app-tag">${this.runtimeState}</span>
          <span class="app-tag" data-runtime-uptime>uptime ${formatDuration(this.getUptimeMs())}</span>
          <span class="app-tag">kernel ${escapeHtml(this.kernelState)}</span>
          <span class="app-tag">theme ${escapeHtml(this.themeLabel)}</span>
          ${permissionTags}
        </div>
        <div class="app-tag-row">
          ${syscallTags}
        </div>
        <div class="mock-grid">${cardsMarkup}</div>
      </section>
    `;
  }
}

class GsvShellAppElement extends GsvSurfaceElement {
  constructor() {
    super("shell");
  }
}

class GsvFilesAppElement extends GsvSurfaceElement {
  constructor() {
    super("files");
  }
}

type ConfigFieldKind = "text" | "number" | "password" | "textarea" | "boolean" | "select";

type ConfigField = {
  key: string;
  label: string;
  description: string;
  kind: ConfigFieldKind;
  placeholder?: string;
  defaultValue?: string;
  options?: readonly { value: string; label: string }[];
};

type ConfigSection = {
  id: string;
  title: string;
  description: string;
  fields: readonly ConfigField[];
};

const CONTROL_CONFIG_SECTIONS: readonly ConfigSection[] = [
  {
    id: "ai",
    title: "AI",
    description: "Model provider and behavior used by processes when they run agent loops.",
    fields: [
      {
        key: "config/ai/provider",
        label: "Provider",
        description: "Model provider name.",
        kind: "text",
        placeholder: "openrouter",
      },
      {
        key: "config/ai/model",
        label: "Model",
        description: "Model identifier.",
        kind: "text",
        placeholder: "qwen/qwen3.5-35b-a3b",
      },
      {
        key: "config/ai/api_key",
        label: "API Key",
        description: "Credential used for provider requests.",
        kind: "password",
      },
      {
        key: "config/ai/reasoning",
        label: "Reasoning",
        description: "Reasoning level for model calls.",
        kind: "select",
        options: [
          { value: "off", label: "Off" },
          { value: "low", label: "Low" },
          { value: "medium", label: "Medium" },
          { value: "high", label: "High" },
        ],
      },
      {
        key: "config/ai/max_tokens",
        label: "Max Tokens",
        description: "Maximum output tokens per completion.",
        kind: "number",
      },
      {
        key: "config/ai/max_context_bytes",
        label: "Max Context Bytes",
        description: "Context byte budget before truncation.",
        kind: "number",
      },
      {
        key: "config/ai/system_prompt",
        label: "System Prompt",
        description: "Base prompt injected into each process run.",
        kind: "textarea",
      },
    ],
  },
  {
    id: "shell",
    title: "Shell",
    description: "Execution limits and command runtime behavior for shell operations.",
    fields: [
      {
        key: "config/shell/timeout_ms",
        label: "Timeout (ms)",
        description: "Maximum shell execution time.",
        kind: "number",
      },
      {
        key: "config/shell/max_output_bytes",
        label: "Max Output Bytes",
        description: "Maximum combined stdout/stderr bytes.",
        kind: "number",
      },
      {
        key: "config/shell/network_enabled",
        label: "Network Enabled",
        description: "Allow network access in shell commands.",
        kind: "boolean",
      },
    ],
  },
  {
    id: "server",
    title: "Server",
    description: "Server identity and metadata presented to clients.",
    fields: [
      {
        key: "config/server/name",
        label: "Server Name",
        description: "Human-friendly instance name.",
        kind: "text",
        defaultValue: "gsv",
      },
      {
        key: "config/server/version",
        label: "Server Version",
        description: "Version label shown to clients.",
        kind: "text",
      },
    ],
  },
  {
    id: "auth",
    title: "Authentication",
    description: "Core auth behavior for machine and user entry points.",
    fields: [
      {
        key: "config/auth/allow_machine_password",
        label: "Allow Machine Password",
        description: "Allow machine role logins with password credentials.",
        kind: "boolean",
      },
    ],
  },
] as const;

const SECTION_BY_ID = new Map(CONTROL_CONFIG_SECTIONS.map((section) => [section.id, section]));

function defaultFieldValue(field: ConfigField): string {
  if (field.defaultValue !== undefined) {
    return field.defaultValue;
  }
  if (field.kind === "boolean") {
    return "false";
  }
  if (field.kind === "select") {
    return field.options?.[0]?.value ?? "";
  }
  return "";
}

class GsvControlAppElement extends HTMLElement implements GsvAppElement {
  private context: AppElementContext | null = null;
  private allEntries: ConfigEntry[] = [];
  private rawEntries: ConfigEntry[] = [];
  private values = new Map<string, string>();
  private drafts = new Map<string, string>();
  private rawQuery = "";
  private rawKey = "";
  private rawValue = "";
  private showAdvanced = false;
  private kernelState = "disconnected";
  private isLoading = false;
  private isSaving = false;
  private savingSectionId: string | null = null;
  private suspended = false;
  private statusKind: "idle" | "ok" | "error" = "idle";
  private statusText = "";
  private requestVersion = 0;
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

    if (action === "refresh-config") {
      void this.loadConfig();
      return;
    }

    if (action === "toggle-advanced") {
      this.showAdvanced = !this.showAdvanced;
      this.render();
      return;
    }

    if (action === "save-section") {
      const sectionId = actionNode.dataset.sectionId ?? "";
      void this.saveSection(sectionId);
      return;
    }

    if (action === "reset-section") {
      const sectionId = actionNode.dataset.sectionId ?? "";
      this.resetSection(sectionId);
      return;
    }

    if (action === "raw-select-entry") {
      const index = Number(actionNode.dataset.index ?? "-1");
      if (!Number.isFinite(index) || index < 0 || index >= this.rawEntries.length) {
        return;
      }
      const entry = this.rawEntries[index];
      this.rawKey = entry.key;
      this.rawValue = entry.value;
      this.showAdvanced = true;
      this.render();
      return;
    }

    if (action === "raw-save") {
      void this.saveRawEntry();
      return;
    }

    if (action === "raw-clear") {
      this.rawKey = "";
      this.rawValue = "";
      this.render();
    }
  };

  private readonly onChange = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement)) {
      return;
    }

    const fieldKey = target.dataset.configFieldKey;
    if (fieldKey) {
      if (target instanceof HTMLInputElement && target.type === "checkbox") {
        this.drafts.set(fieldKey, target.checked ? "true" : "false");
      } else {
        this.drafts.set(fieldKey, target.value);
      }
      this.render();
      return;
    }

    const rawField = target.dataset.rawField;
    if (!rawField) {
      return;
    }
    if (rawField === "query") {
      this.rawQuery = target.value;
      this.render();
      return;
    }
    if (rawField === "key") {
      this.rawKey = target.value;
      return;
    }
    if (rawField === "value") {
      this.rawValue = target.value;
    }
  };

  async gsvMount(context: AppElementContext): Promise<void> {
    this.context = context;
    this.suspended = false;
    this.kernelState = context.kernel.getStatus().state;

    this.unsubscribeStatus?.();
    this.unsubscribeStatus = context.kernel.onStatus((status) => {
      this.kernelState = status.state;
      this.render();
    });

    this.addEventListener("click", this.onClick);
    this.addEventListener("change", this.onChange);

    this.render();
    await this.loadConfig();
  }

  async gsvSuspend(): Promise<void> {
    this.suspended = true;
    this.render();
  }

  async gsvResume(): Promise<void> {
    this.suspended = false;
    this.render();
  }

  async gsvUnmount(): Promise<void> {
    this.requestVersion += 1;
    this.removeEventListener("click", this.onClick);
    this.removeEventListener("change", this.onChange);

    this.unsubscribeStatus?.();
    this.unsubscribeStatus = null;
    this.context = null;
    this.values.clear();
    this.drafts.clear();
    this.allEntries = [];
    this.rawEntries = [];
  }

  private setStatus(kind: "idle" | "ok" | "error", text: string): void {
    this.statusKind = kind;
    this.statusText = text;
  }

  private hydrateFields(entries: ConfigEntry[]): void {
    this.values.clear();
    this.drafts.clear();

    for (const section of CONTROL_CONFIG_SECTIONS) {
      for (const field of section.fields) {
        const matched = entries.find((entry) => entry.key === field.key);
        const value = matched?.value ?? defaultFieldValue(field);
        this.values.set(field.key, value);
        this.drafts.set(field.key, value);
      }
    }
  }

  private async loadConfig(): Promise<void> {
    const context = this.context;
    if (!context) {
      return;
    }

    const requestVersion = ++this.requestVersion;
    this.isLoading = true;
    this.setStatus("idle", "");
    this.render();

    try {
      const result = await context.kernel.request<{ entries: ConfigEntry[] }>("sys.config.get", { key: "config/" });
      if (!this.context || requestVersion !== this.requestVersion) {
        return;
      }

      this.allEntries = [...(result.entries ?? [])].sort((left, right) => left.key.localeCompare(right.key));
      this.hydrateFields(this.allEntries);
      this.rawEntries = this.filterRawEntries(this.rawQuery);
      this.setStatus("ok", `Loaded ${this.allEntries.length} config entries.`);
    } catch (error) {
      if (!this.context || requestVersion !== this.requestVersion) {
        return;
      }
      this.allEntries = [];
      this.rawEntries = [];
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus("error", message);
    } finally {
      if (!this.context || requestVersion !== this.requestVersion) {
        return;
      }
      this.isLoading = false;
      this.render();
    }
  }

  private sectionDirty(section: ConfigSection): boolean {
    for (const field of section.fields) {
      const value = this.values.get(field.key) ?? "";
      const draft = this.drafts.get(field.key) ?? "";
      if (value !== draft) {
        return true;
      }
    }
    return false;
  }

  private resetSection(sectionId: string): void {
    const section = SECTION_BY_ID.get(sectionId);
    if (!section) {
      return;
    }

    for (const field of section.fields) {
      const current = this.values.get(field.key) ?? defaultFieldValue(field);
      this.drafts.set(field.key, current);
    }
    this.render();
  }

  private async saveSection(sectionId: string): Promise<void> {
    const context = this.context;
    const section = SECTION_BY_ID.get(sectionId);
    if (!context || !section) {
      return;
    }

    if (this.isSaving || this.suspended || this.kernelState !== "connected") {
      return;
    }

    const changed = section.fields.filter((field) => {
      const value = this.values.get(field.key) ?? "";
      const draft = this.drafts.get(field.key) ?? "";
      return value !== draft;
    });

    if (changed.length === 0) {
      this.setStatus("ok", `${section.title} has no changes.`);
      this.render();
      return;
    }

    this.isSaving = true;
    this.savingSectionId = section.id;
    this.setStatus("idle", "");
    this.render();

    try {
      for (const field of changed) {
        const draft = this.drafts.get(field.key) ?? "";
        await context.kernel.request("sys.config.set", {
          key: field.key,
          value: draft,
        });
      }

      for (const field of changed) {
        const draft = this.drafts.get(field.key) ?? "";
        this.values.set(field.key, draft);
      }

      await this.loadConfig();
      this.setStatus("ok", `${section.title} saved.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus("error", message);
    } finally {
      if (!this.context) {
        return;
      }
      this.isSaving = false;
      this.savingSectionId = null;
      this.render();
    }
  }

  private filterRawEntries(query: string): ConfigEntry[] {
    const normalized = query.trim().toLowerCase();
    return this.allEntries.filter((entry) => {
      if (!normalized) {
        return true;
      }
      return (
        entry.key.toLowerCase().includes(normalized) ||
        entry.value.toLowerCase().includes(normalized)
      );
    });
  }

  private async saveRawEntry(): Promise<void> {
    const context = this.context;
    if (!context || this.isSaving || this.suspended || this.kernelState !== "connected") {
      return;
    }

    const key = this.rawKey.trim();
    if (!key) {
      this.setStatus("error", "Raw key is required.");
      this.render();
      return;
    }

    this.isSaving = true;
    this.savingSectionId = "raw";
    this.setStatus("idle", "");
    this.render();

    try {
      await context.kernel.request("sys.config.set", {
        key,
        value: this.rawValue,
      });
      await this.loadConfig();
      this.setStatus("ok", `Saved ${key}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus("error", message);
    } finally {
      if (!this.context) {
        return;
      }
      this.isSaving = false;
      this.savingSectionId = null;
      this.render();
    }
  }

  private renderFieldInput(field: ConfigField): string {
    const value = this.drafts.get(field.key) ?? defaultFieldValue(field);
    const disabled = this.isSaving || this.suspended || this.kernelState !== "connected";

    if (field.kind === "textarea") {
      return `
        <textarea
          data-config-field-key="${escapeHtml(field.key)}"
          rows="4"
          ${disabled ? "disabled" : ""}
          placeholder="${escapeHtml(field.placeholder ?? "")}"
        >${escapeHtml(value)}</textarea>
      `;
    }

    if (field.kind === "boolean") {
      const checked = value === "true" ? "checked" : "";
      return `
        <label class="config-checkbox">
          <input
            data-config-field-key="${escapeHtml(field.key)}"
            type="checkbox"
            ${checked}
            ${disabled ? "disabled" : ""}
          />
          Enabled
        </label>
      `;
    }

    if (field.kind === "select") {
      const options = field.options ?? [];
      const known = options.some((option) => option.value === value);
      const selectOptions = [
        ...(known ? [] : [{ value, label: value || "(empty)" }]),
        ...options,
      ]
        .map((option) => {
          const selected = option.value === value ? "selected" : "";
          return `<option value="${escapeHtml(option.value)}" ${selected}>${escapeHtml(option.label)}</option>`;
        })
        .join("");

      return `
        <select data-config-field-key="${escapeHtml(field.key)}" ${disabled ? "disabled" : ""}>
          ${selectOptions}
        </select>
      `;
    }

    const inputType =
      field.kind === "number"
        ? "number"
        : field.kind === "password"
          ? "password"
          : "text";

    return `
      <input
        data-config-field-key="${escapeHtml(field.key)}"
        type="${inputType}"
        value="${escapeHtml(value)}"
        placeholder="${escapeHtml(field.placeholder ?? "")}"
        ${disabled ? "disabled" : ""}
      />
    `;
  }

  private renderSection(section: ConfigSection): string {
    const dirty = this.sectionDirty(section);
    const saving = this.savingSectionId === section.id;
    const disabled =
      this.suspended ||
      this.kernelState !== "connected" ||
      this.isLoading ||
      this.isSaving ||
      !dirty;

    const fieldsMarkup = section.fields
      .map((field) => {
        return `
          <article class="config-field">
            <h3>${escapeHtml(field.label)}</h3>
            <p>${escapeHtml(field.description)}</p>
            ${this.renderFieldInput(field)}
          </article>
        `;
      })
      .join("");

    return `
      <section class="config-card">
        <header>
          <h2>${escapeHtml(section.title)}</h2>
          <p>${escapeHtml(section.description)}</p>
        </header>
        <div class="config-field-grid">
          ${fieldsMarkup}
        </div>
        <div class="config-card-actions">
          <button
            type="button"
            class="runtime-btn"
            data-action="save-section"
            data-section-id="${escapeHtml(section.id)}"
            ${disabled ? "disabled" : ""}
          >
            ${saving ? "Saving..." : `Save ${escapeHtml(section.title)}`}
          </button>
          <button
            type="button"
            class="runtime-btn"
            data-action="reset-section"
            data-section-id="${escapeHtml(section.id)}"
            ${this.isSaving || !dirty ? "disabled" : ""}
          >
            Reset
          </button>
        </div>
      </section>
    `;
  }

  private renderAdvanced(): string {
    if (!this.showAdvanced) {
      return "";
    }

    this.rawEntries = this.filterRawEntries(this.rawQuery);
    const rowsMarkup =
      this.rawEntries.length === 0
        ? `<p class="config-empty muted">No entries for current filter.</p>`
        : this.rawEntries
            .map((entry, index) => {
              return `
                <button type="button" class="config-row" data-action="raw-select-entry" data-index="${index}">
                  <span class="config-row-key">${escapeHtml(entry.key)}</span>
                  <code class="config-row-value">${escapeHtml(compactPreview(entry.value))}</code>
                </button>
              `;
            })
            .join("");

    return `
      <section class="config-advanced">
        <header>
          <h2>Advanced Raw Config</h2>
          <p>Direct key/value editor for power users.</p>
        </header>
        <div class="config-toolbar">
          <label>
            Filter
            <input
              data-raw-field="query"
              type="text"
              value="${escapeHtml(this.rawQuery)}"
              placeholder="config/ai"
              ${this.isSaving ? "disabled" : ""}
            />
          </label>
        </div>
        <section class="config-list">
          ${rowsMarkup}
        </section>
        <div class="config-set-form">
          <label>
            Raw Key
            <input
              data-raw-field="key"
              type="text"
              value="${escapeHtml(this.rawKey)}"
              placeholder="config/ai/model"
              ${this.isSaving ? "disabled" : ""}
            />
          </label>
          <label>
            Raw Value
            <textarea
              data-raw-field="value"
              rows="4"
              ${this.isSaving ? "disabled" : ""}
            >${escapeHtml(this.rawValue)}</textarea>
          </label>
          <div class="config-set-actions">
            <button
              type="button"
              class="runtime-btn"
              data-action="raw-save"
              ${this.isSaving || this.rawKey.trim().length === 0 ? "disabled" : ""}
            >
              ${this.savingSectionId === "raw" ? "Saving..." : "Save Raw Key"}
            </button>
            <button
              type="button"
              class="runtime-btn"
              data-action="raw-clear"
              ${this.isSaving ? "disabled" : ""}
            >
              Clear
            </button>
          </div>
        </div>
      </section>
    `;
  }

  private render(): void {
    const context = this.context;
    if (!context) {
      this.innerHTML = "";
      return;
    }

    const statusMarkup =
      this.statusKind === "idle" || this.statusText.length === 0
        ? ""
        : `<p class="config-status is-${this.statusKind}">${escapeHtml(this.statusText)}</p>`;

    const sectionsMarkup = CONTROL_CONFIG_SECTIONS.map((section) => this.renderSection(section)).join("");
    const advancedMarkup = this.renderAdvanced();

    this.innerHTML = `
      <section class="app-grid config-app">
        <p class="eyebrow">System Surface</p>
        <h1>${escapeHtml(context.manifest.name)} Settings</h1>
        <p>Configure gateway behavior through organized sections instead of raw key paths.</p>

        <div class="app-tag-row">
          <span class="app-tag">kernel ${escapeHtml(this.kernelState)}</span>
          <span class="app-tag">${this.allEntries.length} loaded entries</span>
          <span class="app-tag">${this.suspended ? "suspended" : "running"}</span>
        </div>

        <div class="config-top-actions">
          <button
            type="button"
            class="runtime-btn"
            data-action="refresh-config"
            ${this.isLoading || this.isSaving || this.suspended ? "disabled" : ""}
          >
            ${this.isLoading ? "Refreshing..." : "Refresh Settings"}
          </button>
          <button
            type="button"
            class="runtime-btn"
            data-action="toggle-advanced"
            ${this.isSaving ? "disabled" : ""}
          >
            ${this.showAdvanced ? "Hide Advanced" : "Show Advanced"}
          </button>
        </div>

        ${statusMarkup}
        ${sectionsMarkup}
        ${advancedMarkup}
      </section>
    `;
  }
}

class GsvSdkExampleAppElement extends GsvSurfaceElement {
  constructor() {
    super("sdk");
  }
}

export function ensureBuiltinComponentAppsRegistered(): void {
  defineElement("gsv-shell-app", GsvShellAppElement);
  defineElement("gsv-files-app", GsvFilesAppElement);
  defineElement("gsv-control-app", GsvControlAppElement);
  defineElement("gsv-sdk-example-app", GsvSdkExampleAppElement);
}
