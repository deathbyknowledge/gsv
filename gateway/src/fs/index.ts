/**
 * Filesystem module — unified GsvFs plus mount/backing-store helpers.
 */

export { GsvFs } from "./gsv-fs";
export type { ExtendedStat } from "./gsv-fs";
export type { KernelRefs } from "./refs";
export type {
  MountBackend,
  ExtendedMountStat,
  FsSearchBackendResult,
} from "./mount";
export { KernelMountBackend } from "./backends/kernel";
export { createHomeKnowledgeBackend } from "./backends/home-knowledge";
export { createPackageBackend, isPackageMountPath } from "./backends/packages";
export { createProcessSourceBackend, isProcessSourceMountPath } from "./backends/process-sources";
export { R2MountBackend } from "./backends/r2";
export { RipgitClient } from "./ripgit/client";
export type {
  RipgitApplyOp,
  RipgitPathResult,
  RipgitRepoRef,
  RipgitTreeEntry,
} from "./ripgit/client";
export {
  createWorkspaceBackend,
  isWorkspaceMountPath,
  workspaceRootPath,
} from "./backends/workspace";
export {
  homeKnowledgeRepoRef,
  workspaceRepoRef,
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
