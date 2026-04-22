/**
 * Deprecated package entrypoint.
 *
 * Packages should import from:
 * - `@gsv/package/manifest`
 * - `@gsv/package/backend`
 * - `@gsv/package/browser`
 * - `@gsv/package/cli`
 *
 * This shim remains only so old code can keep resolving module paths while the
 * package contract moves to the new explicit entrypoint surface.
 */

export { definePackage } from "./manifest";
export type {
  PackageBackendBindings,
  KernelClientLike,
  PackageAppSessionBinding,
  PackageDaemonContext,
  PackageDaemonInvocation,
  PackageDaemonSchedule,
  PackageDaemonScheduleRecord,
  PackageMetaBinding,
  PackageSignalContext,
  PackageSignalWatchInfo,
  PackageViewerBinding,
} from "./backend";
export { PackageBackendEntrypoint } from "./backend";
export {
  connectBackend,
  getBackend,
  connectAppBackend,
  getAppBoot,
  hasAppBoot,
} from "./browser";
export { defineCommand } from "./cli";
