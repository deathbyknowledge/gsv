import { useEffect, useMemo, useState } from "preact/hooks";
import { ListTemplate } from "../list-template/ListTemplate";
import {
  ConsolePage,
  ConsoleResourceBoundary,
} from "../components/ConsolePageTemplate";
import type { ConsoleListSelection } from "../domain/consoleListTypes";
import type { ConsoleProcess, ConsoleResourceState } from "../domain/consoleModels";
import {
  consoleWorkProcesses,
  findConsoleWorkProcess,
} from "../domain/consoleProcesses";
import { useConsoleListSelection } from "../hooks/useConsoleListSelection";
import { useConsoleProcesses } from "../hooks/useConsoleData";
import { RuntimeDetailPage } from "./RuntimeDetailPage";
import {
  iconForProcess,
  isActiveProcess,
  processSub,
  statusForProcess,
  toneForProcess,
} from "./runtimePresentation";

type RuntimePageProps = {
  initialCreate?: boolean;
  initialDetailId?: string | null;
  initialDetailLabel?: string | null;
  onSelectionChange?: (selection: ConsoleListSelection | null) => void;
  /** Connect-new for tasks opens a fresh chat. */
  onNewTask?: () => void;
};

function resourceWithLocalEmptyState<T>(resource: ConsoleResourceState<T>): ConsoleResourceState<T> {
  return { ...resource, isEmpty: false };
}

function RuntimeConsoleSection({
  onNewTask,
  onOpenDetail,
  processes,
  refreshing,
}: {
  onNewTask?: () => void;
  onOpenDetail: (process: ConsoleProcess) => void;
  processes: readonly ConsoleProcess[];
  refreshing: boolean;
}) {
  const [query, setQuery] = useState("");
  const workProcesses = useMemo(() => consoleWorkProcesses(processes), [processes]);
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return workProcesses
      .filter((process) => !q || process.label.toLowerCase().includes(q))
      .map((process) => ({
        id: process.pid,
        icon: iconForProcess(process),
        label: process.label,
        sub: processSub(process),
        tone: toneForProcess(process),
        statusLabel: statusForProcess(process),
        onOpen: () => onOpenDetail(process),
      }));
  }, [workProcesses, query, onOpenDetail]);

  return (
    <ListTemplate
      listTitle="WORK"
      listMeta={refreshing ? "REFRESHING" : `${workProcesses.filter(isActiveProcess).length}/${workProcesses.length} ACTIVE`}
      emptyObject="WORK"
      rows={rows}
      connectLabel="NEW WORK"
      connectDisabled={!onNewTask}
      onConnect={onNewTask}
      search={{ value: query, placeholder: "Search work…", onChange: setQuery }}
    />
  );
}

function renderRuntimeDetail(
  processes: readonly ConsoleProcess[],
  id: string,
  onBack: () => void,
) {
  const process = findConsoleWorkProcess(processes, id);
  return process ? <RuntimeDetailPage process={process} onBack={onBack} /> : null;
}

export function RuntimePage({
  initialCreate = false,
  initialDetailId = null,
  initialDetailLabel = null,
  onSelectionChange,
  onNewTask,
}: RuntimePageProps) {
  const processes = useConsoleProcesses({ enabled: true });
  const { selectedDetail, selectDetail } = useConsoleListSelection({
    initialCreate,
    initialDetailId,
    initialDetailLabel,
    kind: "tasks",
    onSelectionChange,
  });
  const selectedProcessId = selectedDetail?.kind === "tasks" ? selectedDetail.id : null;

  useEffect(() => {
    if (!selectedProcessId) {
      return;
    }
    const selectedProcess = processes.data?.find((process) => process.pid === selectedProcessId);
    if (selectedProcess?.personal) {
      selectDetail(null);
    }
  }, [processes.data, selectDetail, selectedProcessId]);

  return (
    <ConsolePage flush>
      <ConsoleResourceBoundary
        resource={resourceWithLocalEmptyState(processes.resource)}
        emptyLabel="NO WORK"
        errorLabel="WORK"
        render={(data) => (
          selectedDetail?.kind === "tasks"
            ? renderRuntimeDetail(data, selectedDetail.id, () => selectDetail(null)) ?? (
              <RuntimeConsoleSection
                onNewTask={onNewTask}
                onOpenDetail={(process) => selectDetail({ kind: "tasks", id: process.pid, label: process.label })}
                processes={data}
                refreshing={processes.resource.isRefreshing}
              />
            )
            : (
              <RuntimeConsoleSection
                onNewTask={onNewTask}
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
