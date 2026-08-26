import type { ComponentChildren } from "preact";
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
  dependencies?: RuntimePageDependencies;
};

export type RuntimePageDependencies = {
  ConsolePage: (props: Parameters<typeof ConsolePage>[0]) => ComponentChildren;
  ConsoleResourceBoundary: <T>(props: {
    resource: ConsoleResourceState<T>;
    emptyLabel: string;
    errorLabel: string;
    render: (data: T) => ComponentChildren;
  }) => ComponentChildren;
  ListTemplate: (props: Parameters<typeof ListTemplate>[0]) => ComponentChildren;
  RuntimeDetailPage: (props: { process: ConsoleProcess; onBack: () => void }) => ComponentChildren;
  useConsoleProcesses: () => {
    data: ConsoleProcess[];
    resource: ConsoleResourceState<ConsoleProcess[]>;
  };
};

const defaultDependencies: RuntimePageDependencies = {
  ConsolePage: (props) => <ConsolePage {...props} />,
  ConsoleResourceBoundary: (props) => <ConsoleResourceBoundary {...props} />,
  ListTemplate: (props) => <ListTemplate {...props} />,
  RuntimeDetailPage: (props) => <RuntimeDetailPage {...props} />,
  useConsoleProcesses: () => {
    const result = useConsoleProcesses({ enabled: true });
    return { data: result.data ?? [], resource: result.resource };
  },
};

function resourceWithLocalEmptyState<T>(resource: ConsoleResourceState<T>): ConsoleResourceState<T> {
  return { ...resource, isEmpty: false };
}

function RuntimeConsoleSection({
  onNewTask,
  onOpenDetail,
  processes,
  refreshing,
  ListTemplate: ListTemplateComponent,
}: {
  onNewTask?: () => void;
  onOpenDetail: (process: ConsoleProcess) => void;
  processes: readonly ConsoleProcess[];
  refreshing: boolean;
  ListTemplate: RuntimePageDependencies["ListTemplate"];
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
    <ListTemplateComponent
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
  RuntimeDetailPageComponent: RuntimePageDependencies["RuntimeDetailPage"],
) {
  const process = findConsoleWorkProcess(processes, id);
  return process ? <RuntimeDetailPageComponent process={process} onBack={onBack} /> : null;
}

export function RuntimePage({
  initialCreate = false,
  initialDetailId = null,
  initialDetailLabel = null,
  onSelectionChange,
  onNewTask,
  dependencies = defaultDependencies,
}: RuntimePageProps) {
  const processes = dependencies.useConsoleProcesses();
  const { selectedDetail, selectDetail } = useConsoleListSelection({
    initialCreate,
    initialDetailId,
    initialDetailLabel,
    kind: "tasks",
    onSelectionChange,
  });
  const selectedProcessId = selectedDetail?.kind === "tasks" ? selectedDetail.id : null;
  const ConsolePageComponent = dependencies.ConsolePage;
  const ResourceBoundary = dependencies.ConsoleResourceBoundary;

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
    <ConsolePageComponent flush>
      <ResourceBoundary
        resource={resourceWithLocalEmptyState(processes.resource)}
        emptyLabel="NO WORK"
        errorLabel="WORK"
        render={(data) => (
          selectedDetail?.kind === "tasks"
            ? renderRuntimeDetail(data, selectedDetail.id, () => selectDetail(null), dependencies.RuntimeDetailPage) ?? (
              <RuntimeConsoleSection
                onNewTask={onNewTask}
                onOpenDetail={(process) => selectDetail({ kind: "tasks", id: process.pid, label: process.label })}
                processes={data}
                refreshing={processes.resource.isRefreshing}
                ListTemplate={dependencies.ListTemplate}
              />
            )
            : (
              <RuntimeConsoleSection
                onNewTask={onNewTask}
                onOpenDetail={(process) => selectDetail({ kind: "tasks", id: process.pid, label: process.label })}
                processes={data}
                refreshing={processes.resource.isRefreshing}
                ListTemplate={dependencies.ListTemplate}
              />
            )
        )}
      />
    </ConsolePageComponent>
  );
}
