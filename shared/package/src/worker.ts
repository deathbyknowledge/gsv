export type {
  PackageCapabilityMeta,
  PackageMeta,
  PackageWindowMeta,
} from "./manifest";
export { definePackage } from "./manifest";
export type { KernelClientLike } from "./context";

import type {
  KernelClientLike,
  PackageAppSessionBinding,
  PackageDaemonContext,
  PackageMetaBinding,
  PackageViewerBinding,
} from "./context";

/**
 * TODO(app-storage): We are intentionally not exposing package/app-private
 * durable storage through the package SDK yet.
 *
 * The short-lived `PACKAGE_DO` stopgap was removed because it papered over the
 * real design problem instead of solving it. GSV now runs package apps through
 * a stateful app runtime built on Cloudflare Dynamic Workers + Durable Object
 * Facets, scoped by `user/package`.
 *
 * The runtime shape is:
 *
 * ```ts
 * // One supervisor Durable Object per { uid, packageId } app instance.
 * // The supervisor owns routing, auth, watches, notifications, and lifecycle.
 * // It dynamically loads the package worker and instantiates an app facet.
 *
 * export class AppRunner extends DurableObject {
 *   async fetch(request: Request) {
 *     const facet = this.ctx.facets.get("app", async () => {
 *       const worker = this.env.LOADER.get(this.#codeHash(), () => this.#artifact());
 *       return { class: worker.getDurableObjectClass("App") };
 *     });
 *     return facet.fetch(request);
 *   }
 * }
 *
 * // The app facet gets its own isolated SQLite-backed storage while sharing
 * // lifecycle supervision with the parent AppRunner.
 * export class App extends DurableObject {
 *   async fetch(request: Request) {
 *     // app-local durable state here
 *   }
 * }
 * ```
 *
 * In GSV terms that means:
 * - scope: one durable app state container per `user/package`
 * - supervisor DO responsibilities:
 *   - auth and routing
 *   - package artifact loading/versioning
 *   - durable signal watches and process lifecycle integration
 *   - notifications and background completion hooks
 *   - observability / limits / future billing
 * - facet responsibilities:
 *   - app-private durable state
 *   - app fetch/RPC logic
 * - package code should remain ignorant of platform wiring details
 *
 * The SDK still does not expose app-private storage directly, so package code
 * should continue to treat itself as stateless unless and until we add an
 * explicit app-state API.
 *
 * Until that happens, app code should rely only on:
 * - `ctx.kernel.request(...)` for kernel-facing operations
 * - live browser state
 * - explicit files/knowledge/workspace state where appropriate
 */
export type PackageBaseContext = {
  meta: PackageMetaBinding;
  viewer: PackageViewerBinding;
  app?: PackageAppSessionBinding;
  daemon?: PackageDaemonContext;
  kernel: KernelClientLike;
};

export type PackageSetupContext = PackageBaseContext;

export type PackageCommandContext = PackageBaseContext & {
  argv: string[];
  stdin: {
    text(): Promise<string>;
  };
  stdout: {
    write(text: string): Promise<void>;
  };
  stderr: {
    write(text: string): Promise<void>;
  };
};

export type PackageAppContext = PackageBaseContext;

export type PackageAppSignalContext = PackageAppContext & {
  signal: string;
  payload: unknown;
  sourcePid?: string | null;
  watch: {
    id: string;
    key?: string;
    state?: unknown;
    createdAt?: number;
  };
};

export type PackageAppRpcContext = PackageAppContext;

export type PackageAppRpcHandler = (
  args: unknown,
  ctx: PackageAppRpcContext,
) => Promise<unknown> | unknown;

export type PackageBrowserAppDefinition = {
  entry: string;
};

export type PackageSetupHandler = (
  ctx: PackageSetupContext,
) => Promise<void> | void;

export type PackageCommandHandler = (
  ctx: PackageCommandContext,
) => Promise<void> | void;

export type PackageAppDefinition = {
  browser?: PackageBrowserAppDefinition;
  assets?: string[];
  fetch?(request: Request, ctx: PackageAppContext): Promise<Response> | Response;
  onSignal?(ctx: PackageAppSignalContext): Promise<void> | void;
  rpc?: Record<string, PackageAppRpcHandler>;
};

export type PackageDefinition = {
  meta: import("./manifest").PackageMeta;
  setup?: PackageSetupHandler;
  commands?: Record<string, PackageCommandHandler>;
  app?: PackageAppDefinition;
};
