import type {
  AppAttachArgs,
  AppCloseArgs,
  AppCloseResult,
  AppDetachArgs,
  AppDetachResult,
  AppLaunchResult,
  AppListArgs,
  AppListResult,
  AppOpenArgs,
  AppSessionSummary,
} from "@humansandmachines/gsv/protocol";
import {
  buildAppClientRouteBase,
  type AppSessionContext,
  type IssuedAppClientSession,
} from "../protocol/app-session";
import type { KernelContext } from "./context";
import {
  type InstalledPackageRecord,
  type PackageEntrypoint,
  packageRouteBase,
  visiblePackageScopesForActor,
} from "./packages";
import { APP_CLIENT_SESSION_TTL_MS } from "./app-sessions";

const APP_LAUNCH_RESERVED_PATHS = new Set(["/launch", "/refresh", "/socket"]);

export class AppSyscallError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export async function handleAppOpen(args: AppOpenArgs, ctx: KernelContext): Promise<AppLaunchResult> {
  const actor = currentActor(ctx);
  const packageName = normalizeRequiredString(args.packageName, "packageName");
  const entrypointName = normalizeOptionalString(args.entrypointName);
  const routeBase = packageRouteBase(packageName);
  const resolved = findLaunchableUiPackage(ctx, actor.uid, packageName, routeBase, entrypointName);

  const clientSession = await ctx.appSessions.issue({
    uid: actor.uid,
    username: actor.username,
    packageId: resolved.record.packageId,
    packageName: resolved.record.manifest.name,
    entrypointName: resolved.entrypoint.name,
    routeBase,
    clientId: normalizeOptionalString(args.clientId) ?? crypto.randomUUID(),
    ttlMs: APP_CLIENT_SESSION_TTL_MS,
  });

  return toLaunchResult(clientSession, resolved.entrypoint, args);
}

export async function handleAppAttach(args: AppAttachArgs, ctx: KernelContext): Promise<AppLaunchResult> {
  const actor = currentActor(ctx);
  const sessionId = normalizeRequiredString(args.sessionId, "sessionId");
  const clientSession = await ctx.appSessions.attach({
    uid: actor.uid,
    sessionId,
    clientId: normalizeOptionalString(args.clientId) ?? crypto.randomUUID(),
    ttlMs: APP_CLIENT_SESSION_TTL_MS,
  });
  if (!clientSession) {
    throw new AppSyscallError(404, "App session not found");
  }

  const resolved = findLaunchableUiPackage(
    ctx,
    actor.uid,
    clientSession.packageName,
    clientSession.routeBase,
    clientSession.entrypointName,
  );
  return toLaunchResult(clientSession, resolved.entrypoint, args);
}

export function handleAppList(_args: AppListArgs, ctx: KernelContext): AppListResult {
  const actor = currentActor(ctx);
  return {
    sessions: ctx.appSessions.list(actor.uid).map(toSessionSummary),
  };
}

export async function handleAppDetach(args: AppDetachArgs, ctx: KernelContext): Promise<AppDetachResult> {
  const actor = currentActor(ctx);
  const sessionId = normalizeRequiredString(args.sessionId, "sessionId");
  const clientId = normalizeRequiredString(args.clientId, "clientId");
  const detachedClient = ctx.appSessions.detach(actor.uid, sessionId, clientId);
  if (detachedClient) {
    ctx.signalWatches.removeByAppClient(actor.uid, detachedClient.sessionId, detachedClient.clientId);
    await closeRunnerAppClient(ctx, detachedClient);
  }
  return {
    detached: Boolean(detachedClient),
  };
}

export async function handleAppClose(args: AppCloseArgs, ctx: KernelContext): Promise<AppCloseResult> {
  const actor = currentActor(ctx);
  const sessionId = normalizeRequiredString(args.sessionId, "sessionId");
  const closedSession = ctx.appSessions.close(actor.uid, sessionId);
  if (closedSession) {
    ctx.signalWatches.removeByAppSession(actor.uid, closedSession.sessionId);
    await closeRunnerAppSession(ctx, closedSession);
  }
  return {
    closed: Boolean(closedSession),
  };
}

function currentActor(ctx: KernelContext): { uid: number; username: string } {
  const process = ctx.identity?.process;
  if (!process) {
    throw new AppSyscallError(401, "Authentication required");
  }
  return {
    uid: process.uid,
    username: process.username,
  };
}

function findLaunchableUiPackage(
  ctx: KernelContext,
  uid: number,
  packageName: string,
  routeBase: string,
  entrypointName: string | null,
): { record: InstalledPackageRecord; entrypoint: PackageEntrypoint } {
  for (const record of ctx.packages.list({
    enabled: true,
    name: packageName,
    runtime: "web-ui",
    scopes: visiblePackageScopesForActor({ uid }),
  })) {
    const entrypoint = record.manifest.entrypoints.find((candidate) => {
      return candidate.kind === "ui" &&
        candidate.route === routeBase &&
        (!entrypointName || candidate.name === entrypointName);
    });
    if (entrypoint) {
      return { record, entrypoint };
    }
  }

  throw new AppSyscallError(404, "Package app not found");
}

function toLaunchResult(
  session: IssuedAppClientSession,
  entrypoint: PackageEntrypoint,
  args: Pick<AppOpenArgs, "suffix" | "search" | "hash">,
): AppLaunchResult {
  return {
    sessionId: session.sessionId,
    packageId: session.packageId,
    packageName: session.packageName,
    entrypointName: session.entrypointName,
    routeBase: session.routeBase,
    clientId: session.clientId,
    launchUrl: buildLaunchUrl(session, args),
    launchToken: session.secret,
    expiresAt: session.expiresAt,
    window: {
      title: entrypoint.name,
      ...entrypoint.windowDefaults,
    },
  };
}

function toSessionSummary(session: AppSessionContext): AppSessionSummary {
  return {
    sessionId: session.sessionId,
    packageId: session.packageId,
    packageName: session.packageName,
    entrypointName: session.entrypointName,
    routeBase: session.routeBase,
    createdAt: session.createdAt,
    lastUsedAt: session.lastUsedAt ?? null,
    expiresAt: session.expiresAt,
    state: session.state,
    clients: session.clients.map((client) => ({
      clientId: client.clientId,
      createdAt: client.createdAt,
      lastUsedAt: client.lastUsedAt ?? null,
      expiresAt: client.expiresAt,
      state: "active",
    })),
  };
}

async function closeRunnerAppSession(ctx: KernelContext, session: AppSessionContext): Promise<void> {
  const runner = ctx.getAppRunner?.(session.uid, session.packageId) as {
    closeAppSession?: (sessionId: string) => Promise<unknown>;
  } | undefined;
  if (!runner?.closeAppSession) {
    return;
  }
  await runner.closeAppSession(session.sessionId);
}

async function closeRunnerAppClient(
  ctx: KernelContext,
  client: Pick<IssuedAppClientSession, "uid" | "packageId" | "sessionId" | "clientId">,
): Promise<void> {
  const runner = ctx.getAppRunner?.(client.uid, client.packageId) as {
    closeAppClient?: (sessionId: string, clientId: string) => Promise<unknown>;
  } | undefined;
  if (!runner?.closeAppClient) {
    return;
  }
  await runner.closeAppClient(client.sessionId, client.clientId);
}

function buildLaunchUrl(
  session: IssuedAppClientSession,
  args: Pick<AppOpenArgs, "suffix" | "search" | "hash">,
): string {
  const next = buildLaunchNext(args);
  if (next !== "/") {
    return `${buildAppClientRouteBase(session.sessionId, session.clientId)}${next}`;
  }
  return `${buildAppClientRouteBase(session.sessionId, session.clientId)}/`;
}

function buildLaunchNext(args: Pick<AppOpenArgs, "suffix" | "search" | "hash">): string {
  const suffix = normalizeSuffix(args.suffix);
  const search = normalizeSearch(args.search);
  const hash = normalizeHash(args.hash);
  return `${suffix}${search}${hash}`;
}

function normalizeRequiredString(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new AppSyscallError(400, `${name} is required`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new AppSyscallError(400, `${name} is required`);
  }
  return trimmed;
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeSuffix(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    return "/";
  }
  const trimmed = value.trim();
  const pathname = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return APP_LAUNCH_RESERVED_PATHS.has(pathname) ? "/" : pathname;
}

function normalizeSearch(value: unknown): string {
  if (typeof value !== "string" || !value) {
    return "";
  }
  return value.startsWith("?") ? value : `?${value}`;
}

function normalizeHash(value: unknown): string {
  if (typeof value !== "string" || !value) {
    return "";
  }
  return value.startsWith("#") ? value : `#${value}`;
}
