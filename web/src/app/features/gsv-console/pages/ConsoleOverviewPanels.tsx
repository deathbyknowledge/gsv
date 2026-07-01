import type { ComponentChildren, JSX } from "preact";
import { AddAction } from "../../../components/ui/AddAction";
import { AsciiPlanet } from "../../../components/ui/AsciiPlanet";
import { CrewAddTile, CrewTile } from "../../../components/ui/CrewTile";
import { ListRow, type ListRowStatus } from "../../../components/ui/ListRow";
import { OBJECT_GLYPH_ICON } from "../../../components/ui/objectGlyph";
import { SectionHeader } from "../../../components/ui/SectionHeader";
import { StatusDot, type StatusTone } from "../../../components/ui/StatusDot";
import { Surface } from "../../../components/ui/Surface";
import type { TagTone } from "../../../components/ui/Tag";
import {
  RUNTIME_SETTING_GROUPS,
  TOOL_MODEL_GROUPS,
  configValueForKey,
  effectiveAiValuesForViewer,
  modelDisplayName,
  modelProfilesForConfig,
  viewerAccountForSettings,
} from "../domain/consoleSettings";
import type { ConsoleListKind } from "../domain/consoleListTypes";
import {
  CREW_HUMAN_IMAGE,
  agentImageSrcForIndex,
  isConsoleAgentAccount,
  isHumanCrewAccount,
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
  ConsolePackage,
  ConsoleProcess,
  ConsoleTarget,
} from "../domain/consoleModels";
import type { ShellSurfaceId } from "../../gsv-shell/domain/shellModel";
import { isNativeWebPackageName } from "../../packages/nativePackages";
import {
  processSub,
  statusForProcess,
  toneForProcess,
} from "../runtime/runtimePresentation";
import {
  type MessengerFamily,
  messengerFamilies,
} from "../messengers/messengerPresentation";

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
  cover: boolean;
  tone: StatusTone;
  statusLabel: string;
};

type OverviewSurface = Exclude<ShellSurfaceId, "desktop" | "app">;
export type ConsoleOverviewTarget = OverviewSurface | "models" | "model-default" | "new-agent" | "overrides" | "tasks";
export type OpenSurface = (surface: ConsoleOverviewTarget) => void;
export type OpenAgent = (accountUid: number) => void;
export type OpenListDetail = (kind: ConsoleListKind, detailId: string, detailLabel?: string) => void;
export type OpenListCreate = (kind: ConsoleListKind) => void;

const DASHBOARD_ROW_LIMIT = 5;
const DEEP_CELL_ROW_LIMIT = 6;
const OVERVIEW_ROW_STYLE: JSX.CSSProperties = {
  minHeight: "44px",
  padding: "13px 16px",
};
const OVERVIEW_STATE_ROW_STYLE: JSX.CSSProperties = {
  minHeight: "55px",
  padding: "15px 16px",
};

function listRowStatus(tone: StatusTone): ListRowStatus {
  return tone;
}

function isApplicationPackage(pkg: ConsolePackage): boolean {
  return pkg.runtime === "web-ui" || pkg.uiEntrypoints.length > 0;
}

function isNativeConsolePackage(pkg: ConsolePackage): boolean {
  return isNativeWebPackageName(pkg.name) || isNativeWebPackageName(pkg.packageId);
}

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

function packageStatus(pkg: ConsolePackage): Pick<OverviewRow, "statusLabel" | "tag" | "tone"> {
  if (pkg.reviewPending) {
    return {
      tone: "update",
      statusLabel: "REVIEW",
      tag: { label: "UPDATE", tone: "update" },
    };
  }
  if (pkg.enabled) {
    return { tone: "online", statusLabel: "ONLINE" };
  }
  return { tone: "idle", statusLabel: "IDLE" };
}

function targetRow(target: ConsoleTarget): OverviewRow {
  return {
    id: target.deviceId,
    label: clampLabel(target.label, target.deviceId),
    tone: target.online ? "online" : "idle",
    statusLabel: target.online ? "ONLINE" : "IDLE",
  };
}

function familyRow(family: MessengerFamily): OverviewRow {
  return {
    id: family.adapter,
    icon: family.adapter === "telegram" ? "telegram" : "discord",
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

function applicationRow(pkg: ConsolePackage): OverviewRow {
  const status = packageStatus(pkg);
  return {
    id: pkg.packageId,
    icon: OBJECT_GLYPH_ICON.applications,
    label: pkg.name,
    meta: packageSourceLabel(pkg),
    tone: status.tone,
    tag: status.tag,
  };
}

function accountStatus(account: ConsoleAccount, processes: readonly ConsoleProcess[]): Pick<CrewCard, "meta" | "statusLabel" | "tone"> {
  const ownedProcesses = processes.filter((process) => process.uid === account.uid || process.username === account.username);
  const running = ownedProcesses.some(isRunningProcess);
  const queued = ownedProcesses.some(isQueuedProcess);
  const unknown = ownedProcesses.some((process) => process.state === "unknown");

  if (queued) {
    return { meta: "queued", statusLabel: "QUEUED", tone: "update" };
  }
  if (running) {
    return { meta: "running", statusLabel: "RUNNING", tone: "live" };
  }
  if (unknown) {
    return { meta: "needs review", statusLabel: "UNKNOWN", tone: "warn" };
  }
  return {
    meta: account.runnable ? "runnable" : account.relation,
    statusLabel: account.runnable ? "IDLE" : "ACCOUNT",
    tone: account.runnable ? "idle" : "idle",
  };
}

function crewCards(accounts: readonly ConsoleAccount[], processes: readonly ConsoleProcess[]): CrewCard[] {
  const ordered = orderedCrewAccounts(accounts).slice(0, 3);
  let agentIndex = 0;
  return ordered.map((account) => {
    const human = isHumanCrewAccount(account);
    // Human is shown first, online, with the padded orb; agents get the
    // full-frame portraits.
    const status = human
      ? { meta: "you", statusLabel: "ONLINE", tone: "online" as StatusTone }
      : accountStatus(account, processes);
    return {
      id: String(account.uid),
      accountUid: account.uid,
      imageSrc: human ? CREW_HUMAN_IMAGE : agentImageSrcForIndex(agentIndex++),
      cover: !human,
      name: account.displayName,
      ...status,
    };
  });
}

function sortTargets(targets: readonly ConsoleTarget[]): ConsoleTarget[] {
  return [...targets].sort((left, right) => Number(right.online) - Number(left.online) || left.label.localeCompare(right.label));
}

function sortPackages(packages: readonly ConsolePackage[]): ConsolePackage[] {
  return [...packages].sort((left, right) => {
    if (left.reviewPending !== right.reviewPending) return left.reviewPending ? -1 : 1;
    if (left.enabled !== right.enabled) return left.enabled ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
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

function packageSourceLabel(pkg: ConsolePackage): string {
  const sourceParts = pkg.sourceRepo.split(/[/:]/g).filter(Boolean);
  const source = sourceParts[sourceParts.length - 1] ?? "";
  return joinMeta([source, pkg.version ? `v${pkg.version}` : "", pkg.scopeKind === "unknown" ? "" : pkg.scopeKind.toUpperCase()]);
}

function rowLimit<T>(rows: readonly T[], limit = DASHBOARD_ROW_LIMIT): readonly T[] {
  return rows.slice(0, limit);
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

function shipInventoryLabel(data: ConsoleOverviewData): string {
  if (data.targets.length > 0) {
    const online = data.targets.filter((target) => target.online).length;
    return `${online}/${data.targets.length} TARGETS`;
  }
  if (data.processes.length > 0) {
    return `${data.processes.length} ${data.processes.length === 1 ? "PROCESS" : "PROCESSES"}`;
  }
  if (data.accounts.length > 0) {
    const runnable = data.accounts.filter((account) => account.runnable).length;
    return `${runnable}/${data.accounts.length} CREW`;
  }
  return "NO INVENTORY";
}

function MiniHeading({
  title,
  meta,
  metaWord,
  onClick,
  showChevron = Boolean(onClick),
}: {
  title: string;
  meta?: string;
  metaWord?: string;
  onClick?: () => void;
  showChevron?: boolean;
}) {
  return (
    <SectionHeader
      chevron={showChevron}
      className="gsv-settings-mini-heading"
      density="compact"
      divider
      meta={meta}
      metaWord={metaWord}
      onClick={onClick}
      title={title}
    />
  );
}

function MiniRow({ row, showIcon = true, onClick }: { row: OverviewRow; showIcon?: boolean; onClick?: () => void }) {
  const hasIcon = showIcon && Boolean(row.icon);

  return (
    <ListRow
      chevron={Boolean(onClick)}
      className="gsv-settings-mini-row"
      icon={hasIcon ? row.icon : undefined}
      iconTitle={row.label}
      label={row.label}
      onClick={onClick}
      status={listRowStatus(row.tone)}
      statusDotPlacement={hasIcon ? "trailing" : "leading"}
      statusLabel={row.statusLabel}
      style={OVERVIEW_ROW_STYLE}
      sub={row.meta}
      tag={row.tag?.label}
      tagTone={row.tag?.tone}
    />
  );
}

function EmptyRow({ label }: { label: string }) {
  return (
    <div class="gsv-settings-empty-row gsv-sublabel">
      <StatusDot tone="idle" size={7} />
      <span>{label}</span>
    </div>
  );
}

function AddRow({ label, onClick }: { label: string; onClick?: () => void }) {
  return (
    <div class="gsv-settings-add-action">
      <AddAction label={label} onClick={onClick} variant="row" />
    </div>
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

function modelValueForGroup(values: Record<string, string>, groupId: string): string {
  const group = TOOL_MODEL_GROUPS.find((candidate) => candidate.id === groupId);
  const modelField = group?.fields.find((field) => field.key.endsWith("/model"));
  return modelField ? values[modelField.key] ?? "" : "";
}

function overviewModelRows(
  values: Record<string, string>,
  otherConfigured: number,
  otherTotal: number,
  profileCount: number,
): OverviewRow[] {
  const agentModel = values["config/ai/model"] ?? "";
  const provider = (values["config/ai/provider"] ?? "").trim();
  return [
    {
      id: "default-agent-model",
      icon: "stars",
      // Inverted: the model name is the primary (white) label, the provider name
      // is the dim (blue) sub beneath it.
      label: modelCoreName(agentModel) || "Not configured",
      meta: provider ? formatTokenLabel(provider) : "Default Model",
      tone: agentModel ? "online" : "idle",
      statusLabel: agentModel ? "DEFAULT" : "EMPTY",
    },
    {
      // Collapsed: "Other Models" with the configured count on the right and the
      // preset count as the dim sub line.
      id: "other-models",
      icon: "stars",
      label: "Other Models",
      meta: profileCount === 0
        ? "No model presets"
        : `${profileCount} model preset${profileCount === 1 ? "" : "s"}`,
      tone: otherConfigured > 0 ? "online" : "idle",
      statusLabel: `${otherConfigured}/${otherTotal}`,
    },
  ];
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

function SplitCells({
  className = "",
  left,
  right,
}: {
  className?: string;
  left: ComponentChildren;
  right: ComponentChildren;
}) {
  return (
    <div class={`gsv-settings-split${className ? ` ${className}` : ""}`}>
      <div>{left}</div>
      <div>{right}</div>
    </div>
  );
}

function ActionSectionHeader({
  meta,
  onClick,
  title,
}: {
  meta?: string;
  onClick?: () => void;
  title: string;
}) {
  return (
    <SectionHeader
      chevron={Boolean(onClick)}
      className="gsv-settings-action-header"
      divider
      meta={meta}
      onClick={onClick}
      title={title}
    />
  );
}

function ShipPanel({
  config,
  data,
  onOpenSurface,
}: {
  config: readonly ConsoleConfigEntry[];
  data: ConsoleOverviewData;
  onOpenSurface?: OpenSurface;
}) {
  const runtimeFields = RUNTIME_SETTING_GROUPS.flatMap((group) => group.fields);
  const configured = runtimeFields.filter((field) =>
    field.kind !== "readonly" && configValueForKey(config, field.key).trim().length > 0
  ).length;
  const networkEnabled = configValueForKey(config, "config/shell/network_enabled") === "true";
  const instanceName = configValueForKey(config, "config/server/name") || "gsv";
  const timezone = configValueForKey(config, "config/server/timezone") || "UTC";

  return (
    <section class="gsv-settings-block gsv-settings-ship-block">
      <SectionHeader title="THE SHIP" divider />
      <div class="gsv-settings-ship-visual">
        <div class="gsv-settings-ship-orbit">
          <AsciiPlanet variant="moon" formDuration={3.4} label="GSV ship scan" />
        </div>
        <span class="gsv-settings-scan gsv-sublabel">{shipInventoryLabel(data)}</span>
        <span class="gsv-settings-ship-id gsv-sublabel">GSV</span>
      </div>
      <SplitCells
        left={(
          <div class="gsv-settings-mini-cell">
            <MiniHeading title="INSTANCE" />
            <ListRow
              label={instanceName}
              status="none"
              style={OVERVIEW_STATE_ROW_STYLE}
              tag={timezone}
              tagTone="info"
            />
          </div>
        )}
        right={(
          <div class="gsv-settings-mini-cell">
            <MiniHeading
              title="RUNTIME"
              onClick={onOpenSurface ? () => onOpenSurface("overrides") : undefined}
            />
            <ListRow
              chevron={Boolean(onOpenSurface)}
              className="gsv-settings-overrides-state"
              label={`${configured} SETTINGS`}
              onClick={onOpenSurface ? () => onOpenSurface("overrides") : undefined}
              status="none"
              style={OVERVIEW_STATE_ROW_STYLE}
              tag={networkEnabled ? "NETWORK ON" : "NETWORK OFF"}
              tagTone={networkEnabled ? "online" : "idle"}
            />
          </div>
        )}
      />
    </section>
  );
}

function CrewPanel({
  accounts,
  onOpenAgent,
  onOpenSurface,
  processes,
}: {
  accounts: readonly ConsoleAccount[];
  onOpenAgent?: OpenAgent;
  onOpenSurface?: OpenSurface;
  processes: readonly ConsoleProcess[];
}) {
  const cards = crewCards(accounts, processes);
  const humanCount = accounts.filter(isHumanCrewAccount).length;
  const agentCount = accounts.filter(isConsoleAgentAccount).length;
  const crewMeta = `${humanCount} HUMAN${humanCount === 1 ? "" : "S"} / ${agentCount} AGENT${agentCount === 1 ? "" : "S"}`;

  return (
    <section class="gsv-settings-block gsv-settings-crew-block">
      <ActionSectionHeader
        title="CREW"
        meta={crewMeta}
        onClick={onOpenSurface ? () => onOpenSurface("crew") : undefined}
      />
      <div class="gsv-settings-crew-grid">
        {cards.length === 0 ? <EmptyRow label="NO CREW ACCOUNTS" /> : cards.map((card) => (
          <CrewTile
            cover={card.cover}
            imageSrc={card.imageSrc}
            key={card.id}
            name={card.name}
            onClick={onOpenAgent
              ? () => onOpenAgent(card.accountUid)
              : onOpenSurface
                ? () => onOpenSurface("crew")
                : undefined}
            statusLabel={card.statusLabel}
            tone={card.tone}
          />
        ))}
        <CrewAddTile
          label="NEW AGENT"
          onClick={onOpenSurface ? () => onOpenSurface("new-agent") : undefined}
        />
      </div>
    </section>
  );
}

function ModelsTasksPanel({
  accounts,
  config,
  counts,
  onOpenListDetail,
  onOpenSurface,
  processes,
}: {
  accounts: readonly ConsoleAccount[];
  config: readonly ConsoleConfigEntry[];
  counts: ConsoleOverviewCounts | null;
  onOpenListDetail?: OpenListDetail;
  onOpenSurface?: OpenSurface;
  processes: readonly ConsoleProcess[];
}) {
  const running = counts?.activeProcesses ?? processes.filter(isRunningProcess).length;
  const queued = counts?.queuedProcesses ?? processes.filter(isQueuedProcess).length;
  const errored = processes.filter((process) => process.state === "unknown").length;
  const viewer = viewerAccountForSettings(accounts);
  const modelValues = effectiveAiValuesForViewer(config, viewer?.uid);
  const profiles = modelProfilesForConfig(config, viewer?.uid);
  const defaultModelSet = (modelValues["config/ai/model"] ?? "").trim().length > 0;
  const otherModelsTotal = TOOL_MODEL_GROUPS.length;
  const otherModelsConfigured = TOOL_MODEL_GROUPS.filter(
    (group) => modelValueForGroup(modelValues, group.id).trim().length > 0,
  ).length;
  const modelRows = overviewModelRows(modelValues, otherModelsConfigured, otherModelsTotal, profiles.length);
  const configuredModels = (defaultModelSet ? 1 : 0) + otherModelsConfigured;
  const totalModels = 1 + otherModelsTotal;
  const visibleProcesses = rowLimit(sortProcessesForOverview(processes), DEEP_CELL_ROW_LIMIT);
  const openModels = onOpenSurface ? () => onOpenSurface("models") : undefined;
  const openDefaultModel = onOpenSurface ? () => onOpenSurface("model-default") : undefined;
  const openTasks = onOpenSurface ? () => onOpenSurface("tasks") : undefined;
  const openTaskDetail = (process: ConsoleProcess) => (
    onOpenListDetail
      ? () => onOpenListDetail("tasks", process.pid, process.label)
      : openTasks
  );
  const taskMeta = processes.length === 0
    ? "NO TASKS"
    : joinMeta([
        running > 0 ? `${running} RUNNING` : undefined,
        queued > 0 ? `${queued} QUEUED` : undefined,
        errored > 0 ? `${errored} UNKNOWN` : undefined,
        running === 0 && queued === 0 && errored === 0 ? `${processes.length} IDLE` : undefined,
      ]);

  return (
    <SplitCells
      className="gsv-settings-model-task-split"
      left={(
        <Surface class="gsv-settings-deep-cell" flush>
          <MiniHeading
            title="MODELS"
            meta={`${configuredModels}/${totalModels}`}
            metaWord="CONFIGURED"
            onClick={openModels}
          />
          <div class="gsv-settings-overview-list">
            {rowLimit(modelRows, DEEP_CELL_ROW_LIMIT).map((row) => (
              <MiniRow
                key={row.id}
                row={row}
                onClick={row.id === "default-agent-model" ? openDefaultModel : openModels}
              />
            ))}
          </div>
        </Surface>
      )}
      right={(
        <Surface class="gsv-settings-deep-cell" flush>
          <MiniHeading
            title="TASKS"
            meta={taskMeta}
            onClick={openTasks}
          />
          <div class="gsv-settings-overview-list">
            {visibleProcesses.length === 0 ? <EmptyRow label="NO TASKS" /> : visibleProcesses.map((process) => (
              <MiniRow
                key={process.pid}
                row={processOverviewRow(process)}
                onClick={openTaskDetail(process)}
              />
            ))}
          </div>
        </Surface>
      )}
    />
  );
}

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
  const targetRows = sortTargets(targets).map(targetRow);
  const adapterRows = messengerFamilies(adapters, adapterInventory).map(familyRow);
  const integrationRows = sortMcpServers(integrations).map(integrationRow);
  const openList = (surface: ConsoleOverviewTarget) => onOpenSurface ? () => onOpenSurface(surface) : undefined;
  const openDetail = (kind: ConsoleListKind, row: OverviewRow, surface: ConsoleOverviewTarget) => (
    onOpenListDetail ? () => onOpenListDetail(kind, row.id, row.label) : openList(surface)
  );
  const openCreate = (kind: ConsoleListKind, surface: ConsoleOverviewTarget) => (
    onOpenListCreate ? () => onOpenListCreate(kind) : openList(surface)
  );

  return (
    <section class="gsv-settings-block gsv-settings-fleet-block">
      {/* FLEET is a grouping label (machines / messengers / integrations) with
          no page of its own — not clickable. */}
      <ActionSectionHeader title="FLEET" />
      <MiniHeading
        title="MACHINES"
        onClick={openList("machines")}
      />
      <div class="gsv-settings-section-rows">
        {targetRows.length === 0 ? <EmptyRow label="NO MACHINES" /> : rowLimit(targetRows, 3).map((row) => (
          <MiniRow key={row.id} row={row} showIcon={false} onClick={openDetail("machines", row, "machines")} />
        ))}
        <AddRow label="CONNECT NEW MACHINE" onClick={openCreate("machines", "machines")} />
      </div>
      <SplitCells
        left={(
          <div class="gsv-settings-mini-cell">
            <MiniHeading
              title="MESSENGERS"
              onClick={openList("messengers")}
            />
            {rowLimit(adapterRows, 3).map((row) => (
              <MiniRow key={row.id} row={row} onClick={openDetail("messengers", row, "messengers")} />
            ))}
          </div>
        )}
        right={(
          <div class="gsv-settings-mini-cell">
            <MiniHeading
              title="INTEGRATIONS"
              onClick={openList("integrations")}
            />
            {integrationRows.length === 0 ? <EmptyRow label="NO INTEGRATIONS" /> : rowLimit(integrationRows, 2).map((row) => (
              <MiniRow key={row.id} row={row} onClick={openDetail("integrations", row, "integrations")} />
            ))}
            <AddRow label="NEW INTEGRATION" onClick={openCreate("integrations", "integrations")} />
          </div>
        )}
      />
    </section>
  );
}

function ApplicationsPanel({
  applications,
  onOpenListCreate,
  onOpenListDetail,
  onOpenSurface,
}: {
  applications: readonly ConsolePackage[];
  onOpenListCreate?: OpenListCreate;
  onOpenListDetail?: OpenListDetail;
  onOpenSurface?: OpenSurface;
}) {
  const rows = sortPackages(applications).map(applicationRow);
  const openList = onOpenSurface ? () => onOpenSurface("applications") : undefined;
  const openDetail = (row: OverviewRow) => (
    onOpenListDetail ? () => onOpenListDetail("applications", row.id, row.label) : openList
  );
  const openCreate = onOpenListCreate
    ? () => onOpenListCreate("applications")
    : openList;

  return (
    <section class="gsv-settings-block gsv-settings-applications-block">
      <ActionSectionHeader
        title="APPLICATIONS"
        onClick={openList}
      />
      <div class="gsv-settings-section-rows">
        {rows.length === 0 ? <EmptyRow label="NO APPLICATIONS" /> : rowLimit(rows, 5).map((row) => (
          <MiniRow key={row.id} row={row} onClick={openDetail(row)} />
        ))}
        <AddRow label="NEW APPLICATION" onClick={openCreate} />
      </div>
    </section>
  );
}

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
  const visiblePackages = data.packages.filter((pkg) => !isNativeConsolePackage(pkg));
  const applications = visiblePackages.filter(isApplicationPackage);

  return (
    <div class="gsv-settings-overview-frame">
      <div class="gsv-settings-overview" aria-label="GSV settings overview">
        <div class="gsv-settings-left">
        <ShipPanel
          config={data.config}
          data={data}
          onOpenSurface={onOpenSurface}
        />
        <CrewPanel
          accounts={data.accounts}
          onOpenAgent={onOpenAgent}
          onOpenSurface={onOpenSurface}
          processes={data.processes}
        />
        <ModelsTasksPanel
          accounts={data.accounts}
          config={data.config}
          counts={counts}
          onOpenListDetail={onOpenListDetail}
          onOpenSurface={onOpenSurface}
          processes={data.processes}
        />
      </div>
      <div class="gsv-settings-right">
        <FleetPanel
          adapters={data.adapters}
          adapterInventory={data.adapterInventory}
          integrations={data.mcpServers}
          onOpenListCreate={onOpenListCreate}
          onOpenListDetail={onOpenListDetail}
          onOpenSurface={onOpenSurface}
          targets={data.targets}
        />
        <ApplicationsPanel
          applications={applications}
          onOpenListCreate={onOpenListCreate}
          onOpenListDetail={onOpenListDetail}
          onOpenSurface={onOpenSurface}
        />
      </div>
      </div>
    </div>
  );
}
