import type { FsReadArgs, FsReadResult } from "./read";
import type { FsWriteArgs, FsWriteResult } from "./write";
import type { FsEditArgs, FsEditResult } from "./edit";
import type { FsDeleteArgs, FsDeleteResult } from "./delete";
import type { FsSearchArgs, FsSearchResult } from "./search";
import type {
  ShellExecArgs,
  ShellExecResult,
  ShellSignalArgs,
  ShellSignalResult,
  ShellListResult,
} from "./shell";
import type {
  ProcSpawnArgs,
  ProcSpawnResult,
  ProcKillArgs,
  ProcKillResult,
  ProcSendArgs,
  ProcSendResult,
  ProcHistoryArgs,
  ProcHistoryResult,
  ProcResetArgs,
  ProcResetResult,
  ProcListArgs,
  ProcListResult,
  ProcSetIdentityArgs,
  ProcSetIdentityResult,
} from "./proc";
import type {
  ConnectArgs,
  ConnectResult,
  SysConfigGetArgs,
  SysConfigGetResult,
  SysConfigSetArgs,
  SysConfigSetResult,
} from "./system";
import type {
  SchedulerListArgs,
  SchedulerListResult,
  SchedulerAddArgs,
  SchedulerRunResult,
  CronJob,
  CronJobPatch,
} from "./scheduler";
import type {
  AiToolsArgs,
  AiToolsResult,
  AiConfigArgs,
  AiConfigResult,
} from "./ai";
import type { IpcSendArgs, IpcSendResult, ChannelStatus } from "./ipc";

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type SyscallDomains = {
  // Filesystem
  "fs.read": { args: FsReadArgs; result: FsReadResult };
  "fs.write": { args: FsWriteArgs; result: FsWriteResult };
  "fs.edit": { args: FsEditArgs; result: FsEditResult };
  "fs.delete": { args: FsDeleteArgs; result: FsDeleteResult };
  "fs.search": { args: FsSearchArgs; result: FsSearchResult };

  // Shell (device commands)
  "shell.exec": { args: ShellExecArgs; result: ShellExecResult };
  "shell.signal": { args: ShellSignalArgs; result: ShellSignalResult };
  "shell.list": { args: Record<string, never>; result: ShellListResult };

  // Process management (OS-level agent processes)
  "proc.spawn": { args: ProcSpawnArgs; result: ProcSpawnResult };
  "proc.kill": { args: ProcKillArgs; result: ProcKillResult };
  "proc.list": { args: ProcListArgs; result: ProcListResult };
  "proc.send": { args: ProcSendArgs; result: ProcSendResult };
  "proc.history": { args: ProcHistoryArgs; result: ProcHistoryResult };
  "proc.reset": { args: ProcResetArgs; result: ProcResetResult };
  "proc.setidentity": { args: ProcSetIdentityArgs; result: ProcSetIdentityResult };

  // System
  "sys.connect": { args: ConnectArgs; result: ConnectResult };
  "sys.config.get": { args: SysConfigGetArgs; result: SysConfigGetResult };
  "sys.config.set": { args: SysConfigSetArgs; result: SysConfigSetResult };

  // Scheduler (cron)
  "sched.list": { args: SchedulerListArgs; result: SchedulerListResult };
  "sched.add": { args: SchedulerAddArgs; result: { job: CronJob } };
  "sched.update": { args: { id: string; patch: CronJobPatch }; result: { job: CronJob } };
  "sched.remove": { args: { id: string }; result: { removed: boolean } };
  "sched.run": { args: { id?: string; mode?: "due" | "force" }; result: SchedulerRunResult };

  // AI (process bootstrap)
  "ai.tools": { args: AiToolsArgs; result: AiToolsResult };
  "ai.config": { args: AiConfigArgs; result: AiConfigResult };

  // IPC (channels)
  "ipc.send": { args: IpcSendArgs; result: IpcSendResult };
  "ipc.status": { args: { channel: string }; result: ChannelStatus };
};

export type SyscallName = keyof SyscallDomains;
export type ArgsOf<S extends SyscallName> = SyscallDomains[S]["args"];
export type ResultOf<S extends SyscallName> = SyscallDomains[S]["result"];

export type SyscallDomain =
  | "fs"
  | "shell"
  | "proc"
  | "sys"
  | "ai"
  | "sched"
  | "ipc";

export function domainOf(syscall: SyscallName): SyscallDomain {
  return syscall.split(".")[0] as SyscallDomain;
}

/**
 * Domains that support device routing via the `target` field.
 * `shell` always requires a device target. `fs` can be native (R2) or device.
 * `proc` is kernel-internal (no device routing).
 */
const ROUTABLE_DOMAINS: SyscallDomain[] = ["fs", "shell"];

/**
 * Inject a `target` property into a tool definition so the LLM can choose
 * where to execute the syscall. Only applicable to routable domains (fs, shell).
 *
 * @param tool - The base tool definition (without target)
 * @param devices - List of accessible online device IDs for this user
 */
export function intoSyscallTool(
  tool: ToolDefinition,
  devices: string[],
): ToolDefinition {
  const required = tool.inputSchema.required as string[];
  const properties = tool.inputSchema.properties as Record<string, unknown>;
  if (
    required.includes("target") ||
    Object.keys(properties).includes("target")
  ) {
    throw new Error(
      `Tool ${tool.name} already has 'target' property. Can't turn into syscall tool.`,
    );
  }

  const deviceList = devices.length > 0 ? devices.join(", ") : "none";

  return {
    name: tool.name,
    description: tool.description,
    inputSchema: {
      type: "object",
      properties: {
        ...properties,
        target: {
          type: "string",
          description: `Target device to execute on. Use "gsv" to execute on the cloud or use one of the accessible online devices: ${deviceList}`,
        },
      },
      required: [...required, "target"],
    },
  };
}

export function isRoutableSyscall(call: SyscallName): boolean {
  return ROUTABLE_DOMAINS.includes(domainOf(call));
}
