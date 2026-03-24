import type { AppElementContext, GsvAppElement } from "./app-sdk";
import { DESKTOP_THEMES, isThemeId, type ThemeId } from "./themes";

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

function formatTimestampMs(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return "—";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return date.toLocaleString();
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
type ConfigSectionId = (typeof CONTROL_CONFIG_SECTIONS)[number]["id"];
type ControlViewId = "appearance" | ConfigSectionId;
type ControlTabId = "config" | "access" | "adapters" | "advanced";

type ControlTabItem = {
  id: ControlTabId;
  title: string;
};

type ControlNavItem = {
  id: ControlViewId;
  title: string;
};

type ConfigSectionGroup = {
  title: string;
  description: string;
  fieldKeys: readonly string[];
  fullWidth?: boolean;
};

const CONTROL_NAV_ITEMS: readonly ControlNavItem[] = [
  {
    id: "appearance",
    title: "Appearance",
  },
  ...CONTROL_CONFIG_SECTIONS.map((section) => ({
    id: section.id,
    title: section.title,
  })),
] as const;

const CONTROL_TAB_ITEMS: readonly ControlTabItem[] = [
  { id: "config", title: "Config" },
  { id: "access", title: "Access" },
  { id: "adapters", title: "Adapters" },
  { id: "advanced", title: "Advanced" },
] as const;

const CONTROL_TAB_ID_SET = new Set<ControlTabId>(CONTROL_TAB_ITEMS.map((tab) => tab.id));

function isControlTabId(value: string): value is ControlTabId {
  return CONTROL_TAB_ID_SET.has(value as ControlTabId);
}

type AccessTokenRecord = {
  tokenId: string;
  uid: number;
  kind: string;
  label: string | null;
  tokenPrefix: string;
  allowedRole: string | null;
  allowedDeviceId: string | null;
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number | null;
  revokedAt: number | null;
  revokedReason: string | null;
};

type AccessLinkRecord = {
  adapter: string;
  accountId: string;
  actorId: string;
  uid: number;
  createdAt: number;
  linkedByUid?: number;
};

type AdapterChallenge = {
  type: string;
  message?: string;
  data?: string;
  expiresAt?: number;
};

type AdapterAccountStatusRecord = {
  accountId: string;
  connected: boolean;
  authenticated: boolean;
  mode?: string;
  lastActivity?: number;
  error?: string;
  extra?: Record<string, unknown>;
};

const CONTROL_SECTION_LAYOUTS: Record<ConfigSectionId, readonly ConfigSectionGroup[]> = {
  ai: [
    {
      title: "Model Runtime",
      description: "Provider, model, and reasoning behavior for process runs.",
      fieldKeys: [
        "config/ai/provider",
        "config/ai/model",
        "config/ai/api_key",
        "config/ai/reasoning",
      ],
    },
    {
      title: "Generation Limits",
      description: "Token and context budgets that bound completion cost and size.",
      fieldKeys: [
        "config/ai/max_tokens",
        "config/ai/max_context_bytes",
      ],
    },
    {
      title: "System Prompt Baseline",
      description: "Global instructions injected before each run.",
      fieldKeys: ["config/ai/system_prompt"],
      fullWidth: true,
    },
  ],
  shell: [
    {
      title: "Execution Limits",
      description: "Timeout and output boundaries for shell commands.",
      fieldKeys: [
        "config/shell/timeout_ms",
        "config/shell/max_output_bytes",
      ],
    },
    {
      title: "Execution Access",
      description: "Network access policy for shell execution.",
      fieldKeys: ["config/shell/network_enabled"],
    },
  ],
  server: [
    {
      title: "Identity",
      description: "Name and version shown to connected clients.",
      fieldKeys: [
        "config/server/name",
        "config/server/version",
      ],
      fullWidth: true,
    },
  ],
  auth: [
    {
      title: "Machine Authentication",
      description: "Controls machine-role password fallback behavior.",
      fieldKeys: ["config/auth/allow_machine_password"],
      fullWidth: true,
    },
  ],
};

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
  private activeTab: ControlTabId = "config";
  private rawQuery = "";
  private rawKey = "";
  private rawValue = "";
  private activeView: ControlViewId = "appearance";
  private themeId: ThemeId = DESKTOP_THEMES[0]?.id ?? "frutiger-aero";
  private accessTokens: AccessTokenRecord[] = [];
  private accessLinks: AccessLinkRecord[] = [];
  private createdTokenSecret = "";
  private tokenCreateKind: "node" | "service" | "user" = "node";
  private tokenCreateLabel = "";
  private tokenCreateRole = "";
  private tokenCreateDeviceId = "";
  private tokenCreateExpiresAt = "";
  private tokenCreateUid = "";
  private tokenRevokeId = "";
  private tokenRevokeReason = "";
  private linkCode = "";
  private linkAdapter = "";
  private linkAccountId = "";
  private linkActorId = "";
  private linkUid = "";
  private adapterId = "whatsapp";
  private adapterAccountId = "default";
  private adapterConfigJson = "{}";
  private adapterChallenge: AdapterChallenge | null = null;
  private adapterStatusAccounts: AdapterAccountStatusRecord[] = [];
  private adapterStatusLabel = "";
  private kernelState = "disconnected";
  private isLoading = false;
  private isSaving = false;
  private savingSectionId: string | null = null;
  private suspended = false;
  private statusKind: "idle" | "error" = "idle";
  private statusText = "";
  private requestVersion = 0;
  private unsubscribeStatus: (() => void) | null = null;
  private unsubscribeTheme: (() => void) | null = null;

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

    if (action === "refresh-panel") {
      void this.refreshActiveTab();
      return;
    }

    if (action === "select-tab") {
      const tabId = actionNode.dataset.tabId;
      if (!tabId || !isControlTabId(tabId)) {
        return;
      }
      this.activeTab = tabId;
      this.setStatus("idle", "");
      this.createdTokenSecret = "";
      this.adapterChallenge = null;
      void this.refreshActiveTab();
      this.render();
      return;
    }

    if (action === "select-view") {
      const nextView = actionNode.dataset.viewId;
      if (!nextView) {
        return;
      }
      this.activeView = nextView as ControlViewId;
      this.render();
      return;
    }

    if (action === "save-section") {
      const sectionId = actionNode.dataset.sectionId ?? "";
      void this.saveSection(sectionId);
      return;
    }

    if (action === "access-refresh") {
      void this.loadAccessData();
      return;
    }

    if (action === "token-create") {
      void this.createToken();
      return;
    }

    if (action === "token-revoke") {
      const tokenId = actionNode.dataset.tokenId ?? this.tokenRevokeId.trim();
      void this.revokeToken(tokenId);
      return;
    }

    if (action === "link-code") {
      void this.consumeLinkCode();
      return;
    }

    if (action === "link-manual") {
      void this.linkIdentityManual();
      return;
    }

    if (action === "unlink-row") {
      const adapter = actionNode.dataset.adapter;
      const accountId = actionNode.dataset.accountId;
      const actorId = actionNode.dataset.actorId;
      if (!adapter || !accountId || !actorId) {
        return;
      }
      void this.unlinkIdentity(adapter, accountId, actorId);
      return;
    }

    if (action === "token-secret-clear") {
      this.createdTokenSecret = "";
      this.render();
      return;
    }

    if (action === "adapter-connect") {
      void this.connectAdapter();
      return;
    }

    if (action === "adapter-disconnect") {
      void this.disconnectAdapter();
      return;
    }

    if (action === "adapter-status") {
      void this.loadAdapterStatus();
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
      this.activeTab = "advanced";
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

    if (target instanceof HTMLSelectElement && target.dataset.desktopTheme === "true") {
      const nextTheme = target.value;
      if (!isThemeId(nextTheme)) {
        return;
      }
      this.themeId = nextTheme;
      window.dispatchEvent(new CustomEvent("gsv:theme-set", { detail: { themeId: nextTheme } }));
      this.render();
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

    const accessField = target.dataset.accessField;
    if (accessField) {
      const value = target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement
        ? target.value
        : "";
      switch (accessField) {
        case "token-kind":
          if (value === "node" || value === "service" || value === "user") {
            this.tokenCreateKind = value;
          }
          break;
        case "token-label":
          this.tokenCreateLabel = value;
          break;
        case "token-role":
          this.tokenCreateRole = value;
          break;
        case "token-device":
          this.tokenCreateDeviceId = value;
          break;
        case "token-expires":
          this.tokenCreateExpiresAt = value;
          break;
        case "token-uid":
          this.tokenCreateUid = value;
          break;
        case "token-revoke-id":
          this.tokenRevokeId = value;
          break;
        case "token-revoke-reason":
          this.tokenRevokeReason = value;
          break;
        case "link-code":
          this.linkCode = value;
          break;
        case "link-adapter":
          this.linkAdapter = value;
          break;
        case "link-account":
          this.linkAccountId = value;
          break;
        case "link-actor":
          this.linkActorId = value;
          break;
        case "link-uid":
          this.linkUid = value;
          break;
        default:
          break;
      }
      return;
    }

    const adapterField = target.dataset.adapterField;
    if (adapterField) {
      const value = target.value;
      switch (adapterField) {
        case "adapter-id":
          this.adapterId = value;
          break;
        case "adapter-account-id":
          this.adapterAccountId = value;
          break;
        case "adapter-config-json":
          this.adapterConfigJson = value;
          break;
        default:
          break;
      }
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
    const initialThemeId = context.theme.snapshot().themeId;
    if (typeof initialThemeId === "string" && isThemeId(initialThemeId)) {
      this.themeId = initialThemeId;
    }

    this.unsubscribeStatus?.();
    this.unsubscribeStatus = context.kernel.onStatus((status) => {
      this.kernelState = status.state;
      this.render();
    });

    this.unsubscribeTheme?.();
    this.unsubscribeTheme = context.theme.subscribe((snapshot) => {
      const nextThemeId = snapshot.themeId;
      if (typeof nextThemeId === "string" && isThemeId(nextThemeId)) {
        this.themeId = nextThemeId;
        this.render();
      }
    });

    this.addEventListener("click", this.onClick);
    this.addEventListener("change", this.onChange);

    this.render();
    await this.refreshActiveTab();
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
    this.unsubscribeTheme?.();
    this.unsubscribeTheme = null;
    this.context = null;
    this.values.clear();
    this.drafts.clear();
    this.allEntries = [];
    this.rawEntries = [];
    this.accessTokens = [];
    this.accessLinks = [];
    this.adapterStatusAccounts = [];
  }

  private setStatus(kind: "idle" | "error", text: string): void {
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
      this.setStatus("idle", "");
    } catch (error) {
      if (!this.context || requestVersion !== this.requestVersion) {
        return;
      }
      this.allEntries = [];
      this.rawEntries = [];
      const message = error instanceof Error ? error.message : String(error);
      if (this.kernelState === "connected") {
        this.setStatus("error", message);
      } else {
        this.setStatus("idle", "");
      }
    } finally {
      if (!this.context || requestVersion !== this.requestVersion) {
        return;
      }
      this.isLoading = false;
      this.render();
    }
  }

  private async refreshActiveTab(): Promise<void> {
    if (this.activeTab === "config" || this.activeTab === "advanced") {
      await this.loadConfig();
      return;
    }
    if (this.activeTab === "access") {
      await this.loadAccessData();
      return;
    }
    if (this.activeTab === "adapters") {
      await this.loadAdapterStatus();
    }
  }

  private parseOptionalInteger(value: string): number | null {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(parsed)) {
      return null;
    }
    return parsed;
  }

  private async loadAccessData(): Promise<void> {
    const context = this.context;
    if (!context) {
      return;
    }

    this.isLoading = true;
    this.setStatus("idle", "");
    this.render();

    try {
      const [tokenPayload, linkPayload] = await Promise.all([
        context.kernel.request<{ tokens?: AccessTokenRecord[] }>("sys.token.list", {}),
        context.kernel.request<{ links?: AccessLinkRecord[] }>("sys.link.list", {}),
      ]);

      this.accessTokens = [...(tokenPayload.tokens ?? [])].sort(
        (left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0),
      );
      this.accessLinks = [...(linkPayload.links ?? [])].sort(
        (left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0),
      );
      this.setStatus("idle", "");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.kernelState === "connected") {
        this.setStatus("error", message);
      } else {
        this.setStatus("idle", "");
      }
    } finally {
      if (!this.context) {
        return;
      }
      this.isLoading = false;
      this.render();
    }
  }

  private async createToken(): Promise<void> {
    const context = this.context;
    if (!context || this.isSaving || this.suspended || this.kernelState !== "connected") {
      return;
    }

    const args: Record<string, unknown> = {
      kind: this.tokenCreateKind,
    };

    const label = this.tokenCreateLabel.trim();
    if (label) {
      args.label = label;
    }

    const role = this.tokenCreateRole.trim();
    if (role) {
      args.allowedRole = role;
    }

    const device = this.tokenCreateDeviceId.trim();
    if (device) {
      args.allowedDeviceId = device;
    }

    const expiresAt = this.parseOptionalInteger(this.tokenCreateExpiresAt);
    if (this.tokenCreateExpiresAt.trim() && expiresAt === null) {
      this.setStatus("error", "Token expiry must be a unix timestamp in milliseconds.");
      this.render();
      return;
    }
    if (expiresAt !== null) {
      args.expiresAt = expiresAt;
    }

    const uid = this.parseOptionalInteger(this.tokenCreateUid);
    if (this.tokenCreateUid.trim() && uid === null) {
      this.setStatus("error", "Token uid must be an integer.");
      this.render();
      return;
    }
    if (uid !== null) {
      args.uid = uid;
    }

    this.isSaving = true;
    this.setStatus("idle", "");
    this.render();
    try {
      const payload = await context.kernel.request<{ token?: { token?: string } }>(
        "sys.token.create",
        args,
      );
      this.createdTokenSecret = payload.token?.token ?? "";
      await this.loadAccessData();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus("error", message);
    } finally {
      if (!this.context) {
        return;
      }
      this.isSaving = false;
      this.render();
    }
  }

  private async revokeToken(tokenId: string): Promise<void> {
    const context = this.context;
    if (!context || this.isSaving || this.suspended || this.kernelState !== "connected") {
      return;
    }
    const normalizedId = tokenId.trim();
    if (!normalizedId) {
      this.setStatus("error", "Token id is required to revoke.");
      this.render();
      return;
    }

    const args: Record<string, unknown> = { tokenId: normalizedId };
    const reason = this.tokenRevokeReason.trim();
    if (reason) {
      args.reason = reason;
    }

    this.isSaving = true;
    this.setStatus("idle", "");
    this.render();
    try {
      await context.kernel.request("sys.token.revoke", args);
      this.tokenRevokeId = "";
      this.tokenRevokeReason = "";
      await this.loadAccessData();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus("error", message);
    } finally {
      if (!this.context) {
        return;
      }
      this.isSaving = false;
      this.render();
    }
  }

  private async consumeLinkCode(): Promise<void> {
    const context = this.context;
    if (!context || this.isSaving || this.suspended || this.kernelState !== "connected") {
      return;
    }
    const code = this.linkCode.trim();
    if (!code) {
      this.setStatus("error", "A one-time link code is required.");
      this.render();
      return;
    }

    this.isSaving = true;
    this.setStatus("idle", "");
    this.render();
    try {
      await context.kernel.request("sys.link.consume", { code });
      this.linkCode = "";
      await this.loadAccessData();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus("error", message);
    } finally {
      if (!this.context) {
        return;
      }
      this.isSaving = false;
      this.render();
    }
  }

  private async linkIdentityManual(): Promise<void> {
    const context = this.context;
    if (!context || this.isSaving || this.suspended || this.kernelState !== "connected") {
      return;
    }
    const adapter = this.linkAdapter.trim();
    const accountId = this.linkAccountId.trim();
    const actorId = this.linkActorId.trim();
    if (!adapter || !accountId || !actorId) {
      this.setStatus("error", "Adapter, account ID, and actor ID are required.");
      this.render();
      return;
    }

    const args: Record<string, unknown> = { adapter, accountId, actorId };
    const uid = this.parseOptionalInteger(this.linkUid);
    if (this.linkUid.trim() && uid === null) {
      this.setStatus("error", "Link uid must be an integer.");
      this.render();
      return;
    }
    if (uid !== null) {
      args.uid = uid;
    }

    this.isSaving = true;
    this.setStatus("idle", "");
    this.render();
    try {
      await context.kernel.request("sys.link", args);
      await this.loadAccessData();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus("error", message);
    } finally {
      if (!this.context) {
        return;
      }
      this.isSaving = false;
      this.render();
    }
  }

  private async unlinkIdentity(adapter: string, accountId: string, actorId: string): Promise<void> {
    const context = this.context;
    if (!context || this.isSaving || this.suspended || this.kernelState !== "connected") {
      return;
    }

    this.isSaving = true;
    this.setStatus("idle", "");
    this.render();
    try {
      await context.kernel.request("sys.unlink", { adapter, accountId, actorId });
      await this.loadAccessData();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus("error", message);
    } finally {
      if (!this.context) {
        return;
      }
      this.isSaving = false;
      this.render();
    }
  }

  private async loadAdapterStatus(): Promise<void> {
    const context = this.context;
    if (!context) {
      return;
    }
    const adapter = this.adapterId.trim();
    if (!adapter) {
      this.setStatus("error", "Adapter id is required.");
      this.render();
      return;
    }

    this.isLoading = true;
    this.setStatus("idle", "");
    this.render();
    try {
      const args: Record<string, unknown> = { adapter };
      const accountId = this.adapterAccountId.trim();
      if (accountId) {
        args.accountId = accountId;
      }
      const payload = await context.kernel.request<{ adapter?: string; accounts?: AdapterAccountStatusRecord[] }>(
        "adapter.status",
        args,
      );
      this.adapterStatusAccounts = payload.accounts ?? [];
      this.adapterStatusLabel = payload.adapter ?? adapter;
      this.setStatus("idle", "");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus("error", message);
      this.adapterStatusAccounts = [];
      this.adapterStatusLabel = adapter;
    } finally {
      if (!this.context) {
        return;
      }
      this.isLoading = false;
      this.render();
    }
  }

  private async connectAdapter(): Promise<void> {
    const context = this.context;
    if (!context || this.isSaving || this.suspended || this.kernelState !== "connected") {
      return;
    }
    const adapter = this.adapterId.trim();
    const accountId = this.adapterAccountId.trim() || "default";
    if (!adapter) {
      this.setStatus("error", "Adapter id is required.");
      this.render();
      return;
    }

    let parsedConfig: Record<string, unknown> = {};
    if (this.adapterConfigJson.trim()) {
      try {
        const parsed = JSON.parse(this.adapterConfigJson) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("Adapter config must be a JSON object.");
        }
        parsedConfig = parsed as Record<string, unknown>;
      } catch (error) {
        this.setStatus("error", error instanceof Error ? error.message : "Invalid adapter config JSON.");
        this.render();
        return;
      }
    }

    this.isSaving = true;
    this.setStatus("idle", "");
    this.render();
    try {
      const payload = await context.kernel.request<{
        ok: boolean;
        message?: string;
        challenge?: AdapterChallenge;
        error?: string;
      }>("adapter.connect", { adapter, accountId, config: parsedConfig });
      if (!payload.ok) {
        throw new Error(payload.error ?? "adapter.connect failed");
      }
      this.adapterChallenge = payload.challenge ?? null;
      this.setStatus("idle", "");
      await this.loadAdapterStatus();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus("error", message);
    } finally {
      if (!this.context) {
        return;
      }
      this.isSaving = false;
      this.render();
    }
  }

  private async disconnectAdapter(): Promise<void> {
    const context = this.context;
    if (!context || this.isSaving || this.suspended || this.kernelState !== "connected") {
      return;
    }
    const adapter = this.adapterId.trim();
    const accountId = this.adapterAccountId.trim() || "default";
    if (!adapter) {
      this.setStatus("error", "Adapter id is required.");
      this.render();
      return;
    }

    this.isSaving = true;
    this.setStatus("idle", "");
    this.render();
    try {
      const payload = await context.kernel.request<{ ok: boolean; error?: string }>(
        "adapter.disconnect",
        { adapter, accountId },
      );
      if (!payload.ok) {
        throw new Error(payload.error ?? "adapter.disconnect failed");
      }
      this.adapterChallenge = null;
      this.setStatus("idle", "");
      await this.loadAdapterStatus();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus("error", message);
    } finally {
      if (!this.context) {
        return;
      }
      this.isSaving = false;
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
      this.setStatus("idle", "");
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
      this.setStatus("idle", "");
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

  private resolveSectionField(section: ConfigSection, fieldKey: string): ConfigField | null {
    return section.fields.find((field) => field.key === fieldKey) ?? null;
  }

  private sectionGroups(section: ConfigSection): readonly ConfigSectionGroup[] {
    const configuredGroups = CONTROL_SECTION_LAYOUTS[section.id as ConfigSectionId];
    if (configuredGroups && configuredGroups.length > 0) {
      return configuredGroups;
    }

    return [
      {
        title: section.title,
        description: section.description,
        fieldKeys: section.fields.map((field) => field.key),
        fullWidth: true,
      },
    ];
  }

  private describeControlState(): {
    kind: "ready" | "working" | "dirty" | "error" | "offline";
    label: string;
    detail: string;
  } {
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

    if (this.isLoading || this.isSaving) {
      return {
        kind: "working",
        label: this.isSaving ? "saving" : "syncing",
        detail: this.isSaving ? "Saving settings." : "Refreshing settings.",
      };
    }

    const hasDirtySection = CONTROL_CONFIG_SECTIONS.some((section) => this.sectionDirty(section));
    if (hasDirtySection) {
      return {
        kind: "dirty",
        label: "unsaved",
        detail: "There are unsaved changes.",
      };
    }

    return {
      kind: "ready",
      label: "synced",
      detail: "Settings are in sync.",
    };
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
        ${field.kind === "number" ? "inputmode=\"numeric\"" : ""}
        ${disabled ? "disabled" : ""}
      />
    `;
  }

  private renderFieldRow(field: ConfigField): string {
    return `
      <article class="config-field-row">
        <div class="config-field-copy">
          <h4>${escapeHtml(field.label)}</h4>
          <p>${escapeHtml(field.description)}</p>
        </div>
        <div class="config-field-control">
          ${this.renderFieldInput(field)}
        </div>
      </article>
    `;
  }

  private renderSectionGroup(section: ConfigSection, group: ConfigSectionGroup): string {
    const fieldsMarkup = group.fieldKeys
      .map((fieldKey) => this.resolveSectionField(section, fieldKey))
      .filter((field): field is ConfigField => field !== null)
      .map((field) => this.renderFieldRow(field))
      .join("");

    if (!fieldsMarkup) {
      return "";
    }

    return `
      <article class="config-group${group.fullWidth ? " is-full" : ""}">
        <header>
          <h3>${escapeHtml(group.title)}</h3>
          <p>${escapeHtml(group.description)}</p>
        </header>
        <div class="config-group-fields">
          ${fieldsMarkup}
        </div>
      </article>
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
    const groups = this.sectionGroups(section);
    const groupsMarkup = groups
      .map((group) => this.renderSectionGroup(section, group))
      .join("");

    return `
      <section class="config-panel" data-config-panel="${escapeHtml(section.id)}">
        <header class="config-panel-header">
          <h2>${escapeHtml(section.title)}</h2>
          <p>${escapeHtml(section.description)}</p>
        </header>
        <div class="config-group-grid">
          ${groupsMarkup}
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
        </div>
      </section>
    `;
  }

  private renderAdvanced(): string {
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
      <section class="config-panel config-advanced-panel">
        <header class="config-panel-header">
          <h2>Advanced Raw Config</h2>
          <p>Direct key/value editor for power users.</p>
        </header>
        <article class="config-group is-full">
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
        </article>
        <article class="config-group is-full">
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
        </article>
      </section>
    `;
  }

  private renderAppearance(): string {
    const disabled = this.suspended;
    const themeOptions = DESKTOP_THEMES.map((theme) => {
      const selected = theme.id === this.themeId ? "selected" : "";
      return `<option value="${escapeHtml(theme.id)}" ${selected}>${escapeHtml(theme.label)}</option>`;
    }).join("");
    const activeThemeLabel = DESKTOP_THEMES.find((theme) => theme.id === this.themeId)?.label ?? this.themeId;

    return `
      <section class="config-panel config-theme-panel" data-config-panel="appearance">
        <header class="config-panel-header">
          <h2>Appearance</h2>
          <p>Choose how the desktop and apps look and feel.</p>
        </header>
        <div class="config-group-grid">
          <article class="config-group">
            <header>
              <h3>Desktop Theme</h3>
              <p>Applies immediately to the OS shell and all running apps.</p>
            </header>
            <div class="config-group-fields">
              <div class="config-field-control">
                <select data-desktop-theme="true" ${disabled ? "disabled" : ""}>
                  ${themeOptions}
                </select>
              </div>
            </div>
          </article>
          <article class="config-group">
            <header>
              <h3>Current Selection</h3>
              <p>Active theme across your desktop right now.</p>
            </header>
            <div class="config-group-fields">
              <p class="config-theme-preview">${escapeHtml(activeThemeLabel)}</p>
            </div>
          </article>
        </div>
      </section>
    `;
  }

  private isViewDirty(viewId: ControlViewId): boolean {
    if (viewId === "appearance") {
      return false;
    }

    const section = SECTION_BY_ID.get(viewId);
    if (!section) {
      return false;
    }
    return this.sectionDirty(section);
  }

  private renderNav(): string {
    return CONTROL_NAV_ITEMS.map((item) => {
      const activeClass = this.activeView === item.id ? " is-active" : "";
      const dirtyClass = this.isViewDirty(item.id) ? " has-dirty" : "";
      return `
        <button
          type="button"
          class="config-nav-btn${activeClass}${dirtyClass}"
          data-action="select-view"
          data-view-id="${escapeHtml(item.id)}"
        >
          <span class="config-nav-dot" aria-hidden="true"></span>
          <span class="config-nav-title">${escapeHtml(item.title)}</span>
        </button>
      `;
    }).join("");
  }

  private renderTabs(): string {
    return CONTROL_TAB_ITEMS.map((tab) => {
      const activeClass = this.activeTab === tab.id ? " is-active" : "";
      return `
        <button
          type="button"
          class="config-tab-btn${activeClass}"
          data-action="select-tab"
          data-tab-id="${escapeHtml(tab.id)}"
        >
          ${escapeHtml(tab.title)}
        </button>
      `;
    }).join("");
  }

  private renderConfigPanel(): string {
    if (this.activeView === "appearance") {
      return this.renderAppearance();
    }

    const section = SECTION_BY_ID.get(this.activeView);
    if (!section) {
      return this.renderAppearance();
    }
    return this.renderSection(section);
  }

  private renderAccessPanel(): string {
    const actionDisabled = this.isSaving || this.suspended || this.kernelState !== "connected";
    const tokenRows =
      this.accessTokens.length === 0
        ? `<p class="config-empty muted">No tokens found.</p>`
        : this.accessTokens
            .map((token) => {
              const state = token.revokedAt ? "revoked" : "active";
              return `
                <article class="control-row">
                  <div class="control-row-main">
                    <p><strong>${escapeHtml(token.tokenPrefix)}</strong> · ${escapeHtml(token.kind)} · ${escapeHtml(state)}</p>
                    <p class="muted">id ${escapeHtml(token.tokenId)} · uid ${token.uid} · role ${escapeHtml(token.allowedRole ?? "—")} · device ${escapeHtml(token.allowedDeviceId ?? "—")}</p>
                    <p class="muted">created ${escapeHtml(formatTimestampMs(token.createdAt))} · last used ${escapeHtml(formatTimestampMs(token.lastUsedAt))} · expires ${escapeHtml(formatTimestampMs(token.expiresAt))}</p>
                  </div>
                  <div class="control-row-actions">
                    <button
                      type="button"
                      class="runtime-btn"
                      data-action="token-revoke"
                      data-token-id="${escapeHtml(token.tokenId)}"
                      ${actionDisabled || token.revokedAt ? "disabled" : ""}
                    >
                      Revoke
                    </button>
                  </div>
                </article>
              `;
            })
            .join("");

    const linkRows =
      this.accessLinks.length === 0
        ? `<p class="config-empty muted">No linked identities.</p>`
        : this.accessLinks
            .map((link) => {
              return `
                <article class="control-row">
                  <div class="control-row-main">
                    <p><strong>${escapeHtml(link.adapter)}</strong> · account ${escapeHtml(link.accountId)} · actor ${escapeHtml(link.actorId)}</p>
                    <p class="muted">uid ${link.uid} · created ${escapeHtml(formatTimestampMs(link.createdAt))}</p>
                  </div>
                  <div class="control-row-actions">
                    <button
                      type="button"
                      class="runtime-btn"
                      data-action="unlink-row"
                      data-adapter="${escapeHtml(link.adapter)}"
                      data-account-id="${escapeHtml(link.accountId)}"
                      data-actor-id="${escapeHtml(link.actorId)}"
                      ${this.isSaving ? "disabled" : ""}
                    >
                      Unlink
                    </button>
                  </div>
                </article>
              `;
            })
            .join("");

    return `
      <section class="config-panel">
        <header class="config-panel-header">
          <h2>Access</h2>
          <p>Manage machine tokens and adapter identity links.</p>
        </header>

        <div class="config-group-grid">
          <article class="config-group">
            <header>
              <h3>Create Token</h3>
              <p>Issue a new machine or user token.</p>
            </header>
            <div class="control-form-grid">
              <label>Kind
                <select data-access-field="token-kind" ${actionDisabled ? "disabled" : ""}>
                  <option value="node" ${this.tokenCreateKind === "node" ? "selected" : ""}>node</option>
                  <option value="service" ${this.tokenCreateKind === "service" ? "selected" : ""}>service</option>
                  <option value="user" ${this.tokenCreateKind === "user" ? "selected" : ""}>user</option>
                </select>
              </label>
              <label>Label
                <input data-access-field="token-label" value="${escapeHtml(this.tokenCreateLabel)}" placeholder="optional" ${actionDisabled ? "disabled" : ""} />
              </label>
              <label>Role
                <input data-access-field="token-role" value="${escapeHtml(this.tokenCreateRole)}" placeholder="driver | service | user" ${actionDisabled ? "disabled" : ""} />
              </label>
              <label>Device ID
                <input data-access-field="token-device" value="${escapeHtml(this.tokenCreateDeviceId)}" placeholder="optional (node tokens)" ${actionDisabled ? "disabled" : ""} />
              </label>
              <label>Expires At (ms)
                <input data-access-field="token-expires" value="${escapeHtml(this.tokenCreateExpiresAt)}" placeholder="unix ms" ${actionDisabled ? "disabled" : ""} />
              </label>
              <label>UID
                <input data-access-field="token-uid" value="${escapeHtml(this.tokenCreateUid)}" placeholder="root only" ${actionDisabled ? "disabled" : ""} />
              </label>
            </div>
            <div class="config-card-actions">
              <button type="button" class="runtime-btn" data-action="token-create" ${actionDisabled ? "disabled" : ""}>Create Token</button>
            </div>
          </article>

          <article class="config-group">
            <header>
              <h3>Revoke Token</h3>
              <p>Revoke by explicit token ID.</p>
            </header>
            <div class="control-form-grid">
              <label>Token ID
                <input data-access-field="token-revoke-id" value="${escapeHtml(this.tokenRevokeId)}" placeholder="tok_..." ${actionDisabled ? "disabled" : ""} />
              </label>
              <label>Reason
                <input data-access-field="token-revoke-reason" value="${escapeHtml(this.tokenRevokeReason)}" placeholder="optional" ${actionDisabled ? "disabled" : ""} />
              </label>
            </div>
            <div class="config-card-actions">
              <button type="button" class="runtime-btn" data-action="token-revoke" ${actionDisabled || this.tokenRevokeId.trim().length === 0 ? "disabled" : ""}>Revoke</button>
            </div>
          </article>

          <article class="config-group is-full">
            <header>
              <h3>Link by One-time Code</h3>
              <p>Consume link challenges received via adapter flows.</p>
            </header>
            <div class="control-form-grid single">
              <label>Link Code
                <input data-access-field="link-code" value="${escapeHtml(this.linkCode)}" placeholder="ABCD-1234" ${actionDisabled ? "disabled" : ""} />
              </label>
            </div>
            <div class="config-card-actions">
              <button type="button" class="runtime-btn" data-action="link-code" ${actionDisabled || this.linkCode.trim().length === 0 ? "disabled" : ""}>Link Code</button>
            </div>
          </article>

          <article class="config-group is-full">
            <header>
              <h3>Manual Identity Link</h3>
              <p>Create a direct adapter identity mapping.</p>
            </header>
            <div class="control-form-grid">
              <label>Adapter
                <input data-access-field="link-adapter" value="${escapeHtml(this.linkAdapter)}" placeholder="discord" ${actionDisabled ? "disabled" : ""} />
              </label>
              <label>Account ID
                <input data-access-field="link-account" value="${escapeHtml(this.linkAccountId)}" placeholder="default" ${actionDisabled ? "disabled" : ""} />
              </label>
              <label>Actor ID
                <input data-access-field="link-actor" value="${escapeHtml(this.linkActorId)}" placeholder="platform user id" ${actionDisabled ? "disabled" : ""} />
              </label>
              <label>UID
                <input data-access-field="link-uid" value="${escapeHtml(this.linkUid)}" placeholder="optional" ${actionDisabled ? "disabled" : ""} />
              </label>
            </div>
            <div class="config-card-actions">
              <button
                type="button"
                class="runtime-btn"
                data-action="link-manual"
                ${actionDisabled || this.linkAdapter.trim().length === 0 || this.linkAccountId.trim().length === 0 || this.linkActorId.trim().length === 0 ? "disabled" : ""}
              >
                Link Identity
              </button>
            </div>
          </article>
        </div>

        ${this.createdTokenSecret
          ? `
            <article class="config-group is-full">
              <header>
                <h3>Issued Secret</h3>
                <p>This token value is shown only once.</p>
              </header>
              <pre class="control-secret">${escapeHtml(this.createdTokenSecret)}</pre>
              <div class="config-card-actions">
                <button type="button" class="runtime-btn" data-action="token-secret-clear" ${actionDisabled ? "disabled" : ""}>Clear</button>
              </div>
            </article>
          `
          : ""}

        <article class="config-group is-full">
          <header>
            <h3>Tokens</h3>
            <p>Issued tokens visible to your current identity scope.</p>
          </header>
          <div class="control-list">
            ${tokenRows}
          </div>
        </article>

        <article class="config-group is-full">
          <header>
            <h3>Linked Identities</h3>
            <p>Adapter identities mapped to local users.</p>
          </header>
          <div class="control-list">
            ${linkRows}
          </div>
        </article>
      </section>
    `;
  }

  private renderAdaptersPanel(): string {
    const actionDisabled = this.isSaving || this.suspended || this.kernelState !== "connected";
    const adapterRows =
      this.adapterStatusAccounts.length === 0
        ? `<p class="config-empty muted">No accounts returned for ${escapeHtml(this.adapterStatusLabel || this.adapterId)}.</p>`
        : this.adapterStatusAccounts
            .map((account) => {
              return `
                <article class="control-row">
                  <div class="control-row-main">
                    <p><strong>${escapeHtml(account.accountId)}</strong> · ${account.connected ? "connected" : "offline"} · ${account.authenticated ? "authenticated" : "not authenticated"}</p>
                    <p class="muted">mode ${escapeHtml(account.mode ?? "—")} · last activity ${escapeHtml(formatTimestampMs(account.lastActivity))}</p>
                    ${account.error ? `<p class="muted control-error-text">${escapeHtml(account.error)}</p>` : ""}
                  </div>
                </article>
              `;
            })
            .join("");

    return `
      <section class="config-panel">
        <header class="config-panel-header">
          <h2>Adapters</h2>
          <p>Connect, disconnect, and inspect adapter account state.</p>
        </header>

        <div class="config-group-grid">
          <article class="config-group is-full">
            <header>
              <h3>Account Session</h3>
              <p>Manage one adapter account at a time.</p>
            </header>
            <div class="control-form-grid">
              <label>Adapter
                <input data-adapter-field="adapter-id" value="${escapeHtml(this.adapterId)}" placeholder="whatsapp | discord | test" ${actionDisabled ? "disabled" : ""} />
              </label>
              <label>Account ID
                <input data-adapter-field="adapter-account-id" value="${escapeHtml(this.adapterAccountId)}" placeholder="default" ${actionDisabled ? "disabled" : ""} />
              </label>
            </div>
            <label>Config JSON
              <textarea data-adapter-field="adapter-config-json" rows="4" ${actionDisabled ? "disabled" : ""}>${escapeHtml(this.adapterConfigJson)}</textarea>
            </label>
            <div class="config-card-actions">
              <button type="button" class="runtime-btn" data-action="adapter-connect" ${actionDisabled ? "disabled" : ""}>Connect</button>
              <button type="button" class="runtime-btn" data-action="adapter-disconnect" ${actionDisabled ? "disabled" : ""}>Disconnect</button>
              <button type="button" class="runtime-btn" data-action="adapter-status" ${actionDisabled ? "disabled" : ""}>Fetch Status</button>
            </div>
          </article>
        </div>

        ${this.adapterChallenge
          ? `
            <article class="config-group is-full">
              <header>
                <h3>Connect Challenge</h3>
                <p>Complete this challenge in the adapter channel/account.</p>
              </header>
              <p><strong>${escapeHtml(this.adapterChallenge.type)}</strong>${this.adapterChallenge.expiresAt ? ` · expires ${escapeHtml(formatTimestampMs(this.adapterChallenge.expiresAt))}` : ""}</p>
              ${this.adapterChallenge.message ? `<p class="muted">${escapeHtml(this.adapterChallenge.message)}</p>` : ""}
              ${this.adapterChallenge.data ? `<pre class="control-secret">${escapeHtml(compactPreview(String(this.adapterChallenge.data), 1200))}</pre>` : ""}
            </article>
          `
          : ""}

        <article class="config-group is-full">
          <header>
            <h3>Status</h3>
            <p>Latest status for adapter ${escapeHtml(this.adapterStatusLabel || this.adapterId)}.</p>
          </header>
          <div class="control-list">
            ${adapterRows}
          </div>
        </article>
      </section>
    `;
  }

  private renderActivePanel(): string {
    if (this.activeTab === "config") {
      return `
        <div class="config-layout">
          <nav class="config-nav" aria-label="Configuration sections">
            ${this.renderNav()}
          </nav>
          <div class="config-main">
            ${this.renderConfigPanel()}
          </div>
        </div>
      `;
    }
    if (this.activeTab === "access") {
      return this.renderAccessPanel();
    }
    if (this.activeTab === "adapters") {
      return this.renderAdaptersPanel();
    }
    return this.renderAdvanced();
  }

  private render(): void {
    const context = this.context;
    if (!context) {
      this.innerHTML = "";
      return;
    }

    const panelMarkup = this.renderActivePanel();
    const tabsMarkup = this.renderTabs();
    const controlState = this.describeControlState();
    const refreshLabel = this.isLoading ? "Refreshing current tab" : "Refresh current tab";

    this.innerHTML = `
      <section class="app-grid config-app">
        <header class="config-page-header">
          <div class="config-page-copy">
            <p class="eyebrow">System Surface</p>
            <h1>${escapeHtml(context.manifest.name)} Settings</h1>
            <p>Configure gateway behavior through organized sections instead of raw key paths.</p>
          </div>
          <div class="config-toolbar-row">
            <span class="config-state-icon is-${escapeHtml(controlState.kind)}" title="${escapeHtml(controlState.detail)}" aria-label="${escapeHtml(controlState.label)}">
              <span class="config-state-dot" aria-hidden="true"></span>
            </span>
            <button
              type="button"
              class="runtime-btn config-icon-btn${this.isLoading ? " is-busy" : ""}"
              data-action="refresh-panel"
              title="${escapeHtml(refreshLabel)}"
              aria-label="${escapeHtml(refreshLabel)}"
              ${this.isLoading || this.isSaving || this.suspended ? "disabled" : ""}
            >
              <span aria-hidden="true">↻</span>
            </button>
          </div>
        </header>

        <nav class="config-tabs" aria-label="Control sections">
          ${tabsMarkup}
        </nav>

        <div class="control-tab-content">
          ${panelMarkup}
        </div>
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
  defineElement("gsv-control-app", GsvControlAppElement);
  defineElement("gsv-sdk-example-app", GsvSdkExampleAppElement);
}
