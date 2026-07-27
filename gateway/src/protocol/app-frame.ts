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

export type PackageAppSignalWatchInfo = {
  id: string;
  key?: string;
  state?: unknown;
  createdAt?: number;
};

export type KernelBindingProps = {
  appFrame: AppFrameContext;
};

export const DEFAULT_APP_FRAME_TTL_MS = 5 * 60 * 1000;

export function isAppFrameContextExpired(
  context: AppFrameContext,
  now: number = Date.now(),
): boolean {
  return context.expiresAt <= now;
}
