import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { ListTemplate, type ListTemplateRow } from "../app/features/gsv-console/list-template/ListTemplate";
import { CardListTemplate } from "../app/features/gsv-console/card-template/CardListTemplate";
import { ConsolePage } from "../app/features/gsv-console/components/ConsolePageTemplate";
import { ConsoleDetailPage } from "../app/features/gsv-console/components/ConsoleDetailPage";
import { SettingsOverviewDashboard } from "../app/features/gsv-console/pages/ConsoleOverviewPanels";
import type {
  ConsoleAccount,
  ConsoleAdapter,
  ConsoleAdapterAccount,
  ConsoleConfigEntry,
  ConsoleMcpServer,
  ConsoleOverviewData,
  ConsolePackage,
  ConsoleProcess,
  ConsoleTarget,
} from "../app/features/gsv-console/domain/consoleModels";
import { AgentCard } from "../app/components/ui/AgentCard";
import { Surface } from "../app/components/ui/Surface";
import { agentImageSrcForIndex } from "../app/features/gsv-console/domain/agentPresentation";
import { AgentEditor } from "../app/components/ui/AgentEditor";
import { AuthLayout } from "../app/features/session/AuthLayout";

/* ---------------------------------------------------------------------------
 * Live archetype previews. Each entry renders the REAL app component with pure
 * mock data and no-op handlers — no gateway, no network, no context. Routed at
 * /design/preview/<id> (full viewport). Global tokens/fonts are already loaded
 * by the app entry (see app/main.tsx), so components render with correct styles.
 * ------------------------------------------------------------------------- */

const noop = () => undefined;

// ── shared full-viewport shell ─────────────────────────────────────────────
/** Console-page archetypes (list / card / detail / dashboard) live inside the
 *  shell's void-backed page column. This reproduces that frame full-screen. */
function ConsoleViewport({ children }: { children: ComponentChildren }) {
  return (
    <div
      style={{
        minHeight: "100vh",
        background: "var(--void)",
        color: "var(--text)",
        fontFamily: "var(--gsv-font-mono)",
      }}
    >
      {children}
    </div>
  );
}

// ── LIST ───────────────────────────────────────────────────────────────────
// Mock adapted from ListTemplateMockPage (integrations surface — tones + tag).
const LIST_ROWS: readonly ListTemplateRow[] = [
  { id: "i1", icon: "weblink", label: "github", sub: "12 tools · 4 resources", tone: "online", statusLabel: "READY", onOpen: noop },
  { id: "i2", icon: "weblink", label: "linear", sub: "authenticating…", tone: "warn", statusLabel: "CHECK", tag: { label: "SIGN-IN", tone: "warn" }, onOpen: noop },
  { id: "i3", icon: "weblink", label: "sentry", sub: "connection refused", tone: "error", statusLabel: "ERROR", onOpen: noop },
  { id: "i4", icon: "weblink", label: "notion", sub: "8 tools · 2 resources", tone: "online", statusLabel: "READY", onOpen: noop },
  { id: "i5", icon: "weblink", label: "slack", sub: "idle", tone: "idle", statusLabel: "OFFLINE", onOpen: noop },
];

function ListPreview() {
  const [search, setSearch] = useState("");
  const q = search.trim().toLowerCase();
  const rows = LIST_ROWS.filter((row) => !q || row.label.toLowerCase().includes(q));
  return (
    <ConsoleViewport>
      <ConsolePage flush>
        <ListTemplate
          listTitle="INTEGRATIONS"
          listMeta={`${rows.length}/${LIST_ROWS.length} READY`}
          rows={rows}
          emptyObject="INTEGRATIONS"
          connectLabel="NEW INTEGRATION"
          onConnect={noop}
          search={{ value: search, placeholder: "Search…", onChange: setSearch }}
        />
      </ConsolePage>
    </ConsoleViewport>
  );
}

// ── CARD LIST ────────────────────────────────────────────────────────────────
// Mock adapted from CardListTemplateMockPage (crew surface).
const MOCK_CREW: readonly { name: string; role: string; status: "online" | "idle" | "live"; tasks: number }[] = [
  { name: "ARIA", role: "Operator", status: "online", tasks: 3 },
  { name: "ORSO", role: "Researcher", status: "live", tasks: 1 },
  { name: "VESPER", role: "Scheduler", status: "idle", tasks: 0 },
  { name: "KESTREL", role: "Analyst", status: "online", tasks: 2 },
];

function CardListPreview() {
  const [search, setSearch] = useState("");
  const q = search.trim().toLowerCase();
  const crew = MOCK_CREW.filter((agent) => !q || agent.name.toLowerCase().includes(q));
  return (
    <ConsoleViewport>
      <ConsolePage flush>
        <CardListTemplate
          listTitle="CREW"
          listMeta={`${crew.length}/${MOCK_CREW.length} CREW`}
          emptyObject="CREW"
          isEmpty={crew.length === 0}
          connectLabel="NEW AGENT"
          onConnect={noop}
          search={{ value: search, placeholder: "Search…", onChange: setSearch }}
        >
          {crew.map((agent, index) => (
            <Surface key={agent.name} level={1} class="gsv-card-cell">
              <AgentCard
                agentName={agent.name}
                agentRole={agent.role}
                status={agent.status}
                imgSrc={agentImageSrcForIndex(index)}
                tasksTotal={agent.tasks}
                models={["claude-opus-4-8"]}
              />
            </Surface>
          ))}
        </CardListTemplate>
      </ConsolePage>
    </ConsoleViewport>
  );
}

// ── DETAIL ───────────────────────────────────────────────────────────────────
// Mock adapted from stories/ConsoleDetailHeader.story.tsx (machine detail).
function DetailPreview() {
  return (
    <ConsoleViewport>
      <ConsolePage flush>
        <ConsoleDetailPage
          icon="computer"
          title="rearden-prime"
          typeLabel="GSV · MACHINE"
          statusLabel="ONLINE"
          tone="online"
          blurb="linux x86_64 · v0.80.2 · root · last seen 2m ago"
          parentLabel="MACHINES"
          onBack={noop}
          sections={[
            {
              title: "MACHINE",
              meta: "ONLINE",
              rows: [
                { id: "device", label: "DEVICE ID", sub: "rearden-prime" },
                { id: "status", icon: "computer", label: "STATUS", status: "online", statusLabel: "ONLINE", sub: "reachable" },
                { id: "platform", label: "PLATFORM", sub: "linux x86_64" },
                { id: "version", label: "VERSION", sub: "v0.80.2" },
                { id: "owner", label: "OWNER", sub: "root" },
              ],
            },
            {
              title: "CAPABILITIES",
              meta: "3",
              rows: [
                { id: "shell", label: "SHELL", sub: "exec" },
                { id: "files", label: "FILES", sub: "read / write" },
                { id: "net", label: "NETWORK", sub: "enabled" },
              ],
            },
          ]}
        />
      </ConsolePage>
    </ConsoleViewport>
  );
}

// ── EDITOR ───────────────────────────────────────────────────────────────────
function EditorPreview() {
  return (
    <AgentEditor
      mode="manage"
      avatarSrc="/img/agent-0.png"
      initialName="ARIA"
      initialRole="OPERATOR"
      initialDescription="Primary operator agent. Coordinates machines, runs tasks, and reports status."
      createdLabel="ACTIVE · 4d"
    />
  );
}

// ── DASHBOARD ────────────────────────────────────────────────────────────────
// SettingsOverviewDashboard is pure/prop-driven. Build a representative
// ConsoleOverviewData so every panel (Ship / Crew / Models & Tasks / Fleet /
// Applications) renders populated. No gateway involved.
const MOCK_ACCOUNTS: ConsoleAccount[] = [
  { uid: 1000, username: "jessicat", displayName: "Jessica", relation: "self", runnable: false, gecos: "", capabilities: [] },
  { uid: 1001, username: "aria", displayName: "ARIA", relation: "personal-agent", runnable: true, gecos: "", capabilities: [] },
  { uid: 1002, username: "orso", displayName: "ORSO", relation: "agent", runnable: true, gecos: "", capabilities: [] },
];

const MOCK_PROCESSES: ConsoleProcess[] = [
  {
    pid: "p1", label: "nightly-digest", state: "running", rawState: "running", uid: 1001,
    username: "aria", profile: "default", cwd: "~/repos/gsv", parentPid: null, interactive: false,
    activeRunId: "r1", activeConversationId: null, queuedCount: 0, createdAt: 0, lastActiveAt: 0,
  },
  {
    pid: "p2", label: "index-rebuild", state: "queued", rawState: "queued", uid: 1002,
    username: "orso", profile: "default", cwd: "~/data", parentPid: null, interactive: false,
    activeRunId: null, activeConversationId: null, queuedCount: 1, createdAt: 0, lastActiveAt: 0,
  },
];

const MOCK_TARGETS: ConsoleTarget[] = [
  {
    deviceId: "rearden-prime", kind: "native-device", ownerUid: 1000, ownerUsername: "jessicat",
    label: "rearden-prime", description: "", platform: "linux x86_64", version: "v0.80.2",
    online: true, lastSeenAt: 0, implements: [],
  },
  {
    deviceId: "node-galt", kind: "native-device", ownerUid: 1000, ownerUsername: "jessicat",
    label: "node-galt", description: "", platform: "darwin arm64", version: "v0.80.2",
    online: false, lastSeenAt: 0, implements: [],
  },
];

const MOCK_ADAPTER_ACCOUNT: ConsoleAdapterAccount = {
  adapter: "telegram", accountId: "tg-0", connected: true, authenticated: true,
  mode: "bot", lastActivity: null, error: "", extra: {},
};

const MOCK_ADAPTER_INVENTORY: ConsoleAdapter[] = [
  {
    adapter: "telegram", available: true, supportsConnect: true, supportsDisconnect: true,
    supportsSend: true, supportsStatus: true, supportsShellExec: false, supportsActivity: true,
    accounts: [MOCK_ADAPTER_ACCOUNT],
  },
];

const MOCK_MCP_SERVERS: ConsoleMcpServer[] = [
  {
    serverId: "mcp-github", uid: 1000, name: "github", url: "https://mcp.github.dev/sse",
    transport: "sse", state: "ready", authUrl: "", error: "", instructions: "",
    capabilities: null, tools: [], resourceCount: 4, promptCount: 2, createdAt: null, updatedAt: null,
  },
];

const MOCK_PACKAGES: ConsolePackage[] = [
  {
    packageId: "notes", name: "notes", description: "Notebook application", version: "1.0.0",
    runtime: "web-ui", enabled: true, scopeKind: "user", scopeUid: 1000, sourceRepo: "",
    sourceRef: "", sourceSubdir: "", sourcePublic: true, reviewRequired: false, reviewApprovedAt: null,
    reviewPending: false, installedAt: null, updatedAt: null, bindingNames: [], entrypoints: [],
    uiEntrypoints: [{ name: "main", kind: "web", description: "", route: "/notes", command: "", syscalls: [] }],
    profiles: [],
  },
];

const MOCK_CONFIG: ConsoleConfigEntry[] = [
  { key: "config/server/name", value: "gsv-prime", redacted: false },
  { key: "config/server/timezone", value: "UTC", redacted: false },
  { key: "config/shell/network_enabled", value: "true", redacted: false },
  { key: "config/ai/model", value: "claude-opus-4-8", redacted: false },
  { key: "config/ai/provider", value: "anthropic", redacted: false },
];

const MOCK_OVERVIEW_DATA: ConsoleOverviewData = {
  loadedAt: 0,
  processes: MOCK_PROCESSES,
  targets: MOCK_TARGETS,
  packages: MOCK_PACKAGES,
  accounts: MOCK_ACCOUNTS,
  adapterInventory: MOCK_ADAPTER_INVENTORY,
  adapters: [MOCK_ADAPTER_ACCOUNT],
  mcpServers: MOCK_MCP_SERVERS,
  config: MOCK_CONFIG,
};

function DashboardPreview() {
  return (
    <ConsoleViewport>
      <ConsolePage flush>
        <SettingsOverviewDashboard counts={null} data={MOCK_OVERVIEW_DATA} />
      </ConsolePage>
    </ConsoleViewport>
  );
}

// ── AUTH ─────────────────────────────────────────────────────────────────────
function AuthPreview() {
  return (
    <div style={{ position: "relative", height: "100vh", overflow: "hidden" }}>
      <AuthLayout background="galaxy">
        <div
          style={{
            width: "min(360px, 78%)",
            background: "color-mix(in srgb, var(--panel) 100%, #ffffff 5%)",
            border: "1px solid var(--border)",
            padding: "32px 28px",
            fontFamily: "var(--gsv-font-mono)",
          }}
        >
          <div class="gsv-title" style={{ letterSpacing: "0.22em", color: "var(--text-hi)" }}>SIGN IN</div>
          <div class="gsv-sublabel" style={{ letterSpacing: "0.06em", color: "var(--text-dim)", marginTop: "10px" }}>
            Authenticate to board the GSV.
          </div>
          <div
            style={{
              marginTop: "26px", height: "40px", border: "1px solid var(--border-raised)",
              background: "var(--panel-2)", display: "flex", alignItems: "center", padding: "0 12px",
            }}
          >
            <span class="gsv-sublabel" style={{ color: "var(--text-dim)", letterSpacing: "0.1em" }}>USERNAME</span>
          </div>
          <div
            style={{
              marginTop: "14px", height: "40px", border: "1px solid var(--border-raised)",
              background: "var(--panel-2)", display: "flex", alignItems: "center", padding: "0 12px",
            }}
          >
            <span class="gsv-sublabel" style={{ color: "var(--text-dim)", letterSpacing: "0.1em" }}>PASSWORD</span>
          </div>
          <div
            style={{
              marginTop: "24px", height: "40px", background: "var(--selected)",
              border: "1px solid var(--accent)", display: "flex", alignItems: "center", justifyContent: "center",
            }}
          >
            <span class="gsv-sublabel" style={{ color: "var(--accent-bright)", letterSpacing: "0.2em" }}>ENTER</span>
          </div>
        </div>
      </AuthLayout>
    </div>
  );
}

// ── Registry ─────────────────────────────────────────────────────────────────
export const PREVIEWS: Record<string, { title: string; render: () => ComponentChildren }> = {
  list: { title: "List", render: () => <ListPreview /> },
  "card-list": { title: "Card list", render: () => <CardListPreview /> },
  detail: { title: "Detail", render: () => <DetailPreview /> },
  editor: { title: "Editor", render: () => <EditorPreview /> },
  dashboard: { title: "Dashboard", render: () => <DashboardPreview /> },
  auth: { title: "Auth", render: () => <AuthPreview /> },
};

/** Full-viewport route target for /design/preview/<id>. Renders the live
 *  archetype preview, or a small fallback for an unknown id. */
export function TemplatePreview({ id }: { id: string }) {
  const entry = PREVIEWS[id];
  if (!entry) {
    return (
      <div
        style={{
          minHeight: "100vh", background: "var(--void)", color: "var(--text-dim)",
          fontFamily: "var(--gsv-font-mono)", display: "flex", alignItems: "center",
          justifyContent: "center", letterSpacing: "0.14em", textTransform: "uppercase",
          fontSize: "0.75rem", padding: "40px",
        }}
      >
        Unknown preview: {id}
      </div>
    );
  }
  return <>{entry.render()}</>;
}
