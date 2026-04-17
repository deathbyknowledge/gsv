export type PackageWindowMeta = {
  width?: number;
  height?: number;
  minWidth?: number;
  minHeight?: number;
};

export type PackageCapabilityMeta = {
  kernel?: string[];
  outbound?: string[];
};

export type PackageMeta = {
  displayName: string;
  description?: string;
  icon?: string;
  window?: PackageWindowMeta;
  capabilities?: PackageCapabilityMeta;
};

export type TaskScheduleSpec = {
  at?: number;
  afterMs?: number;
  everyMs?: number;
};

export type TaskScheduleOptions = {
  key?: string;
};

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
  meta: {
    packageName: string;
    packageId: string;
    routeBase: string | null;
  };
  viewer: {
    uid: number;
    username: string;
  };
  app?: {
    sessionId: string;
    clientId: string;
    rpcBase: string;
    expiresAt: number;
  };
  kernel: {
    request<T = unknown>(call: string, args?: unknown): Promise<T>;
  };
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

export type TaskTriggerKind = "manual" | "schedule" | "app" | "command";

export type PackageTaskContext = PackageBaseContext & {
  taskName: string;
  trigger: {
    kind: TaskTriggerKind;
    scheduledAt?: number;
  };
  payload: unknown;
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

export type PackageTaskHandler = (
  ctx: PackageTaskContext,
) => Promise<void> | void;

export type PackageAppDefinition = {
  browser?: PackageBrowserAppDefinition;
  assets?: string[];
  fetch?(request: Request, ctx: PackageAppContext): Promise<Response> | Response;
  onSignal?(ctx: PackageAppSignalContext): Promise<void> | void;
  rpc?: Record<string, PackageAppRpcHandler>;
};

export type PackageDefinition = {
  meta: PackageMeta;
  setup?: PackageSetupHandler;
  commands?: Record<string, PackageCommandHandler>;
  app?: PackageAppDefinition;
  tasks?: Record<string, PackageTaskHandler>;
};

export function definePackage<const T extends PackageDefinition>(definition: T): T {
  return definition;
}
