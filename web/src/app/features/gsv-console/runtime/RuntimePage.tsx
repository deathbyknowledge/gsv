import type { ComponentChildren } from "preact";
import { useMemo, useState } from "preact/hooks";
import { ListTemplate } from "../list-template/ListTemplate";
import {
  ConsolePage,
  ConsoleResourceBoundary,
} from "../components/ConsolePageTemplate";
import type { ConsoleListSelection } from "../domain/consoleListTypes";
import type { ConsoleProcess, ConsoleResourceState } from "../domain/consoleModels";
import {
  consoleActivityProcesses,
  findConsoleProcess,
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
  const activityProcesses = useMemo(() => consoleActivityProcesses(processes), [processes]);
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return activityProcesses
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
  }, [activityProcesses, query, onOpenDetail]);

  return (
    <ListTemplateComponent
      listTitle="PROCESS ACTIVITY"
      listMeta={refreshing ? "REFRESHING" : `${activityProcesses.filter(isActiveProcess).length}/${activityProcesses.length} ACTIVE`}
      emptyObject="PROCESS ACTIVITY"
      rows={rows}
      connectLabel="NEW WORK"
      connectDisabled={!onNewTask}
      onConnect={onNewTask}
      search={{ value: query, placeholder: "Search processes…", onChange: setQuery }}
    />
  );
}

function renderRuntimeDetail(
  processes: readonly ConsoleProcess[],
  id: string,
  onBack: () => void,
  RuntimeDetailPageComponent: RuntimePageDependencies["RuntimeDetailPage"],
) {
  const process = findConsoleProcess(processes, id);
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
  const ConsolePageComponent = dependencies.ConsolePage;
  const ResourceBoundary = dependencies.ConsoleResourceBoundary;

  return (
    <ConsolePageComponent flush>
      <ResourceBoundary
        resource={resourceWithLocalEmptyState(processes.resource)}
        emptyLabel="NO PROCESS ACTIVITY"
        errorLabel="PROCESS ACTIVITY"
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
