/**
 * Filesystem module — unified GsvFs plus mount/backing-store helpers.
 */

export { GsvFs } from "./gsv-fs";
export type { ExtendedStat } from "./gsv-fs";
export type { KernelRefs } from "./kernel-refs";
export type {
  MountBackend,
  ExtendedMountStat,
  FsSearchBackendResult,
} from "./mount-backend";
export { KernelMountBackend } from "./kernel-mount-backend";
export { R2MountBackend } from "./r2-backend";
export { RipgitClient } from "./ripgit-client";
export type {
  RipgitApplyOp,
  RipgitPathResult,
  RipgitRepoRef,
  RipgitTreeEntry,
} from "./ripgit-client";
export {
  createWorkspaceBackend,
  isWorkspaceMountPath,
  workspaceRootPath,
} from "./workspace-backend";
export {
  resolveUserPath,
  normalizePath,
  parseMode,
  isValidMode,
  formatSize,
  isTextContentType,
  inferContentType,
} from "./utils";
