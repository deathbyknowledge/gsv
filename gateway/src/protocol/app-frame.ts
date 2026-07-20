/**
 * Request-scoped app execution context injected by the gateway/kernel into
 * package bindings. Package code should never mint or forward this directly.
 */
export type AppFrameContext = {
  uid: number;
  username: string;
  /** Immutable uid of the human whose Kernel controls this runtime. */
  kernelOwnerUid: number;
  /** Canonical human owner used to select `user:<username>`. */
  kernelUsername?: string;
  /** Present for provisioned user Kernels; omitted only by explicit legacy frames. */
  kernelGeneration?: number;
  /** Browser UI frames are bound to one live local app session client. */
  sessionId?: string;
  clientId?: string;
  packageId: string;
  packageName: string;
  /** Exact Master-authoritative package revision this runtime was launched from. */
  packageUpdatedAt: number;
  /** Content-addressed code identity for the launched package runtime. */
  packageArtifactHash: string;
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
const MAX_APP_FRAME_LIFETIME_MS = 366 * 24 * 60 * 60 * 1000;
const MAX_APP_FRAME_CLOCK_SKEW_MS = 5 * 60 * 1000;

export function isAppFrameContextExpired(
  context: AppFrameContext,
  now: number = Date.now(),
): boolean {
  return !Number.isSafeInteger(context.kernelOwnerUid)
    || context.kernelOwnerUid < 0
    || !Number.isSafeInteger(context.issuedAt)
    || !Number.isSafeInteger(context.expiresAt)
    || !Number.isSafeInteger(context.packageUpdatedAt)
    || context.packageUpdatedAt <= 0
    || typeof context.packageArtifactHash !== "string"
    || context.packageArtifactHash.trim().length === 0
    || context.issuedAt <= 0
    || context.expiresAt <= context.issuedAt
    || context.expiresAt <= now
    || context.issuedAt > now + MAX_APP_FRAME_CLOCK_SKEW_MS
    || context.expiresAt - context.issuedAt > MAX_APP_FRAME_LIFETIME_MS;
}
