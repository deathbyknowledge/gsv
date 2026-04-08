import type { ArgsOf, ResultOf, SyscallName } from "../syscalls";

/**
 * Request-scoped app execution context injected by the gateway/kernel into
 * package bindings. Package code should never mint or forward this directly.
 */
export type AppFrameContext = {
  uid: number;
  username: string;
  packageId: string;
  packageName: string;
  entrypointName: string;
  routeBase: string;
  issuedAt: number;
  expiresAt: number;
};

export type PackageAppProps = {
  appFrame: AppFrameContext;
  packageDoName: string;
  kernel: AppKernelBinding;
  package: PackageStateBinding;
};

export type KernelBindingProps = {
  appFrame: AppFrameContext;
};

export type PackageBindingProps = {
  appFrame: AppFrameContext;
  packageDoName: string;
};

/**
 * App kernel requests are request/response only.
 *
 * Apps can issue routed syscalls (for example device-targeted fs/shell calls),
 * but they do not receive arbitrary signals. Routed responses are awaited
 * directly through the appRequest RPC path.
 */
export type AppKernelRequestMode = "request-response";

export type AppKernelBinding = {
  request: <S extends SyscallName>(call: S, args: ArgsOf<S>) => Promise<ResultOf<S>>;
};

export type PackageStateBinding = {
  sqlExec: (statement: string, params?: unknown[]) => Promise<{ rowsWritten?: number }>;
  sqlQuery: (statement: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
};

export const DEFAULT_APP_FRAME_TTL_MS = 5 * 60 * 1000;

export function isAppFrameContextExpired(
  context: AppFrameContext,
  now: number = Date.now(),
): boolean {
  return context.expiresAt <= now;
}
