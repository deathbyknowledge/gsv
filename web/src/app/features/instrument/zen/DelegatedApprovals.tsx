import { useQuery } from "../../../services/navigation/viewQueries";
import type { ConsoleProcess } from "../../../domain/system/consoleModels";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { loadConsoleProcesses } from "../../../services/system/consoleService";
import { FleetApproval } from "../fleet/FleetApproval";
import type { FleetReference } from "../fleet/fleetModel";
import { INSTRUMENT_PROCESSES_KEY } from "../wire/queryKeys";

export function delegatedApprovalProcesses(processes: readonly ConsoleProcess[], pid: string): ConsoleProcess[] {
  const byPid = new Map(processes.map((process) => [process.pid, process]));
  const current = byPid.get(pid);
  if (!current || current.uid === null) return [];
  const personal = current.personal;
  return processes.filter((process) => {
    if (process.pid === pid || process.uid !== current.uid
      || process.state !== "waiting_hil" || !process.activeRunId) return false;
    if (personal) return true;
    const visited = new Set<string>([process.pid]);
    let parent = process.parentPid;
    while (parent && !visited.has(parent)) {
      if (parent === pid) return true;
      visited.add(parent);
      const ancestor = byPid.get(parent);
      if (ancestor?.uid !== current.uid) return false;
      parent = ancestor.parentPid;
    }
    return false;
  });
}

/** Ship recovers the owner's pending work from the registry after reload or process replacement. */
export function DelegatedApprovals({ pid, onFleet, placeLabelFor }: {
  pid: string;
  onFleet: (reference: FleetReference) => void;
  placeLabelFor?: (target: string) => string;
}) {
  const { client, connected } = useGateway();
  const processes = useQuery({
    queryKey: INSTRUMENT_PROCESSES_KEY,
    queryFn: () => loadConsoleProcesses(client),
    enabled: connected && Boolean(pid),
  });
  const waiting = delegatedApprovalProcesses(processes.data ?? [], pid);
  if (waiting.length === 0) return null;
  return <div class="zen-delegated-approvals" aria-label="Delegated work approvals">
    {waiting.map((process) => <FleetApproval key={`${process.pid}:${process.activeRunId}`}
      pid={process.pid} runId={process.activeRunId!} who={process.username} label={process.label || process.pid}
      placeLabelFor={placeLabelFor} onInspect={() => onFleet(`proc:${process.pid}`)} />)}
  </div>;
}
