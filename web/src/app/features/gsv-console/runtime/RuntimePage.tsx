import { SettingsListPanel } from "../components/SettingsListPanel";
import {
  ConsolePage,
  ConsoleResourceBoundary,
} from "../components/ConsolePageTemplate";
import type { ConsoleListSelection } from "../domain/consoleListTypes";
import type { ConsoleProcess, ConsoleResourceState } from "../domain/consoleModels";
import { useConsoleListSelection } from "../hooks/useConsoleListSelection";
import { useConsoleProcesses } from "../hooks/useConsoleData";
import { RuntimeDetailPage } from "./RuntimeDetailPage";
import {
  iconForProcess,
  processSub,
  statusForProcess,
  toneForProcess,
} from "./runtimePresentation";

type RuntimePageProps = {
  initialCreate?: boolean;
  initialDetailId?: string | null;
  initialDetailLabel?: string | null;
  onSelectionChange?: (selection: ConsoleListSelection | null) => void;
};

function resourceWithLocalEmptyState<T>(resource: ConsoleResourceState<T>): ConsoleResourceState<T> {
  return { ...resource, isEmpty: false };
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
      title="TASKS"
      meta={refreshing ? "REFRESHING" : `${processes.length} TASK${processes.length === 1 ? "" : "S"}`}
      emptyLabel="NO TASKS"
      rows={processes.map((process) => ({
        id: process.pid,
        icon: iconForProcess(process),
        label: process.label,
        sub: processSub(process),
        tone: toneForProcess(process),
        statusLabel: statusForProcess(process),
        onOpen: () => onOpenDetail(process),
      }))}
    />
  );
}

function renderRuntimeDetail(
  processes: readonly ConsoleProcess[],
  id: string,
  onBack: () => void,
) {
  const process = processes.find((entry) => entry.pid === id);
  return process ? <RuntimeDetailPage process={process} onBack={onBack} /> : null;
}

export function RuntimePage({
  initialCreate = false,
  initialDetailId = null,
  initialDetailLabel = null,
  onSelectionChange,
}: RuntimePageProps) {
  const processes = useConsoleProcesses({ enabled: true });
  const { selectedDetail, selectDetail } = useConsoleListSelection({
    initialCreate,
    initialDetailId,
    initialDetailLabel,
    kind: "tasks",
    onSelectionChange,
  });

  return (
    <ConsolePage flush>
      <ConsoleResourceBoundary
        resource={resourceWithLocalEmptyState(processes.resource)}
        emptyLabel="NO TASKS"
        errorLabel="RUNTIME"
        render={(data) => (
          selectedDetail?.kind === "tasks"
            ? renderRuntimeDetail(data, selectedDetail.id, () => selectDetail(null)) ?? (
              <RuntimeConsoleSection
                onOpenDetail={(process) => selectDetail({ kind: "tasks", id: process.pid, label: process.label })}
                processes={data}
                refreshing={processes.resource.isRefreshing}
              />
            )
            : (
              <RuntimeConsoleSection
                onOpenDetail={(process) => selectDetail({ kind: "tasks", id: process.pid, label: process.label })}
                processes={data}
                refreshing={processes.resource.isRefreshing}
              />
            )
        )}
      />
    </ConsolePage>
  );
}
