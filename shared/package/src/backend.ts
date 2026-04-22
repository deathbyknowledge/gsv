import type {
  KernelClientLike,
  PackageAppSessionBinding,
  PackageDaemonContext,
  PackageMetaBinding,
  PackageSignalContext,
  PackageViewerBinding,
} from "./context";

export type PackageBackendBindings = {
  meta: PackageMetaBinding;
  kernel: KernelClientLike;
  viewer?: PackageViewerBinding;
  app?: PackageAppSessionBinding;
  daemon?: PackageDaemonContext;
};

export abstract class PackageBackendEntrypoint implements PackageBackendBindings {
  meta!: PackageMetaBinding;
  kernel!: KernelClientLike;
  viewer?: PackageViewerBinding;
  app?: PackageAppSessionBinding;
  daemon?: PackageDaemonContext;

  async fetch(_request: Request): Promise<Response> {
    return new Response("Not Found", { status: 404 });
  }

  async onSignal(_ctx: PackageSignalContext): Promise<void> {
    // Default no-op hook.
  }
}

export type {
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
} from "./context";
