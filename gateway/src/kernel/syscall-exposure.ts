import type { SyscallName } from "../syscalls";

const INTERNAL_ONLY_SYSCALLS = new Set<SyscallName>([
  "ai.config",
  "ai.tools",
  "codemode.exec",
  "proc.ai.config.get",
  "proc.ai.config.set",
  "proc.ipc.deliver",
]);

export function isInternalOnlySyscall(call: SyscallName): boolean {
  return INTERNAL_ONLY_SYSCALLS.has(call);
}
