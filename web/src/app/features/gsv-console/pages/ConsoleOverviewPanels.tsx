import { AsciiPlanet } from "../../../components/ui/AsciiPlanet";
import { ControlPanelCall } from "../../../components/ui/ControlPanelCall";
import { DataCard, type DataCardRow } from "../../../components/ui/DataCard";
import { ListCard, type ListCardRow } from "../../../components/ui/ListCard";
import { OBJECT_GLYPH_ICON } from "../../../components/ui/objectGlyph";
import { SectionHeader } from "../../../components/ui/SectionHeader";
import type { StatusTone } from "../../../components/ui/StatusDot";
import type { TagTone } from "../../../components/ui/Tag";
import {
  configValueForKey,
  effectiveAiValuesForViewer,
  modelDisplayName,
  modelProfilesForConfig,
  viewerAccountForSettings,
} from "../domain/consoleSettings";
import {
  type AgentApprovalAction,
  behaviorForAccount,
  parseApprovalPolicy,
} from "../domain/consoleAgentBehavior";
import { overrideConfigCount } from "../domain/consoleAi";
import { useConsoleAgentContext } from "../hooks/useConsoleData";
import type { ConsoleListKind } from "../domain/consoleListTypes";
import {
  avatarForAccount,
  isConsoleAgentAccount,
  orderedCrewAccounts,
} from "../domain/agentPresentation";
import type {
  ConsoleAccount,
  ConsoleAdapter,
  ConsoleAdapterAccount,
  ConsoleConfigEntry,
  ConsoleMcpServer,
  ConsoleOverviewCounts,
  ConsoleOverviewData,
  ConsoleProcess,
  ConsoleTarget,
} from "../domain/consoleModels";
import { consoleWorkProcesses } from "../domain/consoleProcesses";
import type { ShellSurfaceId } from "../../gsv-shell/domain/shellModel";
import {
  processSub,
  statusForProcess,
  toneForProcess,
} from "../runtime/runtimePresentation";
import {
  type MessengerFamily,
  iconForAdapterName,
  messengerFamilies,
} from "../messengers/messengerPresentation";
import { iconForTarget } from "../machines/machinePresentation";

type OverviewRow = {
  id: string;
  icon?: string;
  label: string;
  meta?: string;
  tone: StatusTone;
  statusLabel?: string;
  tag?: {
    label: string;
    tone: TagTone;
  };
};

type CrewCard = {
  id: string;
  accountUid: number;
  name: string;
  meta: string;
  imageSrc: string;
  tone: StatusTone;
  statusLabel: string;
};

type OverviewSurface = Exclude<ShellSurfaceId, "desktop">;
export type ConsoleOverviewTarget = OverviewSurface | "models" | "model-default" | "new-agent" | "overrides" | "crew-instructions" | "crew-permissions" | "tasks";
export type OpenSurface = (surface: ConsoleOverviewTarget) => void;
export type OpenAgent = (accountUid: number) => void;
export type OpenListDetail = (kind: ConsoleListKind, detailId: string, detailLabel?: string) => void;
export type OpenListCreate = (kind: ConsoleListKind) => void;

function isRunningProcess(process: ConsoleProcess): boolean {
  return process.state === "running" || process.activeRunId !== null;
}

function isQueuedProcess(process: ConsoleProcess): boolean {
  return process.state === "queued" || process.queuedCount > 0;
}

function joinMeta(parts: readonly (number | string | null | undefined | false)[]): string {
  return parts
    .map((part) => typeof part === "number" ? String(part) : part)
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .join(" · ");
}

function clampLabel(value: string, fallback: string): string {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

/** OverviewRow → the ListCard row model, wiring an optional click target. */
function toListCardRow(row: OverviewRow, onClick?: () => void): ListCardRow {
  return {
    id: row.id,
    label: row.label,
    sub: row.meta,
    icon: row.icon,
    status: row.tone,
    statusLabel: row.statusLabel,
    tag: row.tag?.label,
    tagTone: row.tag?.tone,
    onClick,
  };
}

function targetRow(target: ConsoleTarget): OverviewRow {
  return {
    id: target.deviceId,
    // computer glyph for native mac / windows / linux; chrome doticon for
    // browser targets (iconForTarget keys off target.kind).
    icon: iconForTarget(target),
    label: clampLabel(target.label, target.deviceId),
    tone: target.online ? "online" : "idle",
    statusLabel: target.online ? "ONLINE" : "IDLE",
  };
}

function familyRow(family: MessengerFamily): OverviewRow {
  return {
    id: family.adapter,
    icon: iconForAdapterName(family.adapter),
    label: formatTokenLabel(family.adapter),
    tone: family.status.tone,
    statusLabel: family.status.label,
    meta: family.status.tooltip ?? undefined,
  };
}

function integrationRow(server: ConsoleMcpServer): OverviewRow {
  const failed = server.state === "failed" || server.error.trim().length > 0;
  const active = server.state === "authenticating" || server.state === "connecting" || server.state === "connected" || server.state === "discovering";
  const ready = server.state === "ready";
  return {
    id: server.serverId,
    icon: OBJECT_GLYPH_ICON.integrations,
    label: server.name,
    meta: joinMeta([
      server.tools.length ? `${server.tools.length} tools` : undefined,
      server.resourceCount ? `${server.resourceCount} resources` : undefined,
      server.error,
    ]),
    tone: failed ? "error" : ready ? "online" : active ? "warn" : "idle",
    statusLabel: failed ? "ERROR" : active ? "CHECK" : ready ? undefined : "IDLE",
    tag: server.state === "authenticating" ? { label: "SIGN-IN", tone: "warn" } : undefined,
  };
}

function accountStatus(account: ConsoleAccount, processes: readonly ConsoleProcess[]): Pick<CrewCard, "meta" | "statusLabel" | "tone"> {
  const ownedProcesses = consoleWorkProcesses(processes)
    .filter((process) => process.uid === account.uid || process.username === account.username);
  const running = ownedProcesses.some(isRunningProcess);
  const queuedCount = ownedProcesses.filter(isQueuedProcess).length;
  const unknown = ownedProcesses.some((process) => process.state === "unknown");
  const openCount = ownedProcesses.length;

  if (queuedCount > 0) {
    return { meta: `${queuedCount} queued`, statusLabel: "QUEUED", tone: "update" };
  }
  if (running) {
    const openLabel = openCount === 1 ? "1 open work item" : `${openCount} open work items`;
    return { meta: openLabel, statusLabel: "RUNNING", tone: "live" };
  }
  if (unknown) {
    return { meta: "needs review", statusLabel: "UNKNOWN", tone: "warn" };
  }
  return {
    meta: account.runnable ? "idle" : account.relation,
    statusLabel: account.runnable ? "IDLE" : "ACCOUNT",
    tone: "idle",
  };
}

function crewCards(
  accounts: readonly ConsoleAccount[],
  processes: readonly ConsoleProcess[],
  config: readonly ConsoleConfigEntry[],
): CrewCard[] {
  const ordered = orderedCrewAccounts(accounts).filter(isConsoleAgentAccount);
  return ordered.map((account) => ({
    id: String(account.uid),
    accountUid: account.uid,
    imageSrc: avatarForAccount(account, config, accounts),
    name: account.displayName,
    ...accountStatus(account, processes),
  }));
}

function sortTargets(targets: readonly ConsoleTarget[]): ConsoleTarget[] {
  return [...targets].sort((left, right) => Number(right.online) - Number(left.online) || left.label.localeCompare(right.label));
}

function sortMcpServers(servers: readonly ConsoleMcpServer[]): ConsoleMcpServer[] {
  return [...servers].sort((left, right) => {
    const leftError = left.state === "failed" || left.error.trim().length > 0;
    const rightError = right.state === "failed" || right.error.trim().length > 0;
    if (leftError !== rightError) return leftError ? -1 : 1;
    if (left.state === "authenticating" && right.state !== "authenticating") return -1;
    if (left.state !== "authenticating" && right.state === "authenticating") return 1;
    if (left.state === "ready" && right.state !== "ready") return -1;
    if (left.state !== "ready" && right.state === "ready") return 1;
    return left.name.localeCompare(right.name);
  });
}

function formatTokenLabel(value: string): string {
  return value
    .split(/[-_.:/\s]+/g)
    .filter(Boolean)
    .map((part) => part.length <= 3 ? part.toUpperCase() : `${part.slice(0, 1).toUpperCase()}${part.slice(1).toLowerCase()}`)
    .join(" ") || "Unknown";
}

function processPriority(process: ConsoleProcess): number {
  if (process.state === "running") return 0;
  if (isQueuedProcess(process)) return 1;
  if (process.state === "unknown") return 2;
  return 3;
}

function sortProcessesForOverview(processes: readonly ConsoleProcess[]): ConsoleProcess[] {
  return [...processes].sort((left, right) =>
    processPriority(left) - processPriority(right)
    || (right.lastActiveAt ?? right.createdAt ?? 0) - (left.lastActiveAt ?? left.createdAt ?? 0)
    || left.label.localeCompare(right.label)
  );
}

/** Model name without the trailing parameter-size tokens (e.g. "120B", "A12B",
 *  "8x7B", "70M"). Pure version numbers like the "3" in "Nemotron 3" are kept. */
function modelCoreName(value: string): string {
  const full = modelDisplayName(value);
  if (!full) {
    return "";
  }
  const sizeToken = /^a?\d+(?:\.\d+)?(?:x\d+)?[bm]$/i;
  const kept = full.split(" ").filter((token) => !sizeToken.test(token));
  return kept.join(" ") || full;
}

function permissionLabel(permission: AgentApprovalAction): string {
  if (permission === "auto") return "ALWAYS ALLOW";
  if (permission === "deny") return "ALWAYS DENY";
  return "ASK FIRST";
}

function processOverviewRow(process: ConsoleProcess): OverviewRow {
  return {
    id: process.pid,
    icon: "list",
    label: process.label,
    meta: processSub(process),
    tone: toneForProcess(process),
    statusLabel: statusForProcess(process),
  };
}

// ---------------------------------------------------------------------------
// SPECS + SETTINGS — Data display cards
// ---------------------------------------------------------------------------

function SpecsCard({ config }: { config: readonly ConsoleConfigEntry[] }) {
  const instanceName = configValueForKey(config, "config/server/name") || "gsv";
  const version = configValueForKey(config, "config/server/version");
  const timezone = configValueForKey(config, "config/server/timezone") || "UTC";
  const versionValue = version ? `${instanceName} v${version}` : instanceName;

  return (
    <DataCard
      className="gsv-settings-datacard"
      variant="white"
      collapse={{ id: "specs", at: "tablet" }}
      title="SPECS"
      rows={[
        { label: "CURRENT VERSION", value: versionValue },
        { label: "TIMEZONE", value: timezone.toUpperCase() },
      ]}
    />
  );
}

function SettingsCard({
  accounts,
  config,
  onOpenSurface,
}: {
  accounts: readonly ConsoleAccount[];
  config: readonly ConsoleConfigEntry[];
  onOpenSurface?: OpenSurface;
}) {
  const viewer = viewerAccountForSettings(accounts);
  const modelValues = effectiveAiValuesForViewer(config, viewer?.uid);
  const profiles = modelProfilesForConfig(config, viewer?.uid);
  const chatModel = modelCoreName(modelValues["config/ai/model"] ?? "") || "Not configured";
  const savedModels = `${profiles.length} saved model${profiles.length === 1 ? "" : "s"}`;
  const behavior = viewer ? behaviorForAccount(config, viewer.uid, viewer.uid) : null;
  const permission = behavior?.permission ?? "ask";
  // AGENT PERMISSIONS counts the saved approval-policy rules (owned by the CREW
  // permissions editor); RUNTIME counts the config-level overrides (owned by the
  // overrides config surface) — two distinct things, each with its own row + CTA.
  const permissionRules = behavior ? parseApprovalPolicy(behavior.approval).rules.length : 0;
  const runtimeOverrides = overrideConfigCount(config);

  // Real global-instruction state (context.d files), mirroring CrewDefaultsPanel
  // — never the misleading hardcoded "UNDEFINED". Query self-disables with no
  // viewer / while loading, in which case we show a neutral placeholder.
  const context = useConsoleAgentContext(viewer?.username ?? "");
  const contextFilesCount = context.resource.isLoading || context.resource.isUnavailable || context.resource.isError
    ? null
    : context.files.length;
  const instructionsValue = contextFilesCount == null
    ? "—"
    : `${contextFilesCount} FILE${contextFilesCount === 1 ? "" : "S"}`;

  const openModels = onOpenSurface ? () => onOpenSurface("models") : undefined;
  const openCrewPermissions = onOpenSurface ? () => onOpenSurface("crew-permissions") : undefined;
  const openCrewInstructions = onOpenSurface ? () => onOpenSurface("crew-instructions") : undefined;
  const openOverrides = onOpenSurface ? () => onOpenSurface("overrides") : undefined;

  const rows: DataCardRow[] = [
    { label: "CHAT MODEL", value: chatModel, description: savedModels, linkLabel: "manage", onLink: openModels },
    {
      label: "AGENT PERMISSIONS",
      value: permissionLabel(permission),
      description: `${permissionRules} rule${permissionRules === 1 ? "" : "s"}`,
      linkLabel: "manage",
      onLink: openCrewPermissions,
    },
    // Instructions live on the CREW page (GLOBAL INSTRUCTIONS / context.d), so
    // the CTA opens there directly — an "elsewhere" jump, not an in-place edit.
    { label: "AGENT INSTRUCTIONS", value: instructionsValue, linkLabel: "edit files", linkExternal: true, onLink: openCrewInstructions },
    // System / runtime config (tool-approval fallback, network defaults, server
    // runtime) — its own entry point to the overrides config surface.
    {
      label: "RUNTIME",
      value: runtimeOverrides === 0 ? "DEFAULTS" : `${runtimeOverrides} OVERRIDE${runtimeOverrides === 1 ? "" : "S"}`,
      linkLabel: "manage",
      onLink: openOverrides,
    },
  ];

  return (
    <DataCard
      className="gsv-settings-datacard"
      variant="white"
      collapse={{ id: "settings", at: "tablet" }}
      title="SETTINGS"
      rows={rows}
    />
  );
}

// ---------------------------------------------------------------------------
// SHIP STAGE (ascii moon + control panel) — labels stripped
// ---------------------------------------------------------------------------

function ShipStage({ onOpenTerminal }: { onOpenTerminal?: () => void }) {
  return (
    <div class="gsv-settings-ship-visual">
      <div class="gsv-settings-ship-orbit">
        <AsciiPlanet variant="moon" formDuration={3.4} label="GSV ship" />
      </div>
      <div class="gsv-settings-ship-controlpanel">
        <ControlPanelCall onOpen={onOpenTerminal} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CREW + TASKS list cards
// ---------------------------------------------------------------------------

function CrewListCard({
  accounts,
  config,
  onOpenAgent,
  onOpenSurface,
  processes,
}: {
  accounts: readonly ConsoleAccount[];
  config: readonly ConsoleConfigEntry[];
  onOpenAgent?: OpenAgent;
  onOpenSurface?: OpenSurface;
  processes: readonly ConsoleProcess[];
}) {
  const cards = crewCards(accounts, processes, config);
  const agentCount = cards.length;
  const crewMeta = `${agentCount} AGENT${agentCount === 1 ? "" : "S"}`;
  const openCrew = onOpenSurface ? () => onOpenSurface("crew") : undefined;
  const rows: ListCardRow[] = cards.map((card) => ({
    id: card.id,
    label: card.name,
    sub: card.meta,
    avatarSrc: card.imageSrc,
    status: card.tone,
    statusLabel: card.statusLabel,
    onClick: onOpenAgent ? () => onOpenAgent(card.accountUid) : openCrew,
  }));

  return (
    <ListCard
      className="gsv-settings-listcard"
      collapse={{ id: "crew", at: "mobile" }}
      title="CREW"
      meta={crewMeta}
      onOpen={openCrew}
      rows={rows}
      emptyLabel="NO CREW ACCOUNTS"
      addLabel="NEW AGENT"
      onAdd={onOpenSurface ? () => onOpenSurface("new-agent") : undefined}
      onViewAll={openCrew}
    />
  );
}

function TasksListCard({
  counts,
  onOpenListDetail,
  onOpenSurface,
  processes,
}: {
  counts: ConsoleOverviewCounts | null;
  onOpenListDetail?: OpenListDetail;
  onOpenSurface?: OpenSurface;
  processes: readonly ConsoleProcess[];
}) {
  const workProcesses = consoleWorkProcesses(processes);
  const running = counts?.activeProcesses ?? workProcesses.filter(isRunningProcess).length;
  const queued = counts?.queuedProcesses ?? workProcesses.filter(isQueuedProcess).length;
  const errored = workProcesses.filter((process) => process.state === "unknown").length;
  const openTasks = onOpenSurface ? () => onOpenSurface("tasks") : undefined;
  const rows: ListCardRow[] = sortProcessesForOverview(workProcesses).map((process) =>
    toListCardRow(
      processOverviewRow(process),
      onOpenListDetail ? () => onOpenListDetail("tasks", process.pid, process.label) : openTasks,
    ),
  );
  const taskMeta = workProcesses.length === 0
    ? "NO WORK"
    : joinMeta([
        running > 0 ? `${running} RUNNING` : undefined,
        queued > 0 ? `${queued} QUEUED` : undefined,
        errored > 0 ? `${errored} UNKNOWN` : undefined,
        running === 0 && queued === 0 && errored === 0 ? `${workProcesses.length} IDLE` : undefined,
      ]);

  return (
    <ListCard
      className="gsv-settings-listcard"
      collapse={{ id: "tasks", at: "mobile" }}
      title="WORK"
      meta={taskMeta}
      onOpen={openTasks}
      rows={rows}
      emptyLabel="NO WORK"
      onViewAll={openTasks}
    />
  );
}

// ---------------------------------------------------------------------------
// FLEET (machines / messengers / integrations)
// ---------------------------------------------------------------------------

function FleetPanel({
  adapters,
  adapterInventory,
  integrations,
  onOpenListCreate,
  onOpenListDetail,
  onOpenSurface,
  targets,
}: {
  adapters: readonly ConsoleAdapterAccount[];
  adapterInventory: readonly ConsoleAdapter[];
  integrations: readonly ConsoleMcpServer[];
  onOpenListCreate?: OpenListCreate;
  onOpenListDetail?: OpenListDetail;
  onOpenSurface?: OpenSurface;
  targets: readonly ConsoleTarget[];
}) {
  const openList = (surface: ConsoleOverviewTarget) => onOpenSurface ? () => onOpenSurface(surface) : undefined;
  const rowClick = (kind: ConsoleListKind, row: OverviewRow, surface: ConsoleOverviewTarget) => (
    onOpenListDetail ? () => onOpenListDetail(kind, row.id, row.label) : openList(surface)
  );
  const addClick = (kind: ConsoleListKind, surface: ConsoleOverviewTarget) => (
    onOpenListCreate ? () => onOpenListCreate(kind) : openList(surface)
  );

  const machineRows = sortTargets(targets).map((target) => {
    const row = targetRow(target);
    return toListCardRow(row, rowClick("machines", row, "machines"));
  });
  const messengerRows = messengerFamilies(adapters, adapterInventory).map((family) => {
    const row = familyRow(family);
    return toListCardRow(row, rowClick("messengers", row, "messengers"));
  });
  const integrationRows = sortMcpServers(integrations).map((server) => {
    const row = integrationRow(server);
    return toListCardRow(row, rowClick("integrations", row, "integrations"));
  });

  return (
    <section class="gsv-settings-fleet-block">
      {/* FLEET is a grouping label (machines / messengers / integrations) with
          no page of its own — not clickable. */}
      <SectionHeader title="FLEET" className="gsv-settings-action-header" divider />
      <ListCard
        className="gsv-settings-fleet-section"
        collapse={{ id: "machines", at: "mobile" }}
        title="MACHINES"
        meta={String(machineRows.length)}
        onOpen={openList("machines")}
        rows={machineRows}
        emptyLabel="NO MACHINES"
        addLabel="NEW MACHINE"
        onAdd={addClick("machines", "machines")}
        footer={false}
      />
      <ListCard
        className="gsv-settings-fleet-section"
        collapse={{ id: "messengers", at: "mobile" }}
        title="MESSENGERS"
        meta={String(messengerRows.length)}
        onOpen={openList("messengers")}
        rows={messengerRows}
        emptyLabel="NO MESSENGERS"
        footer={false}
      />
      <ListCard
        className="gsv-settings-fleet-section"
        collapse={{ id: "integrations", at: "mobile" }}
        title="INTEGRATIONS"
        meta={String(integrationRows.length)}
        onOpen={openList("integrations")}
        rows={integrationRows}
        emptyLabel="NO INTEGRATIONS"
        addLabel="NEW INTEGRATION"
        onAdd={addClick("integrations", "integrations")}
        footer={false}
      />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export function SettingsOverviewDashboard({
  counts,
  data,
  onOpenAgent,
  onOpenListCreate,
  onOpenListDetail,
  onOpenSurface,
}: {
  counts: ConsoleOverviewCounts | null;
  data: ConsoleOverviewData;
  onOpenAgent?: OpenAgent;
  onOpenListCreate?: OpenListCreate;
  onOpenListDetail?: OpenListDetail;
  onOpenSurface?: OpenSurface;
}) {
  const openTerminal = onOpenSurface ? () => onOpenSurface("terminal") : undefined;

  return (
    <div class="gsv-settings-overview-frame">
      <div class="gsv-settings-overview" aria-label="GSV overview">
        <section class="gsv-settings-ship-block">
          <SectionHeader title="THE SHIP" className="gsv-settings-action-header" divider />
          <div class="gsv-settings-ship-body">
            <div class="gsv-settings-ship-rail">
              <SpecsCard config={data.config} />
              <SettingsCard
                accounts={data.accounts}
                config={data.config}
                onOpenSurface={onOpenSurface}
              />
            </div>
            <ShipStage onOpenTerminal={openTerminal} />
            {/* FILES / LIBRARY / REPOS "ship rooms" section parked in the design
                catalog ("Ship rooms (parked)") until the real wiring lands. */}
            <div class="gsv-settings-ship-lists">
              <CrewListCard
                accounts={data.accounts}
                config={data.config}
                onOpenAgent={onOpenAgent}
                onOpenSurface={onOpenSurface}
                processes={data.processes}
              />
              <TasksListCard
                counts={counts}
                onOpenListDetail={onOpenListDetail}
                onOpenSurface={onOpenSurface}
                processes={data.processes}
              />
            </div>
          </div>
        </section>
        <div class="gsv-settings-fleet-column">
          <FleetPanel
            adapters={data.adapters}
            adapterInventory={data.adapterInventory}
            integrations={data.mcpServers}
            onOpenListCreate={onOpenListCreate}
            onOpenListDetail={onOpenListDetail}
            onOpenSurface={onOpenSurface}
            targets={data.targets}
          />
        </div>
      </div>
    </div>
  );
}
