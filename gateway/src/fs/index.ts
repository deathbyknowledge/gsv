/**
 * Filesystem module — unified GsvFs plus mount/backing-store helpers.
 */

export { GsvFs } from "./gsv-fs";
export type { ExtendedStat } from "./gsv-fs";
export type { KernelRefs } from "./refs";
export { requestProcessView } from "./refs";
export type {
  MountBackend,
  ExtendedMountStat,
  FsSearchBackendResult,
} from "./mount";
export { KernelMountBackend } from "./backends/kernel";
export { createAccountHomeBackend } from "./backends/account-home";
export { createPackageBackend, isPackageMountPath } from "./backends/packages";
export {
  commitProcessSourceChanges,
  createProcessSourceBackend,
  diffProcessSourceChanges,
  discardProcessSourceChanges,
  getProcessSourceStatus,
  isProcessSourceMountPath,
  packageSourcePathNameForRecord,
  packageSourcePathNameMap,
  packageSourcePathName,
} from "./backends/process-sources";
export type {
  ProcessSourceChangeSummary,
  ProcessSourceCommitResult,
  ProcessSourceStatus,
} from "./backends/process-sources";
export { R2MountBackend } from "./backends/r2";
export { RipgitClient } from "./ripgit/client";
export type {
  RipgitApplyOp,
  RipgitPathResult,
  RipgitRepoRef,
  RipgitTreeEntry,
} from "./ripgit/client";
export {
  accountHomeRepoRef,
} from "./ripgit/repos";
export {
  resolveUserPath,
  normalizePath,
  parseMode,
  isValidMode,
  formatSize,
  isTextContentType,
  inferContentType,
} from "./utils";
