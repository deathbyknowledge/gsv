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
  appSession?: {
    sessionId: string;
    clientId: string;
    rpcBase: string;
    expiresAt: number;
  };
  kernel: AppKernelBinding;
};

export type PackageAppSignalWatchInfo = {
  id: string;
  key?: string;
  state?: unknown;
  createdAt?: number;
};

export type PackageAppSignalProps = PackageAppProps & {
  signal: string;
  payload?: unknown;
  sourcePid?: string | null;
  watch: PackageAppSignalWatchInfo;
};

export type KernelBindingProps = {
  appFrame: AppFrameContext;
};

/**
 * App kernel requests are request/response only.
 *
 * Apps can issue routed syscalls (for example device-targeted fs/shell calls).
 * They can also register durable signal watches; matched signals are handled
 * by app backend `onSignal(...)` handlers in Worker/DO context.
 */
export type AppKernelRequestMode = "request-response";

export type AppKernelBinding = {
  request: <S extends SyscallName>(call: S, args: ArgsOf<S>) => Promise<ResultOf<S>>;
};

export const DEFAULT_APP_FRAME_TTL_MS = 5 * 60 * 1000;

export function isAppFrameContextExpired(
  context: AppFrameContext,
  now: number = Date.now(),
): boolean {
  return context.expiresAt <= now;
}
