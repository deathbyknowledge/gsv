import type { SyscallName } from "../syscalls";

const INTERNAL_ONLY_SYSCALLS = new Set<SyscallName>([
  "ai.config",
  "ai.tools",
  "codemode.exec",
  "proc.mind.deliver",
  "proc.mind.message",
  "proc.ipc.deliver",
  "social.inbound",
]);

export function isInternalOnlySyscall(call: SyscallName): boolean {
  return INTERNAL_ONLY_SYSCALLS.has(call);
}
