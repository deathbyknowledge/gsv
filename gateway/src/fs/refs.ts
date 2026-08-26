import type { AuthStore } from "../kernel/auth-store";
import type { CapabilityStore } from "../kernel/capabilities";
import type { ConfigStore } from "../kernel/config";
import type { CronFileService } from "../kernel/crontab";
import type { DeviceRegistry } from "../kernel/devices";
import type { ProcessRegistry } from "../kernel/processes";
import type { RequestFrame } from "../protocol/frames";
import { sendFrameToProcess } from "../shared/utils";
import type { ArgsOf, ResultOf } from "../syscalls";
import type { ScheduleRecord, ScheduleRunHistoryEntry } from "@humansandmachines/gsv/protocol";

export type ProcessViewCall =
  | "proc.ai.config.get"
  | "proc.ai.config.set"
  | "proc.history"
  | "proc.history.segment.read"
  | "proc.history.segments";

export type ProcessViewRequest = <S extends ProcessViewCall>(
  pid: string,
  call: S,
  args: ArgsOf<S>,
) => Promise<ResultOf<S>>;

async function requestProcessView<S extends ProcessViewCall>(
  installationId: string,
  pid: string,
  call: S,
  args: ArgsOf<S>,
): Promise<ResultOf<S>> {
  // SAFETY: call and args are paired by the generic ProcessViewCall contract.
  const frame = {
    type: "req",
    id: crypto.randomUUID(),
    call,
    args,
  } as RequestFrame;
  const response = await sendFrameToProcess(installationId, pid, frame);
  if (!response || response.type !== "res") {
    throw new Error(`${call} did not return a response`);
  }
  if (!response.ok) {
    throw new Error(response.error.message);
  }
  // SAFETY: the process response is validated by its matching request call.
  // SAFETY: response data is selected by the matching syscall response contract.
  return response.data as ResultOf<S>;
}

// just a wrapper to avoid passing the installationId everywhere
export function createProcessViewRequest(
  installationId: string,
): ProcessViewRequest {
  return <S extends ProcessViewCall>(pid: string, call: S, args: ArgsOf<S>) => (
    requestProcessView(installationId, pid, call, args)
  );
}

export type ScheduleViewStore = {
  list(args: {
    ownerUid?: number;
    includeDisabled?: boolean;
    limit?: number;
    offset?: number;
  }): { records: ScheduleRecord[]; count: number };
  history(scheduleId: string, limit?: number): ScheduleRunHistoryEntry[];
};

export type KernelRefs = {
  auth: AuthStore;
  procs: ProcessRegistry;
  devices: DeviceRegistry;
  caps: CapabilityStore;
  config: ConfigStore;
  cron?: CronFileService;
  schedules?: ScheduleViewStore;
  processRequest?: ProcessViewRequest;
};
