import type { ConsoleProcess } from "./consoleModels";

export function isConsoleWorkProcess(process: ConsoleProcess): boolean {
  return !process.personal;
}

export function consoleWorkProcesses(processes: readonly ConsoleProcess[]): ConsoleProcess[] {
  return processes.filter(isConsoleWorkProcess);
}

export function findConsoleWorkProcess(
  processes: readonly ConsoleProcess[],
  pid: string,
): ConsoleProcess | null {
  return processes.find((process) => process.pid === pid && isConsoleWorkProcess(process)) ?? null;
}

export function consoleActivityProcesses(processes: readonly ConsoleProcess[]): ConsoleProcess[] {
  return [...processes].sort((left, right) => (
    Number(right.personal) - Number(left.personal)
    || (right.lastActiveAt ?? right.createdAt ?? 0) - (left.lastActiveAt ?? left.createdAt ?? 0)
    || left.label.localeCompare(right.label)
  ));
}

export function findConsoleProcess(
  processes: readonly ConsoleProcess[],
  pid: string,
): ConsoleProcess | null {
  return processes.find((process) => process.pid === pid) ?? null;
}

/** The personal process, the Kernel-marked handler of the Ship conversation; null before one exists. */
export function findConsolePersonalProcess(processes: readonly ConsoleProcess[]): ConsoleProcess | null {
  return processes.find((process) => process.personal) ?? null;
}
