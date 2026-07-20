export const USER_PROCESS_SIGNALS = [
  "proc.changed",
  "proc.run.started",
  "proc.run.stream",
  "proc.run.retrying",
  "proc.run.output",
  "proc.run.tool.started",
  "proc.run.hil.requested",
  "proc.run.finished",
  "process.exit",
] as const;

export const USER_CONNECTION_SIGNALS = [
  ...USER_PROCESS_SIGNALS,
  "device.status",
  "adapter.status",
  "pkg.changed",
  "config.changed",
  "mcp.changed",
  "notification.created",
  "notification.updated",
  "notification.dismissed",
] as const;

const USER_PROCESS_SIGNAL_SET = new Set<string>(USER_PROCESS_SIGNALS);

export function isUserProcessSignal(signal: string): boolean {
  return USER_PROCESS_SIGNAL_SET.has(signal);
}
