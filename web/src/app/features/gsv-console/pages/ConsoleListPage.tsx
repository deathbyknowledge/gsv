import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { AddAction } from "../../../components/ui/AddAction";
import { ListRow, type ListRowStatus } from "../../../components/ui/ListRow";
import { SectionHeader } from "../../../components/ui/SectionHeader";
import type { StatusTone } from "../../../components/ui/StatusDot";
import type { TagTone } from "../../../components/ui/Tag";
import { isNativeWebPackageName } from "../../packages/nativePackages";
import {
  useConsoleAdapters,
  useConsolePackages,
  useConsoleProcesses,
  useConsoleTargets,
} from "../hooks/useConsoleData";
import type {
  ConsoleAdapterAccount,
  ConsolePackage,
  ConsoleProcess,
  ConsoleResourceState,
  ConsoleTarget,
} from "../domain/consoleModels";
import {
  ConsolePage,
  ConsoleResourceBoundary,
} from "../components/ConsolePageTemplate";
import {
  ConsoleDetailPage,
  type ConsoleDetailRow,
  type ConsoleDetailSection,
} from "../components/ConsoleDetailPage";
import "./ConsoleListPage.css";

export type ConsoleListKind = "machines" | "library" | "tasks" | "messengers" | "integrations" | "applications";
type PackageListKind = "library" | "integrations" | "applications";

type ConsoleListPageProps = {
  initialCreate?: boolean;
  initialDetailId?: string | null;
  initialDetailLabel?: string | null;
  kind: ConsoleListKind;
  onSelectionChange?: (selection: ConsoleListSelection | null) => void;
};

type SelectedConsoleDetail = {
  createNew?: boolean;
  label?: string;
  kind: ConsoleListKind;
  id: string;
};

export type ConsoleListSelection = {
  createNew?: boolean;
  detailId?: string;
  detailLabel?: string;
};

type RowTag = {
  label: string;
  tone: TagTone;
};

type SettingsListRow = {
  id: string;
  icon: string;
  label: string;
  sub: string;
  tone: StatusTone;
  statusLabel: string;
  tag?: RowTag;
  onOpen?: () => void;
};

type SettingsListAction = {
  label: string;
  onClick?: () => void;
};

type SettingsListPanelProps = {
  title: string;
  meta: string;
  rows: readonly SettingsListRow[];
  emptyLabel: string;
  action?: SettingsListAction;
};

type EntityDetailPageProps = {
  icon: string;
  title: string;
  typeLabel: string;
  statusLabel: string;
  tone: StatusTone;
  blurb: string;
  parentLabel: string;
  pendingLabel?: string;
  primaryLabel: string;
  sections?: readonly ConsoleDetailSection[];
  onBack: () => void;
};

const EMPTY_RESOURCE_LABEL: Record<ConsoleListKind, string> = {
  machines: "NO MACHINES",
  library: "NO PACKAGES",
  tasks: "NO PROCESSES",
  messengers: "NO MESSENGERS",
  integrations: "NO INTEGRATIONS",
  applications: "NO APPLICATIONS",
};

const NEW_DETAIL_ID = "__new__";

export function ConsoleListPage({
  initialCreate = false,
  initialDetailId = null,
  initialDetailLabel = null,
  kind,
  onSelectionChange,
}: ConsoleListPageProps) {
  const [selectedDetail, setSelectedDetail] = useState<SelectedConsoleDetail | null>(null);
  const targets = useConsoleTargets({ enabled: kind === "machines" });
  const packageKind = isPackageListKind(kind) ? kind : null;
  const packages = useConsolePackages({ enabled: packageKind !== null });
  const processes = useConsoleProcesses({ enabled: kind === "tasks" });
  const adapters = useConsoleAdapters({ enabled: kind === "messengers" });

  useEffect(() => {
    if (initialCreate) {
      setSelectedDetail({ kind, id: NEW_DETAIL_ID, createNew: true });
      return;
    }
    setSelectedDetail(initialDetailId ? { kind, id: initialDetailId, label: initialDetailLabel ?? undefined } : null);
  }, [kind, initialCreate, initialDetailId, initialDetailLabel]);

  const selectDetail = (detail: SelectedConsoleDetail | null) => {
    setSelectedDetail(detail);
    if (!onSelectionChange) {
      return;
    }
    if (!detail) {
      onSelectionChange(null);
      return;
    }
    if (detail.createNew) {
      onSelectionChange({ createNew: true });
      return;
    }
    onSelectionChange({ detailId: detail.id, detailLabel: detail.label });
  };

  if (kind === "tasks") {
    return (
      <ConsolePage flush>
        <ConsoleResourceBoundary
          resource={resourceWithLocalEmptyState(processes.resource)}
          emptyLabel={EMPTY_RESOURCE_LABEL.tasks}
          errorLabel="RUNTIME"
          render={(data) => (
            selectedDetail?.kind === "tasks"
              ? renderProcessDetail(data, selectedDetail.id, () => selectDetail(null)) ?? (
                <RuntimeConsoleSection
                  onOpenDetail={(process) => selectDetail({ kind, id: process.pid, label: process.label })}
                  processes={data}
                  refreshing={processes.resource.isRefreshing}
                />
              )
              : (
                <RuntimeConsoleSection
                  onOpenDetail={(process) => selectDetail({ kind, id: process.pid, label: process.label })}
                  processes={data}
                  refreshing={processes.resource.isRefreshing}
                />
              )
          )}
        />
      </ConsolePage>
    );
  }

  if (kind === "machines") {
    return (
      <ConsolePage flush>
        <ConsoleResourceBoundary
          resource={resourceWithLocalEmptyState(targets.resource)}
          emptyLabel={EMPTY_RESOURCE_LABEL.machines}
          errorLabel="MACHINES"
          render={(data) => (
            selectedDetail?.kind === "machines"
              ? (selectedDetail.createNew
                ? renderNewEntityDetail("machines", () => selectDetail(null))
                : renderTargetDetail(data, selectedDetail.id, () => selectDetail(null))) ?? (
                <MachinesConsoleSection
                  onOpenCreate={() => selectDetail({ kind, id: NEW_DETAIL_ID, createNew: true })}
                  onOpenDetail={(target) => selectDetail({ kind, id: target.deviceId, label: target.label })}
                  targets={data}
                  refreshing={targets.resource.isRefreshing}
                />
              )
              : (
                <MachinesConsoleSection
                  onOpenCreate={() => selectDetail({ kind, id: NEW_DETAIL_ID, createNew: true })}
                  onOpenDetail={(target) => selectDetail({ kind, id: target.deviceId, label: target.label })}
                  targets={data}
                  refreshing={targets.resource.isRefreshing}
                />
              )
          )}
        />
      </ConsolePage>
    );
  }

  if (kind === "messengers") {
    return (
      <ConsolePage flush>
        <ConsoleResourceBoundary
          resource={resourceWithLocalEmptyState(adapters.resource)}
          emptyLabel={EMPTY_RESOURCE_LABEL.messengers}
          errorLabel="MESSENGERS"
          render={(data) => (
            selectedDetail?.kind === "messengers"
              ? renderAdapterDetail(data, selectedDetail.id, () => selectDetail(null)) ?? (
                <MessengersConsoleSection
                  adapters={data}
                  onOpenDetail={(adapter) => selectDetail({ kind, id: adapterDetailId(adapter), label: adapterLabel(adapter) })}
                  refreshing={adapters.resource.isRefreshing}
                />
              )
              : (
                <MessengersConsoleSection
                  adapters={data}
                  onOpenDetail={(adapter) => selectDetail({ kind, id: adapterDetailId(adapter), label: adapterLabel(adapter) })}
                  refreshing={adapters.resource.isRefreshing}
                />
              )
          )}
        />
      </ConsolePage>
    );
  }

  return (
    <ConsolePage flush>
      <ConsoleResourceBoundary
        resource={resourceWithLocalEmptyState(packages.resource)}
        emptyLabel={EMPTY_RESOURCE_LABEL[packageKind ?? "library"]}
        errorLabel={packageKind === "applications" ? "APPLICATIONS" : packageKind === "integrations" ? "INTEGRATIONS" : "LIBRARY"}
        render={(data) => (
          renderPackageList(
            filterPackagesForKind(data, packageKind ?? "library"),
            packageKind ?? "library",
            selectedDetail,
            () => selectDetail(null),
            packageKind === "integrations" || packageKind === "applications"
              ? () => selectDetail({ kind, id: NEW_DETAIL_ID, createNew: true })
              : undefined,
            (pkg) => selectDetail({ kind, id: pkg.packageId, label: pkg.name }),
            packages.resource.isRefreshing,
          )
        )}
      />
    </ConsolePage>
  );
}

function isPackageListKind(kind: ConsoleListKind): kind is PackageListKind {
  return kind === "library" || kind === "integrations" || kind === "applications";
}

function renderProcessDetail(
  processes: readonly ConsoleProcess[],
  id: string,
  onBack: () => void,
): ComponentChildren | null {
  const process = processes.find((entry) => entry.pid === id);
  if (!process) {
    return null;
  }

  return (
    <ConsoleEntityDetailPage
      icon="list"
      title={process.label}
      typeLabel="GSV · TASK"
      statusLabel={statusForProcess(process)}
      tone={toneForProcess(process)}
      blurb={compactText([process.username, process.profile, process.cwd], "Process runtime state and active conversation context.")}
      parentLabel="RUNTIME"
      primaryLabel="SAVE CHANGES"
      sections={processDetailSections(process)}
      onBack={onBack}
    />
  );
}

function renderTargetDetail(
  targets: readonly ConsoleTarget[],
  id: string,
  onBack: () => void,
): ComponentChildren | null {
  const target = targets.find((entry) => entry.deviceId === id);
  if (!target) {
    return null;
  }

  return (
    <ConsoleEntityDetailPage
      icon={iconForTarget(target)}
      title={target.label}
      typeLabel="GSV · MACHINE"
      statusLabel={target.online ? "ONLINE" : "OFFLINE"}
      tone={target.online ? "online" : "idle"}
      blurb={target.description || compactText([target.platform, target.version, target.ownerUsername], "Machine target and declared capabilities.")}
      parentLabel="MACHINES"
      primaryLabel="SAVE CHANGES"
      sections={targetDetailSections(target)}
      onBack={onBack}
    />
  );
}

function renderAdapterDetail(
  adapters: readonly ConsoleAdapterAccount[],
  id: string,
  onBack: () => void,
): ComponentChildren | null {
  const adapter = adapters.find((entry) => adapterDetailId(entry) === id);
  if (!adapter) {
    return null;
  }

  return (
    <ConsoleEntityDetailPage
      icon={iconForAdapterName(adapter.adapter)}
      title={adapterLabel(adapter)}
      typeLabel="GSV · MESSENGER"
      statusLabel={statusForAdapter(adapter)}
      tone={toneForAdapter(adapter)}
      blurb={adapter.error || adapterSub(adapter)}
      parentLabel="MESSENGERS"
      primaryLabel="SAVE CHANGES"
      sections={adapterDetailSections(adapter)}
      onBack={onBack}
    />
  );
}

function renderPackageList(
  scopedPackages: readonly ConsolePackage[],
  packageKind: PackageListKind,
  selectedDetail: SelectedConsoleDetail | null,
  onBack: () => void,
  onOpenCreate: (() => void) | undefined,
  onOpenDetail: (pkg: ConsolePackage) => void,
  refreshing: boolean,
): ComponentChildren {
  if (selectedDetail?.kind === packageKind) {
    const detail = selectedDetail.createNew && packageKind !== "library"
      ? renderNewEntityDetail(packageKind, onBack)
      : renderPackageDetail(scopedPackages, packageKind, selectedDetail.id, onBack);
    if (detail) {
      return detail;
    }
  }

  return (
    <LibraryConsoleSection
      kind={packageKind}
      onOpenCreate={onOpenCreate}
      onOpenDetail={onOpenDetail}
      packages={scopedPackages}
      refreshing={refreshing}
    />
  );
}

function renderNewEntityDetail(
  kind: "machines" | "integrations" | "applications",
  onBack: () => void,
): ComponentChildren {
  const noun = kind === "machines" ? "MACHINE" : kind === "integrations" ? "INTEGRATION" : "APPLICATION";
  return (
    <ConsoleEntityDetailPage
      icon={kind === "machines" ? "computer" : kind === "integrations" ? "weblink" : "stars"}
      title={`NEW ${noun}`}
      typeLabel={`GSV · ${noun}`}
      statusLabel="NOT CONFIGURED"
      tone="idle"
      blurb="Awaiting source selection and access configuration."
      parentLabel={kind === "machines" ? "MACHINES" : kind === "integrations" ? "INTEGRATIONS" : "APPLICATIONS"}
      pendingLabel="FORM PLACEHOLDER"
      primaryLabel={`CREATE ${noun}`}
      onBack={onBack}
    />
  );
}

function renderPackageDetail(
  packages: readonly ConsolePackage[],
  packageKind: PackageListKind,
  id: string,
  onBack: () => void,
): ComponentChildren | null {
  const pkg = packages.find((entry) => entry.packageId === id);
  if (!pkg) {
    return null;
  }

  const noun = packageListNoun(packageKind);
  return (
    <ConsoleEntityDetailPage
      icon={pkg.uiEntrypoints.length > 0 ? "stars" : packageKind === "integrations" ? "weblink" : "pencil"}
      title={pkg.name}
      typeLabel={`GSV · ${noun}`}
      statusLabel={statusForPackage(pkg)}
      tone={toneForPackage(pkg)}
      blurb={pkg.description || packageSub(pkg)}
      parentLabel={packageListTitle(packageKind)}
      primaryLabel="SAVE CHANGES"
      sections={packageDetailSections(pkg)}
      onBack={onBack}
    />
  );
}

function resourceWithLocalEmptyState<T>(resource: ConsoleResourceState<T>): ConsoleResourceState<T> {
  return { ...resource, isEmpty: false };
}

function ConsoleEntityDetailPage(props: EntityDetailPageProps) {
  return <ConsoleDetailPage {...props} />;
}

function detailRow(
  id: string,
  label: string,
  value: string | number | boolean | null | undefined,
  options: Pick<ConsoleDetailRow, "icon" | "status" | "statusLabel"> = {},
): ConsoleDetailRow | null {
  const sub = typeof value === "boolean"
    ? (value ? "YES" : "NO")
    : typeof value === "number"
      ? String(value)
      : value?.trim() ?? "";

  return sub ? { id, label, sub, ...options } : null;
}

function liveRows(rows: readonly (ConsoleDetailRow | null)[]): ConsoleDetailRow[] {
  return rows.filter((row): row is ConsoleDetailRow => row !== null);
}

function processDetailSections(process: ConsoleProcess): ConsoleDetailSection[] {
  return [
    {
      title: "PROCESS",
      meta: statusForProcess(process),
      rows: liveRows([
        detailRow("pid", "PROCESS ID", process.pid),
        detailRow("state", "STATE", process.rawState || statusForProcess(process), {
          status: listRowStatusForTone(toneForProcess(process)),
          statusLabel: statusForProcess(process),
        }),
        detailRow("owner", "OWNER", process.username || uidLabel(process.uid)),
        detailRow("profile", "PROFILE", process.profile),
        detailRow("workspace", "WORKSPACE", process.cwd),
        detailRow("interactive", "INTERACTIVE", process.interactive),
      ]),
    },
    {
      title: "RUN",
      meta: process.activeRunId ? "ACTIVE" : process.queuedCount > 0 ? "QUEUED" : "IDLE",
      rows: liveRows([
        detailRow("active-run", "ACTIVE RUN", process.activeRunId),
        detailRow("conversation", "CONVERSATION", process.activeConversationId),
        detailRow("queued", "QUEUED MESSAGES", process.queuedCount),
        detailRow("created", "CREATED", process.createdAt === null ? "" : formatAge(process.createdAt)),
        detailRow("last-active", "LAST ACTIVE", process.lastActiveAt === null ? "" : formatAge(process.lastActiveAt)),
      ]),
    },
  ];
}

function targetDetailSections(target: ConsoleTarget): ConsoleDetailSection[] {
  return [
    {
      title: "MACHINE",
      meta: target.online ? "ONLINE" : "OFFLINE",
      rows: liveRows([
        detailRow("device", "DEVICE ID", target.deviceId),
        detailRow("status", "STATUS", target.online ? "ONLINE" : "OFFLINE", {
          status: target.online ? "online" : "idle",
          statusLabel: target.online ? "ONLINE" : "OFFLINE",
        }),
        detailRow("kind", "KIND", formatTokenLabel(target.kind)),
        detailRow("platform", "PLATFORM", target.platform),
        detailRow("version", "VERSION", target.version),
        detailRow("owner", "OWNER", target.ownerUsername || uidLabel(target.ownerUid)),
        detailRow("last-seen", "LAST SEEN", target.lastSeenAt === null ? "" : formatAge(target.lastSeenAt)),
      ]),
    },
    {
      title: "CAPABILITIES",
      meta: `${target.implements.length}`,
      rows: liveRows([
        detailRow("implements", "IMPLEMENTS", target.implements.join(" / ")),
        detailRow("description", "DESCRIPTION", target.description),
      ]),
    },
  ];
}

function adapterDetailSections(adapter: ConsoleAdapterAccount): ConsoleDetailSection[] {
  return [
    {
      title: "MESSENGER",
      meta: statusForAdapter(adapter),
      rows: liveRows([
        detailRow("adapter", "ADAPTER", formatTokenLabel(adapter.adapter)),
        detailRow("account", "ACCOUNT", adapter.accountId),
        detailRow("mode", "MODE", adapter.mode),
        detailRow("status", "STATUS", statusForAdapter(adapter), {
          status: listRowStatusForTone(toneForAdapter(adapter)),
          statusLabel: statusForAdapter(adapter),
        }),
        detailRow("authenticated", "AUTHENTICATED", adapter.authenticated),
        detailRow("last-activity", "LAST ACTIVITY", adapter.lastActivity === null ? "" : formatAge(adapter.lastActivity)),
        detailRow("error", "ERROR", adapter.error),
      ]),
    },
  ];
}

function packageDetailSections(pkg: ConsolePackage): ConsoleDetailSection[] {
  return [
    {
      title: "PACKAGE",
      meta: statusForPackage(pkg),
      rows: liveRows([
        detailRow("package-id", "PACKAGE ID", pkg.packageId),
        detailRow("status", "STATUS", statusForPackage(pkg), {
          status: listRowStatusForTone(toneForPackage(pkg)),
          statusLabel: statusForPackage(pkg),
        }),
        detailRow("runtime", "RUNTIME", runtimeLabel(pkg.runtime)),
        detailRow("version", "VERSION", pkg.version),
        detailRow("scope", "SCOPE", pkg.scopeKind === "user" && pkg.scopeUid !== null ? `USER ${pkg.scopeUid}` : pkg.scopeKind.toUpperCase()),
        detailRow("review", "REVIEW REQUIRED", pkg.reviewRequired),
      ]),
    },
    {
      title: "SOURCE",
      meta: pkg.sourcePublic ? "PUBLIC" : "PRIVATE",
      rows: liveRows([
        detailRow("repo", "REPOSITORY", pkg.sourceRepo),
        detailRow("ref", "REF", pkg.sourceRef),
        detailRow("subdir", "SUBDIRECTORY", pkg.sourceSubdir),
        detailRow("installed", "INSTALLED", pkg.installedAt === null ? "" : formatAge(pkg.installedAt)),
        detailRow("updated", "UPDATED", pkg.updatedAt === null ? "" : formatAge(pkg.updatedAt)),
      ]),
    },
    {
      title: "ENTRYPOINTS",
      meta: `${pkg.entrypoints.length}`,
      rows: liveRows([
        detailRow("ui-entrypoints", "UI", pkg.uiEntrypoints.map((entrypoint) => entrypoint.name).join(" / ")),
        detailRow("entrypoints", "ALL", pkg.entrypoints.map((entrypoint) => entrypoint.name).join(" / ")),
        detailRow("bindings", "BINDINGS", pkg.bindingNames.join(" / ")),
      ]),
    },
  ];
}

function SettingsListPanel({
  title,
  meta,
  rows,
  emptyLabel,
  action,
}: SettingsListPanelProps) {
  return (
    <section class="gsv-console-settings-list">
      <SectionHeader title={title} meta={meta} divider />
      <div class="gsv-console-settings-list-body">
        {rows.length === 0 ? (
          <div class="gsv-console-settings-empty">{emptyLabel}</div>
        ) : rows.map((row) => (
          <SettingsListRowView key={row.id} row={row} />
        ))}
        {action ? <SettingsListActionRow action={action} /> : null}
      </div>
    </section>
  );
}

function SettingsListRowView({ row }: { row: SettingsListRow }) {
  return (
    <div class="gsv-console-settings-list-row">
      <ListRow
        icon={row.icon}
        label={row.label}
        sub={row.sub}
        status={listRowStatusForTone(row.tone)}
        statusDotPlacement="trailing"
        statusLabel={row.statusLabel}
        tag={row.tag?.label}
        chevron={Boolean(row.onOpen)}
        onClick={row.onOpen}
      />
    </div>
  );
}

function SettingsListActionRow({ action }: { action: SettingsListAction }) {
  return (
    <div class={`gsv-console-settings-action${action.onClick ? "" : " is-disabled"}`} aria-disabled={action.onClick ? undefined : "true"}>
      <AddAction variant="row" label={action.label} onClick={action.onClick} />
    </div>
  );
}

function listRowStatusForTone(tone: StatusTone): ListRowStatus {
  if (tone === "online" || tone === "error" || tone === "idle" || tone === "live" || tone === "update" || tone === "warn") {
    return tone;
  }
  return "online";
}

function RuntimeConsoleSection({
  onOpenDetail,
  processes,
  refreshing,
}: {
  onOpenDetail: (process: ConsoleProcess) => void;
  processes: readonly ConsoleProcess[];
  refreshing: boolean;
}) {
  return (
    <SettingsListPanel
      title="RUNTIME"
      meta={refreshing ? "REFRESHING" : `${processes.length} PROCESSES`}
      emptyLabel="NO PROCESSES"
      rows={processes.map((process) => ({
        id: process.pid,
        icon: "list",
        label: process.label,
        sub: processSub(process),
        tone: toneForProcess(process),
        statusLabel: statusForProcess(process),
        onOpen: () => onOpenDetail(process),
      }))}
    />
  );
}

function MachinesConsoleSection({
  onOpenCreate,
  onOpenDetail,
  targets,
  refreshing,
}: {
  onOpenCreate: () => void;
  onOpenDetail: (target: ConsoleTarget) => void;
  targets: readonly ConsoleTarget[];
  refreshing: boolean;
}) {
  const onlineCount = targets.filter((target) => target.online).length;

  return (
    <SettingsListPanel
      title="MACHINES"
      meta={refreshing ? "REFRESHING" : `${onlineCount}/${targets.length} ONLINE`}
      emptyLabel="NO MACHINES"
      rows={targets.map((target) => ({
        id: target.deviceId,
        icon: iconForTarget(target),
        label: target.label,
        sub: targetSub(target),
        tone: target.online ? "online" : "idle",
        statusLabel: target.online ? "ONLINE" : "OFFLINE",
        onOpen: () => onOpenDetail(target),
      }))}
      action={{ label: "CONNECT NEW MACHINE", onClick: onOpenCreate }}
    />
  );
}

function MessengersConsoleSection({
  adapters,
  onOpenDetail,
  refreshing,
}: {
  adapters: readonly ConsoleAdapterAccount[];
  onOpenDetail: (adapter: ConsoleAdapterAccount) => void;
  refreshing: boolean;
}) {
  const connected = adapters.filter((adapter) => adapter.connected && adapter.authenticated && !adapter.error);

  return (
    <SettingsListPanel
      title="MESSENGERS"
      meta={refreshing ? "REFRESHING" : `${connected.length}/${adapters.length} CONNECTED`}
      emptyLabel="NO MESSENGERS"
      rows={adapters.map((adapter) => ({
        id: adapterDetailId(adapter),
        icon: iconForAdapterName(adapter.adapter),
        label: adapterLabel(adapter),
        sub: adapterSub(adapter),
        tone: toneForAdapter(adapter),
        statusLabel: statusForAdapter(adapter),
        onOpen: () => onOpenDetail(adapter),
      }))}
    />
  );
}

function LibraryConsoleSection({
  kind,
  onOpenCreate,
  onOpenDetail,
  packages,
  refreshing,
}: {
  kind: PackageListKind;
  onOpenCreate?: () => void;
  onOpenDetail: (pkg: ConsolePackage) => void;
  packages: readonly ConsolePackage[];
  refreshing: boolean;
}) {
  const title = packageListTitle(kind);
  const noun = packageListNoun(kind);
  const action = kind === "integrations"
    ? { label: "NEW INTEGRATION", onClick: onOpenCreate }
    : kind === "applications"
      ? { label: "NEW APPLICATION", onClick: onOpenCreate }
      : undefined;

  return (
    <SettingsListPanel
      title={title}
      meta={refreshing ? "REFRESHING" : `${packages.length} ${noun}${packages.length === 1 ? "" : "S"}`}
      emptyLabel={`NO ${noun}S`}
      rows={packages.map((pkg) => ({
        id: pkg.packageId,
        icon: iconForPackage(pkg, kind),
        label: pkg.name,
        sub: packageSub(pkg),
        tone: toneForPackage(pkg),
        statusLabel: statusForPackage(pkg),
        tag: pkg.reviewPending ? { label: "UPDATE", tone: "update" } : undefined,
        onOpen: () => onOpenDetail(pkg),
      }))}
      action={action}
    />
  );
}

function isQueuedProcess(process: ConsoleProcess): boolean {
  return process.state === "queued" || process.queuedCount > 0;
}

function toneForProcess(process: ConsoleProcess): StatusTone {
  if (process.state === "running") return "live";
  if (isQueuedProcess(process)) return "update";
  if (process.state === "unknown") return "warn";
  return "idle";
}

function statusForProcess(process: ConsoleProcess): string {
  if (process.state === "running") return "RUNNING";
  if (isQueuedProcess(process)) return "QUEUED";
  if (process.state === "unknown") return "UNKNOWN";
  return "IDLE";
}

function processSub(process: ConsoleProcess): string {
  return compactText([
    process.username || uidLabel(process.uid),
    process.profile,
    process.cwd,
  ], process.pid);
}

function iconForTarget(target: ConsoleTarget): string {
  if (target.kind === "browser") return "bookmark";
  if (target.kind === "adapter") return "chat";
  return "computer";
}

function targetSub(target: ConsoleTarget): string {
  return compactText([
    target.platform,
    target.version,
    target.ownerUsername ? `owner ${target.ownerUsername}` : "",
    target.description,
  ], target.deviceId);
}

function iconForAdapterName(adapter: string): string {
  if (adapter === "telegram") return "telegram";
  if (adapter === "discord") return "discord";
  return "chat";
}

function iconForPackage(pkg: ConsolePackage, kind: PackageListKind): string {
  if (isApplicationPackage(pkg)) return "rss";
  if (kind === "integrations") return "weblink";
  if (pkg.runtime === "web-ui") return "stars";
  if (pkg.runtime === "node") return "terminal";
  return "pencil";
}

function adapterDetailId(adapter: ConsoleAdapterAccount): string {
  return `${adapter.adapter}:${adapter.accountId}`;
}

function adapterLabel(adapter: ConsoleAdapterAccount): string {
  return `${formatTokenLabel(adapter.adapter)} · ${adapter.accountId}`;
}

function adapterSub(adapter: ConsoleAdapterAccount): string {
  return compactText([
    adapter.mode ? `mode ${adapter.mode}` : "",
    adapter.lastActivity !== null ? `active ${formatAge(adapter.lastActivity)}` : "",
    adapter.error,
  ], `${adapter.adapter}:${adapter.accountId}`);
}

function toneForAdapter(adapter: ConsoleAdapterAccount): StatusTone {
  if (adapter.error) return "error";
  if (adapter.connected && adapter.authenticated) return "online";
  if (adapter.connected && !adapter.authenticated) return "warn";
  return "idle";
}

function statusForAdapter(adapter: ConsoleAdapterAccount): string {
  if (adapter.error) return "ERROR";
  if (adapter.connected && adapter.authenticated) return "CONNECTED";
  if (adapter.connected) return "AUTH REQUIRED";
  return "DISCONNECTED";
}

function filterPackagesForKind(packages: readonly ConsolePackage[], kind: PackageListKind): ConsolePackage[] {
  const visiblePackages = packages.filter((pkg) => !isNativeConsolePackage(pkg));
  if (kind === "applications") {
    return visiblePackages.filter(isApplicationPackage);
  }
  if (kind === "integrations") {
    return visiblePackages.filter((pkg) => !isApplicationPackage(pkg));
  }
  return [...visiblePackages];
}

function isApplicationPackage(pkg: ConsolePackage): boolean {
  return pkg.runtime === "web-ui" || pkg.uiEntrypoints.length > 0 || pkg.entrypoints.some((entrypoint) => entrypoint.kind === "ui");
}

function isNativeConsolePackage(pkg: ConsolePackage): boolean {
  return isNativeWebPackageName(pkg.name) || isNativeWebPackageName(pkg.packageId);
}

function packageListTitle(kind: PackageListKind): string {
  if (kind === "applications") return "APPLICATIONS";
  if (kind === "integrations") return "INTEGRATIONS";
  return "LIBRARY";
}

function packageListNoun(kind: PackageListKind): string {
  if (kind === "applications") return "APPLICATION";
  if (kind === "integrations") return "INTEGRATION";
  return "PACKAGE";
}

function toneForPackage(pkg: ConsolePackage): StatusTone {
  if (pkg.reviewPending) return "update";
  if (pkg.enabled) return "online";
  return "idle";
}

function statusForPackage(pkg: ConsolePackage): string {
  if (pkg.reviewPending) return "REVIEW";
  if (pkg.enabled) return "ENABLED";
  return "DISABLED";
}

function packageSub(pkg: ConsolePackage): string {
  return compactText([
    pkg.version ? `v${pkg.version}` : "",
    runtimeLabel(pkg.runtime),
    pkg.sourceRepo,
    pkg.sourceRef,
  ], pkg.packageId);
}

function runtimeLabel(runtime: ConsolePackage["runtime"]): string {
  if (runtime === "dynamic-worker") return "DYNAMIC WORKER";
  if (runtime === "web-ui") return "WEB UI";
  if (runtime === "node") return "NODE";
  return "UNKNOWN RUNTIME";
}

function compactText(parts: readonly (string | null | undefined)[], fallback: string): string {
  const value = parts
    .map((part) => part?.trim() ?? "")
    .filter(Boolean)
    .join(" / ");
  return value || fallback;
}

function formatTokenLabel(value: string): string {
  return value
    .split(/[-_.:/\s]+/g)
    .filter(Boolean)
    .map((part) => part.length <= 3 ? part.toUpperCase() : `${part.slice(0, 1).toUpperCase()}${part.slice(1).toLowerCase()}`)
    .join(" ") || "Unknown";
}

function uidLabel(uid: number | null): string {
  return uid === null ? "" : `uid ${uid}`;
}

function normalizeTimestamp(value: number): number {
  return value < 10_000_000_000 ? value * 1000 : value;
}

function formatAge(value: number): string {
  const timestamp = normalizeTimestamp(value);
  const diffMs = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "NOW";
  if (minutes < 60) return `${minutes}M AGO`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}H AGO`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}D AGO`;
  return new Date(timestamp).toLocaleDateString();
}
