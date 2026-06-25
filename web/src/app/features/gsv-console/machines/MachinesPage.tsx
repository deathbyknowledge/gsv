import { SettingsListPanel } from "../components/SettingsListPanel";
import {
  ConsolePage,
  ConsoleResourceBoundary,
} from "../components/ConsolePageTemplate";
import {
  NEW_DETAIL_ID,
  type ConsoleListSelection,
} from "../domain/consoleListTypes";
import type { ConsoleResourceState, ConsoleTarget } from "../domain/consoleModels";
import { useConsoleListSelection } from "../hooks/useConsoleListSelection";
import { useConsoleTargets } from "../hooks/useConsoleData";
import { MachineDetailPage } from "./MachineDetailPage";
import { MachineProvisionFlow } from "./MachineProvisionFlow";
import {
  iconForTarget,
  statusForTarget,
  targetSub,
  toneForTarget,
} from "./machinePresentation";

type MachinesPageProps = {
  initialCreate?: boolean;
  initialDetailId?: string | null;
  initialDetailLabel?: string | null;
  onSelectionChange?: (selection: ConsoleListSelection | null) => void;
};

function resourceWithLocalEmptyState<T>(resource: ConsoleResourceState<T>): ConsoleResourceState<T> {
  return { ...resource, isEmpty: false };
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
        tone: toneForTarget(target),
        statusLabel: statusForTarget(target),
        onOpen: () => onOpenDetail(target),
      }))}
      action={{ label: "CONNECT NEW MACHINE", onClick: onOpenCreate }}
    />
  );
}

function renderMachineDetail(
  targets: readonly ConsoleTarget[],
  id: string,
  onBack: () => void,
) {
  const target = targets.find((entry) => entry.deviceId === id);
  return target ? <MachineDetailPage target={target} onBack={onBack} /> : null;
}

export function MachinesPage({
  initialCreate = false,
  initialDetailId = null,
  initialDetailLabel = null,
  onSelectionChange,
}: MachinesPageProps) {
  const targets = useConsoleTargets({ enabled: true });
  const { selectedDetail, selectDetail } = useConsoleListSelection({
    initialCreate,
    initialDetailId,
    initialDetailLabel,
    kind: "machines",
    onSelectionChange,
  });

  return (
    <ConsolePage flush>
      <ConsoleResourceBoundary
        resource={resourceWithLocalEmptyState(targets.resource)}
        emptyLabel="NO MACHINES"
        errorLabel="MACHINES"
        render={(data) => (
          selectedDetail?.kind === "machines"
            ? (selectedDetail.createNew
              ? (
                <MachineProvisionFlow
                  onBack={() => selectDetail(null)}
                  onOpenMachine={(target) => selectDetail({ kind: "machines", id: target.deviceId, label: target.label })}
                />
              )
              : renderMachineDetail(data, selectedDetail.id, () => selectDetail(null))) ?? (
              <MachinesConsoleSection
                onOpenCreate={() => selectDetail({ kind: "machines", id: NEW_DETAIL_ID, createNew: true })}
                onOpenDetail={(target) => selectDetail({ kind: "machines", id: target.deviceId, label: target.label })}
                targets={data}
                refreshing={targets.resource.isRefreshing}
              />
            )
            : (
              <MachinesConsoleSection
                onOpenCreate={() => selectDetail({ kind: "machines", id: NEW_DETAIL_ID, createNew: true })}
                onOpenDetail={(target) => selectDetail({ kind: "machines", id: target.deviceId, label: target.label })}
                targets={data}
                refreshing={targets.resource.isRefreshing}
              />
            )
        )}
      />
    </ConsolePage>
  );
}
