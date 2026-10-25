import { env } from "cloudflare:workers";
import type {
  InstallationDirectoryResult,
  ManagedInstallationState,
} from "@humansandmachines/gsv/protocol";
import type { InstallationDirectoryService } from "@humansandmachines/gsv/services/directory";
import { exceptionDiagnostics } from "@humansandmachines/gsv/telemetry";
import type { Kernel } from "../kernel/do";
import {
  parseInstallationId,
  type InstallationIdentity,
} from "./identity";
import { SHIP_UNREACHABLE_MESSAGE } from "./lifecycle";
import type { GatewayEnv } from "../runtime-env";

const PROCESS_DURABLE_OBJECT_PREFIX = "process:";
const CONVERSATION_DURABLE_OBJECT_PREFIX = "conversation:";
const MAX_DURABLE_OBJECT_NAME_BYTES = 1_024;

export type ProcessDurableObjectIdentity = {
  installationId: string;
  pid: string;
};

export type ConversationDurableObjectIdentity = {
  installationId: string;
  conversationId: string;
};

export function processDurableObjectName(
  installationId: string,
  pid: string,
): string {
  const parsedInstallationId = parseInstallationId(installationId);
  const parsedPid = parseProcessId(pid);
  const name = `${PROCESS_DURABLE_OBJECT_PREFIX}${encodeURIComponent(parsedInstallationId)}:${encodeURIComponent(parsedPid)}`;
  assertProcessDurableObjectNameLength(name);
  return name;
}

export function parseProcessDurableObjectName(
  name: string | undefined,
): ProcessDurableObjectIdentity {
  if (!name)
    throw new Error("Process Durable Objects must be accessed by name");

  if (!name.startsWith(PROCESS_DURABLE_OBJECT_PREFIX)) {
    throw new Error("Process Durable Object name is invalid");
  }

  const separator = name.indexOf(":", PROCESS_DURABLE_OBJECT_PREFIX.length);
  if (separator === -1)
    throw new Error("Process Durable Object name is invalid");

  try {
    const installationId = parseInstallationId(decodeURIComponent(
      name.slice(PROCESS_DURABLE_OBJECT_PREFIX.length, separator),
    ));
    const pid = parseProcessId(decodeURIComponent(name.slice(separator + 1)));
    if (processDurableObjectName(installationId, pid) !== name)
      throw new Error("Process Durable Object name is not canonical");

    return { installationId, pid };
  } catch (error) {
    if (error instanceof Error && error.message === "Process Durable Object name is not canonical") {
      throw error;
    }
    throw new Error("Process Durable Object name is invalid");
  }
}

function parseProcessId(value: string): string {
  if (value.length === 0)
    throw new Error("pid must be a non-empty string");
  return value;
}

function assertProcessDurableObjectNameLength(name: string): void {
  if (new TextEncoder().encode(name).byteLength > MAX_DURABLE_OBJECT_NAME_BYTES) {
    throw new Error("Process Durable Object name is too long");
  }
}

export function conversationDurableObjectName(
  installationId: string,
  conversationId: string,
): string {
  const parsedInstallationId = parseInstallationId(installationId);
  const parsedConversationId = parseConversationId(conversationId);
  const name = `${CONVERSATION_DURABLE_OBJECT_PREFIX}${encodeURIComponent(parsedInstallationId)}:${encodeURIComponent(parsedConversationId)}`;
  assertDurableObjectNameLength(name);
  return name;
}

export function parseConversationDurableObjectName(
  name: string | undefined,
): ConversationDurableObjectIdentity {
  if (!name) {
    throw new Error("Conversation Durable Objects must be accessed by name");
  }
  if (!name.startsWith(CONVERSATION_DURABLE_OBJECT_PREFIX)) {
    throw new Error("Conversation Durable Object name is invalid");
  }
  const separator = name.indexOf(":", CONVERSATION_DURABLE_OBJECT_PREFIX.length);
  if (separator === -1) {
    throw new Error("Conversation Durable Object name is invalid");
  }
  try {
    const installationId = parseInstallationId(decodeURIComponent(
      name.slice(CONVERSATION_DURABLE_OBJECT_PREFIX.length, separator),
    ));
    const conversationId = parseConversationId(decodeURIComponent(name.slice(separator + 1)));
    if (conversationDurableObjectName(installationId, conversationId) !== name) {
      throw new Error("Conversation Durable Object name is not canonical");
    }
    return { installationId, conversationId };
  } catch (error) {
    if (
      error instanceof Error
      && error.message === "Conversation Durable Object name is not canonical"
    ) {
      throw error;
    }
    throw new Error("Conversation Durable Object name is invalid");
  }
}

function parseConversationId(value: string): string {
  if (value.length === 0) {
    throw new Error("conversationId must be a non-empty string");
  }
  return value;
}

function assertDurableObjectNameLength(name: string): void {
  if (new TextEncoder().encode(name).byteLength > MAX_DURABLE_OBJECT_NAME_BYTES) {
    throw new Error("Durable Object name is too long");
  }
}

export type InstallationRoute = { identity: InstallationIdentity };

/** How long an active route answers a hostname's public reads before Accounts is asked again. */
const ROUTE_CONFIRMATION_MS = 60_000;
/** Hostnames one isolate remembers routes for; the oldest answer gives way first. */
const REMEMBERED_HOSTNAMES = 1_024;
/**
 * How long a request waits for Accounts to route its hostname. Accounts
 * answers in milliseconds, and within a few seconds in its slowest minutes;
 * a lookup still waiting by then has stalled, and the request ends with an
 * answer it can retry instead of hanging.
 */
const ROUTE_LOOKUP_TIMEOUT_MS = 5_000;

/** Accounts did not route the hostname in time; the request may be retried. */
export class InstallationRouteUnavailable extends Error {
  constructor(options?: ErrorOptions) {
    super(SHIP_UNREACHABLE_MESSAGE, options);
    this.name = "InstallationRouteUnavailable";
  }
}

type RememberedRoute = { route: InstallationRoute; confirmedAt: number };
type HostnameRoutes = {
  remembered: Map<string, RememberedRoute>;
  lookups: Map<string, Promise<InstallationDirectoryResult>>;
};

/**
 * Each isolate's routes, per directory binding. Only an active route is
 * remembered. A hostname Accounts does not route, routes to a Ship that is
 * not active, or cannot answer for is asked again on every request, so a
 * random wildcard hostname still allocates nothing, and any newer answer
 * replaces a remembered one.
 */
const hostnameRoutes = new WeakMap<InstallationDirectoryService, HostnameRoutes>();

/**
 * Routes a request's hostname through Accounts. A `cached` request, a public
 * read, may take an active route Accounts gave within the last minute and
 * share a lookup already under way; any other request asks Accounts itself.
 */
export async function resolveInstallationRoute(
  request: Request,
  options: { allowProvisioning?: boolean; cached?: boolean } = {},
): Promise<InstallationRoute | null> {
  const hostname = new URL(request.url).hostname;
  const directory = installationDirectory();
  if (!directory) throw new Error("Installation directory is not configured");
  const routes = routesFor(directory);
  const remembered = routes.remembered.get(hostname);
  if (options.cached && remembered && Date.now() - remembered.confirmedAt < ROUTE_CONFIRMATION_MS) {
    return remembered.route;
  }
  let lookup = options.cached ? routes.lookups.get(hostname) : undefined;
  if (!lookup) {
    lookup = lookUpHostname(directory, routes, hostname);
    if (options.cached) {
      lookup = lookup.finally(() => routes.lookups.delete(hostname));
      routes.lookups.set(hostname, lookup);
    }
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let result: InstallationDirectoryResult;
  try {
    result = await Promise.race([
      lookup,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Accounts lookup timed out")), ROUTE_LOOKUP_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    console.warn("[Gateway] Accounts route lookup failed:", exceptionDiagnostics(error));
    throw new InstallationRouteUnavailable({ cause: error });
  } finally {
    clearTimeout(timer);
  }
  return routeFor(result, options.allowProvisioning ?? false);
}

/** Forgets a hostname's remembered route, as when the Kernel it names refuses the request. */
export function forgetInstallationRoute(request: Request): void {
  const directory = installationDirectory();
  if (directory) hostnameRoutes.get(directory)?.remembered.delete(new URL(request.url).hostname);
}

function routesFor(directory: InstallationDirectoryService): HostnameRoutes {
  let routes = hostnameRoutes.get(directory);
  if (!routes) {
    routes = { remembered: new Map(), lookups: new Map() };
    hostnameRoutes.set(directory, routes);
  }
  return routes;
}

function installationDirectory(): InstallationDirectoryService | undefined {
  // SAFETY: Deployment binds the trusted directory RPC contract described by GatewayEnv.
  return (env as Env & GatewayEnv).INSTALLATION_DIRECTORY;
}

/** Asks Accounts, then remembers its answer if that is an active route; any other answer forgets the hostname's route. */
async function lookUpHostname(
  directory: InstallationDirectoryService,
  routes: HostnameRoutes,
  hostname: string,
): Promise<InstallationDirectoryResult> {
  const askedAt = Date.now();
  const result = await directory.resolveHostname(hostname);
  routes.remembered.delete(hostname);
  const route = routeFor(result, false);
  if (route) {
    routes.remembered.set(hostname, { route, confirmedAt: askedAt });
    for (const oldest of routes.remembered.keys()) {
      if (routes.remembered.size <= REMEMBERED_HOSTNAMES) break;
      routes.remembered.delete(oldest);
    }
  }
  return result;
}

function routeFor(result: InstallationDirectoryResult, allowProvisioning: boolean): InstallationRoute | null {
  if (!result.found || !isRoutableManagedInstallationState(
    result.state,
    allowProvisioning,
  )) {
    return null;
  }

  let installationId: string;
  try {
    installationId = parseInstallationId(result.installationId);
    assertLiveKernelAdmission(installationId);
  } catch {
    return null;
  }

  return {
    identity: {
      installationId,
      canonicalOrigin: result.canonicalOrigin,
      handle: result.handle,
    },
  };
}

export function isRoutableManagedInstallationState(
  state: ManagedInstallationState,
  allowProvisioning: boolean,
): boolean {
  return state === "active" || (allowProvisioning && state === "provisioning");
}

export async function getKernelByInstallationId(
  namespace: DurableObjectNamespace<Kernel>,
  installationId: string,
): Promise<DurableObjectStub<Kernel>> {
  const parsed = parseInstallationId(installationId);
  assertLiveKernelAdmission(parsed);
  return namespace.getByName(parsed);
}

function assertLiveKernelAdmission(installationId: string): void {
  if (installationId === "singleton") {
    throw new Error("Historical singleton Kernel is reserved for attribution and cleanup");
  }
}

// TODO: this should move to wherever we put an actual implementation for it
export type { InstallationDirectoryResult, InstallationDirectoryService };
