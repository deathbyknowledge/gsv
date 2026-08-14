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
