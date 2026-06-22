import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { Icon } from "../../../components/ui/Icon";
import { SectionHeader } from "../../../components/ui/SectionHeader";
import { StatusDot, type StatusTone } from "../../../components/ui/StatusDot";
import { Tag, type TagTone } from "../../../components/ui/Tag";
import {
  useConsoleAdapters,
  useConsolePackages,
  useConsoleProcesses,
  useConsoleTargets,
} from "../hooks/useConsoleData";
import type {
  ConsoleAdapterAccount,
  ConsolePackage,
  ConsolePackageEntrypoint,
  ConsolePackageRuntime,
  ConsoleProcess,
  ConsoleProcessState,
  ConsoleResourceState,
  ConsoleTarget,
  ConsoleTargetKind,
} from "../domain/consoleModels";
import {
  ConsolePage,
  ConsoleResourceBoundary,
} from "../components/ConsolePageTemplate";
import {
  ConsoleDetailChips,
  ConsoleDetailGrid,
  ConsoleDetailList,
  type ConsoleDetailChip,
  type ConsoleDetailField,
  type ConsoleDetailListItem,
} from "./ConsoleDetailBlocks";
import "./ConsoleListPage.css";

export type ConsoleListKind = "machines" | "library" | "tasks" | "messengers" | "integrations" | "applications";
type PackageListKind = "library" | "integrations" | "applications";

type ConsoleListPageProps = {
  kind: ConsoleListKind;
};

type SelectedConsoleDetail = {
  kind: ConsoleListKind;
  id: string;
};

type RowTag = {
  label: string;
  tone: TagTone;
};

type SettingsListRow = {
  id: string;
  icon?: string;
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
  fields: readonly ConsoleDetailField[];
  chips?: {
    title: string;
    emptyLabel: string;
    items: readonly ConsoleDetailChip[];
  };
  list?: {
    title: string;
    emptyLabel: string;
    items: readonly ConsoleDetailListItem[];
  };
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

const TARGET_KIND_LABEL: Record<ConsoleTargetKind, string> = {
  "native-device": "NATIVE",
  browser: "BROWSER",
  adapter: "ADAPTER",
  unknown: "UNKNOWN",
};

const RUNTIME_LABEL: Record<ConsolePackageRuntime, string> = {
  "dynamic-worker": "DYNAMIC WORKER",
  node: "NODE",
  "web-ui": "WEB UI",
  unknown: "UNKNOWN RUNTIME",
};

export function ConsoleListPage({ kind }: ConsoleListPageProps) {
  const [selectedDetail, setSelectedDetail] = useState<SelectedConsoleDetail | null>(null);
  const targets = useConsoleTargets({ enabled: kind === "machines" });
  const packageKind = isPackageListKind(kind) ? kind : null;
  const packages = useConsolePackages({ enabled: packageKind !== null });
  const processes = useConsoleProcesses({ enabled: kind === "tasks" });
  const adapters = useConsoleAdapters({ enabled: kind === "messengers" });

  useEffect(() => {
    setSelectedDetail(null);
  }, [kind]);

  if (kind === "tasks") {
    return (
      <ConsolePage flush>
        <ConsoleResourceBoundary
          resource={resourceWithLocalEmptyState(processes.resource)}
          emptyLabel={EMPTY_RESOURCE_LABEL.tasks}
          errorLabel="RUNTIME"
          render={(data) => (
            selectedDetail?.kind === "tasks"
              ? renderProcessDetail(data, selectedDetail.id, () => setSelectedDetail(null)) ?? (
                <RuntimeConsoleSection
                  onOpenDetail={(process) => setSelectedDetail({ kind, id: process.pid })}
                  processes={data}
                  refreshing={processes.resource.isRefreshing}
                />
              )
              : (
                <RuntimeConsoleSection
                  onOpenDetail={(process) => setSelectedDetail({ kind, id: process.pid })}
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
              ? renderTargetDetail(data, selectedDetail.id, () => setSelectedDetail(null)) ?? (
                <MachinesConsoleSection
                  onOpenDetail={(target) => setSelectedDetail({ kind, id: target.deviceId })}
                  targets={data}
                  refreshing={targets.resource.isRefreshing}
                />
              )
              : (
                <MachinesConsoleSection
                  onOpenDetail={(target) => setSelectedDetail({ kind, id: target.deviceId })}
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
              ? renderAdapterDetail(data, selectedDetail.id, () => setSelectedDetail(null)) ?? (
                <MessengersConsoleSection
                  adapters={data}
                  onOpenDetail={(adapter) => setSelectedDetail({ kind, id: adapterDetailId(adapter) })}
                  refreshing={adapters.resource.isRefreshing}
                />
              )
              : (
                <MessengersConsoleSection
                  adapters={data}
                  onOpenDetail={(adapter) => setSelectedDetail({ kind, id: adapterDetailId(adapter) })}
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
            () => setSelectedDetail(null),
            (pkg) => setSelectedDetail({ kind, id: pkg.packageId }),
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
      fields={processDetailFields(process)}
      chips={{
        title: "STATE FLAGS",
        emptyLabel: "NO STATE FLAGS",
        items: processContextChips(process),
      }}
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
      fields={targetDetailFields(target)}
      chips={{
        title: "CAPABILITIES",
        emptyLabel: "NO CAPABILITIES DECLARED",
        items: targetCapabilityChips(target),
      }}
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
      fields={adapterDetailFields(adapter)}
      chips={{
        title: "CHANNEL FLAGS",
        emptyLabel: "NO CHANNEL FLAGS",
        items: adapterContextChips(adapter),
      }}
      onBack={onBack}
    />
  );
}

function renderPackageList(
  scopedPackages: readonly ConsolePackage[],
  packageKind: PackageListKind,
  selectedDetail: SelectedConsoleDetail | null,
  onBack: () => void,
  onOpenDetail: (pkg: ConsolePackage) => void,
  refreshing: boolean,
): ComponentChildren {
  if (selectedDetail?.kind === packageKind) {
    const detail = renderPackageDetail(scopedPackages, packageKind, selectedDetail.id, onBack);
    if (detail) {
      return detail;
    }
  }

  return (
    <LibraryConsoleSection
      kind={packageKind}
      onOpenDetail={onOpenDetail}
      packages={scopedPackages}
      refreshing={refreshing}
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
      fields={packageDetailFields(pkg)}
      list={{
        title: "ENTRYPOINTS",
        emptyLabel: "NO ENTRYPOINTS DECLARED",
        items: packageEntrypointItems(pkg.entrypoints),
      }}
      chips={{
        title: "BINDINGS",
        emptyLabel: "NO BINDINGS DECLARED",
        items: pkg.bindingNames.map((binding) => ({ label: binding, tone: "idle" })),
      }}
      onBack={onBack}
    />
  );
}

function resourceWithLocalEmptyState<T>(resource: ConsoleResourceState<T>): ConsoleResourceState<T> {
  return { ...resource, isEmpty: false };
}

function ConsoleEntityDetailPage({
  icon,
  title,
  typeLabel,
  statusLabel,
  tone,
  blurb,
  parentLabel,
  fields,
  chips,
  list,
  onBack,
}: EntityDetailPageProps) {
  return (
    <section class="gsv-console-entity-detail">
      <div class="gsv-console-entity-detail-shell">
        <header class="gsv-console-entity-detail-head">
          <span class="gsv-console-entity-detail-icon">
            <Icon name={icon} size={30} />
          </span>
          <div class="gsv-console-entity-detail-title">
            <h2>{title}</h2>
            <div>
              <span>{typeLabel}</span>
              <StatusDot tone={tone} size={7} />
              <span>{statusLabel}</span>
            </div>
          </div>
        </header>

        <p class="gsv-console-entity-detail-blurb">{blurb}</p>

        <div class="gsv-console-entity-detail-panel">
          <span class="gsv-detail-corner is-top-left" aria-hidden="true" />
          <span class="gsv-detail-corner is-top-right" aria-hidden="true" />
          <span class="gsv-detail-corner is-bottom-left" aria-hidden="true" />
          <span class="gsv-detail-corner is-bottom-right" aria-hidden="true" />
          <ConsoleDetailGrid fields={fields} />
          {list ? (
            <ConsoleDetailList
              title={list.title}
              emptyLabel={list.emptyLabel}
              items={list.items}
            />
          ) : null}
          {chips ? (
            <ConsoleDetailChips
              title={chips.title}
              emptyLabel={chips.emptyLabel}
              chips={chips.items}
            />
          ) : null}
        </div>

        <div class="gsv-console-entity-detail-actions">
          <button type="button" class="gsv-console-entity-detail-back" onClick={onBack}>
            BACK TO {parentLabel}
          </button>
        </div>
      </div>
    </section>
  );
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
  const content = (
    <>
      <span class="gsv-console-settings-row-mark">
        {row.icon ? <Icon name={row.icon} size={18} /> : <StatusDot tone={row.tone} size={8} />}
      </span>
      <span class="gsv-console-settings-row-copy">
        <strong>{row.label}</strong>
        <small>{row.sub}</small>
      </span>
      {row.tag ? (
        <span class="gsv-console-settings-row-tag">
          <Tag label={row.tag.label} tone={row.tag.tone} boxed />
        </span>
      ) : null}
      <span class="gsv-console-settings-row-status">
        <StatusDot tone={row.tone} size={7} />
        <span>{row.statusLabel}</span>
      </span>
      <span class="gsv-console-settings-row-open" aria-hidden="true" />
    </>
  );

  if (row.onOpen) {
    return (
      <button type="button" class="gsv-console-settings-row" onClick={row.onOpen}>
        {content}
      </button>
    );
  }

  return <div class="gsv-console-settings-row">{content}</div>;
}

function SettingsListActionRow({ action }: { action: SettingsListAction }) {
  const content = (
    <>
      <span class="gsv-console-settings-row-mark is-action">
        <Icon name="plus" size={18} />
      </span>
      <span class="gsv-console-settings-row-copy">
        <strong>{action.label}</strong>
      </span>
      <span class="gsv-console-settings-row-open" aria-hidden="true" />
    </>
  );

  if (action.onClick) {
    return (
      <button type="button" class="gsv-console-settings-row is-action" onClick={action.onClick}>
        {content}
      </button>
    );
  }

  return (
    <div class="gsv-console-settings-row is-action is-disabled" aria-disabled="true">
      {content}
    </div>
  );
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
  onOpenDetail,
  targets,
  refreshing,
}: {
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
        label: target.label,
        sub: targetSub(target),
        tone: target.online ? "online" : "idle",
        statusLabel: target.online ? "ONLINE" : "OFFLINE",
        onOpen: () => onOpenDetail(target),
      }))}
      action={{ label: "CONNECT NEW MACHINE" }}
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
        label: formatTokenLabel(adapter.adapter),
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
  onOpenDetail,
  packages,
  refreshing,
}: {
  kind: PackageListKind;
  onOpenDetail: (pkg: ConsolePackage) => void;
  packages: readonly ConsolePackage[];
  refreshing: boolean;
}) {
  const title = packageListTitle(kind);
  const noun = packageListNoun(kind);
  const action = kind === "integrations"
    ? { label: "NEW INTEGRATION" }
    : kind === "applications"
      ? { label: "NEW APPLICATION" }
      : undefined;

  return (
    <SettingsListPanel
      title={title}
      meta={refreshing ? "REFRESHING" : `${packages.length} ${noun}${packages.length === 1 ? "" : "S"}`}
      emptyLabel={`NO ${noun}S`}
      rows={packages.map((pkg) => ({
        id: pkg.packageId,
        icon: iconForPackageKind(pkg, kind),
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

function processDetailFields(process: ConsoleProcess): ConsoleDetailField[] {
  return [
    { label: "PID", value: process.pid, wide: true },
    { label: "STATE", value: processStateLabel(process.state), tone: tagToneForProcess(process) },
    { label: "RAW STATE", value: process.rawState },
    { label: "USER", value: process.username || uidLabel(process.uid) },
    { label: "UID", value: process.uid },
    { label: "PROFILE", value: process.profile },
    { label: "CWD", value: process.cwd, wide: true },
    { label: "PARENT PID", value: process.parentPid },
    { label: "ACTIVE RUN", value: process.activeRunId, wide: true },
    { label: "CONVERSATION", value: process.activeConversationId, wide: true },
    { label: "QUEUE DEPTH", value: process.queuedCount },
    { label: "INTERACTIVE", value: yesNo(process.interactive), tone: process.interactive ? "info" : "idle" },
    { label: "CREATED", value: formatTimestampTrace(process.createdAt), wide: true },
    { label: "LAST ACTIVE", value: formatTimestampTrace(process.lastActiveAt), wide: true },
  ];
}

function processContextChips(process: ConsoleProcess): ConsoleDetailChip[] {
  const chips: ConsoleDetailChip[] = [
    { label: processStateLabel(process.state), tone: tagToneForProcess(process) },
  ];
  if (process.interactive) chips.push({ label: "INTERACTIVE IO", tone: "info" });
  if (process.activeRunId) chips.push({ label: "ACTIVE RUN", tone: "update" });
  if (process.activeConversationId) chips.push({ label: "CONVERSATION", tone: "accent" });
  if (process.queuedCount > 0) chips.push({ label: `QUEUE ${process.queuedCount}`, tone: "update" });
  if (process.parentPid) chips.push({ label: "CHILD PROCESS", tone: "idle" });
  return chips;
}

function targetDetailFields(target: ConsoleTarget): ConsoleDetailField[] {
  return [
    { label: "DEVICE ID", value: target.deviceId, wide: true },
    { label: "STATE", value: target.online ? "ONLINE" : "OFFLINE", tone: target.online ? "online" : "idle" },
    { label: "KIND", value: TARGET_KIND_LABEL[target.kind], tone: target.kind === "unknown" ? "warn" : "info" },
    { label: "OWNER", value: target.ownerUsername },
    { label: "OWNER UID", value: target.ownerUid },
    { label: "PLATFORM", value: target.platform },
    { label: "VERSION", value: target.version },
    { label: "FILES SURFACE", value: yesNo(supportsFilesSurface(target)), tone: supportsFilesSurface(target) ? "online" : "idle" },
    { label: "SHELL SURFACE", value: yesNo(supportsShellSurface(target)), tone: supportsShellSurface(target) ? "online" : "idle" },
    { label: "DESCRIPTION", value: target.description, wide: true },
    { label: "LAST SEEN", value: formatTimestampTrace(target.lastSeenAt), wide: true },
  ];
}

function targetCapabilityChips(target: ConsoleTarget): ConsoleDetailChip[] {
  return target.implements.map((capability) => ({
    label: capability,
    tone: target.online ? "accent" : "idle",
  }));
}

function adapterDetailFields(adapter: ConsoleAdapterAccount): ConsoleDetailField[] {
  return [
    { label: "ADAPTER", value: adapter.adapter, tone: "info" },
    { label: "ACCOUNT ID", value: adapter.accountId, wide: true },
    { label: "STATE", value: statusForAdapter(adapter), tone: tagToneForAdapter(adapter) },
    { label: "CONNECTED", value: yesNo(adapter.connected), tone: adapter.connected ? "online" : "idle" },
    { label: "AUTHENTICATED", value: yesNo(adapter.authenticated), tone: adapter.authenticated ? "online" : "warn" },
    { label: "MODE", value: adapter.mode },
    { label: "ERROR", value: adapter.error, tone: adapter.error ? "error" : "idle", wide: true },
    { label: "LAST ACTIVITY", value: formatTimestampTrace(adapter.lastActivity), wide: true },
  ];
}

function adapterContextChips(adapter: ConsoleAdapterAccount): ConsoleDetailChip[] {
  const chips: ConsoleDetailChip[] = [
    { label: statusForAdapter(adapter), tone: tagToneForAdapter(adapter) },
  ];
  if (adapter.connected) chips.push({ label: "CONNECTED", tone: "online" });
  if (adapter.authenticated) chips.push({ label: "AUTHENTICATED", tone: "online" });
  if (!adapter.authenticated) chips.push({ label: "AUTH REQUIRED", tone: "warn" });
  if (adapter.mode) chips.push({ label: adapter.mode.toUpperCase(), tone: "info" });
  if (adapter.error) chips.push({ label: "ERROR", tone: "error" });
  return chips;
}

function packageDetailFields(pkg: ConsolePackage): ConsoleDetailField[] {
  return [
    { label: "PACKAGE ID", value: pkg.packageId, wide: true },
    { label: "VERSION", value: pkg.version },
    { label: "RUNTIME", value: RUNTIME_LABEL[pkg.runtime], tone: pkg.runtime === "unknown" ? "warn" : "info" },
    { label: "STATE", value: statusForPackage(pkg), tone: packageStateTone(pkg) },
    { label: "SCOPE", value: packageScopeLabel(pkg), tone: pkg.scopeKind === "unknown" ? "warn" : "info" },
    { label: "SCOPE UID", value: pkg.scopeUid },
    { label: "REVIEW", value: packageReviewLabel(pkg), tone: packageReviewTone(pkg) },
    { label: "APPROVED", value: formatTimestampTrace(pkg.reviewApprovedAt), wide: true },
    { label: "SOURCE REPO", value: pkg.sourceRepo, wide: true },
    { label: "SOURCE REF", value: pkg.sourceRef },
    { label: "SOURCE SUBDIR", value: pkg.sourceSubdir, wide: true },
    { label: "SOURCE VISIBILITY", value: sourceVisibilityLabel(pkg), tone: pkg.sourcePublic ? "info" : "warn" },
    { label: "INSTALLED", value: formatTimestampTrace(pkg.installedAt), wide: true },
    { label: "UPDATED", value: formatTimestampTrace(pkg.updatedAt), wide: true },
  ];
}

function packageEntrypointItems(entrypoints: readonly ConsolePackageEntrypoint[]): ConsoleDetailListItem[] {
  return entrypoints.map((entrypoint, index) => ({
    id: `${index}:${entrypoint.kind}:${entrypoint.name}:${entrypoint.route}:${entrypoint.command}`,
    label: `${entrypoint.kind.toUpperCase()} / ${entrypoint.name}`,
    meta: compactText([
      entrypoint.route ? `route ${entrypoint.route}` : "",
      entrypoint.command ? `command ${entrypoint.command}` : "",
      entrypoint.description,
    ], "NO ROUTE OR COMMAND"),
    chips: entrypoint.syscalls.map((syscall) => ({ label: syscall, tone: "idle" })),
  }));
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

function processStateLabel(state: ConsoleProcessState): string {
  if (state === "running") return "ACTIVE";
  if (state === "queued") return "QUEUED";
  if (state === "unknown") return "UNKNOWN";
  return "IDLE";
}

function tagToneForProcess(process: ConsoleProcess): TagTone {
  if (process.state === "running") return "online";
  if (isQueuedProcess(process)) return "update";
  if (process.state === "unknown") return "warn";
  return "idle";
}

function supportsFilesSurface(target: ConsoleTarget): boolean {
  return target.implements.some((capability) => /(?:^|[./:-])(fs|file|files|storage|read|write|ripgit)(?:$|[./:-])/i.test(capability));
}

function supportsShellSurface(target: ConsoleTarget): boolean {
  return target.implements.some((capability) => /(?:^|[./:-])(shell|terminal|exec|command|proc|process)(?:$|[./:-])/i.test(capability));
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

function tagToneForAdapter(adapter: ConsoleAdapterAccount): TagTone {
  if (adapter.error) return "error";
  if (adapter.connected && adapter.authenticated) return "online";
  if (adapter.connected) return "warn";
  return "idle";
}

function isTrustedPackage(pkg: ConsolePackage): boolean {
  return !pkg.reviewRequired || pkg.reviewApprovedAt !== null;
}

function filterPackagesForKind(packages: readonly ConsolePackage[], kind: PackageListKind): ConsolePackage[] {
  if (kind === "applications") {
    return packages.filter(isApplicationPackage);
  }
  if (kind === "integrations") {
    return packages.filter((pkg) => !isApplicationPackage(pkg));
  }
  return [...packages];
}

function isApplicationPackage(pkg: ConsolePackage): boolean {
  return pkg.runtime === "web-ui" || pkg.uiEntrypoints.length > 0 || pkg.entrypoints.some((entrypoint) => entrypoint.kind === "ui");
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

function iconForPackageKind(pkg: ConsolePackage, kind: PackageListKind): string {
  if (kind === "applications") return "stars";
  if (kind === "integrations") return "weblink";
  return pkg.uiEntrypoints.length > 0 ? "stars" : "pencil";
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
    RUNTIME_LABEL[pkg.runtime],
    pkg.sourceRepo,
    pkg.sourceRef,
  ], pkg.packageId);
}

function packageStateTone(pkg: ConsolePackage): TagTone {
  if (pkg.reviewPending) return "update";
  if (pkg.enabled) return "online";
  return "idle";
}

function packageReviewLabel(pkg: ConsolePackage): string {
  if (pkg.reviewPending) return "PENDING REVIEW";
  if (pkg.reviewApprovedAt !== null) return "APPROVED";
  if (!pkg.reviewRequired) return "NOT REQUIRED";
  return "REQUIRED";
}

function packageReviewTone(pkg: ConsolePackage): TagTone {
  if (pkg.reviewPending) return "update";
  if (isTrustedPackage(pkg)) return "online";
  return "warn";
}

function packageScopeLabel(pkg: ConsolePackage): string {
  if (pkg.scopeKind === "global") return "GLOBAL";
  if (pkg.scopeKind === "user") {
    return pkg.scopeUid === null ? "USER" : `USER ${pkg.scopeUid}`;
  }
  return "UNKNOWN";
}

function sourceVisibilityLabel(pkg: ConsolePackage): string {
  return pkg.sourcePublic ? "PUBLIC" : "NON-PUBLIC";
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

function formatTimestampTrace(value: number | null): string {
  if (value === null) {
    return "";
  }
  const timestamp = normalizeTimestamp(value);
  return `${formatAge(timestamp)} / ${new Date(timestamp).toLocaleString()}`;
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

function yesNo(value: boolean): string {
  return value ? "YES" : "NO";
}
