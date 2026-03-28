import type { ArgsOf, ResultOf, SyscallName } from "../syscalls";
import type { AppSession } from "./contracts";

export const APP_RUNTIME_BACKEND_COMPATIBILITY_DATE = "2026-03-24";
export const APP_RUNTIME_BACKEND_COMPATIBILITY_FLAGS = ["nodejs_compat"] as const;

export type AppCommandInvocation = {
  name: string;
  binaryName: string;
  argv: string[];
};

export type AppCommandExecutionRequest = {
  command: AppCommandInvocation;
};

export type AppCommandExecutionResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type DynamicWorkerAppBackendProps = {
  session: AppSession;
};

export type AppBackendKernelCallRequest<S extends SyscallName = SyscallName> = {
  session: AppSession;
  syscall: S;
  args: ArgsOf<S>;
};

export type AppBackendKernelDispatcher = {
  appBackendSyscall<S extends SyscallName>(
    request: AppBackendKernelCallRequest<S>,
  ): Promise<ResultOf<S>>;
};

export type DynamicWorkerKernelBindingProps = {
  session: AppSession;
  allowedSyscalls: SyscallName[];
  kernel: AppBackendKernelDispatcher;
};

export type DynamicWorkerKernelBinding = {
  call<S extends SyscallName>(syscall: S, args: ArgsOf<S>): Promise<ResultOf<S>>;
};

export type DynamicWorkerCommandEntrypoint = {
  execCommand(input: AppCommandExecutionRequest): Promise<AppCommandExecutionResult>;
};
