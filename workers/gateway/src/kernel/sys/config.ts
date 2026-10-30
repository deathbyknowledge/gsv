/**
 * sys.config.get / sys.config.set syscall handlers.
 *
 * Thin wrappers around ConfigStore with key-level permission checks.
 *
 * Key format mirrors ConfigStore internals:
 *   "config/ai/models"       → system-wide ordered AI model stack
 *   "config/shell/timeout_ms" → system-wide shell timeout
 *   "users/1000/ai/models"   → owner AI model stack
 *
 * Permission model:
 *   Read:  root reads all; non-root reads own users/{uid}/*, delegated agent
 *          overridable config, and only non-sensitive config/*
 *   Write: root writes all; non-root writes user-overridable config for their
 *          own account and delegated agents
 */

import type { KernelContext } from "../context";
import { identityLinkDirectSurface } from "../adapter-destinations";
import { requirePrincipal } from "../context";
import { resolveCallerOwnerUid } from "../context";
import type {
  SysConfigGetArgs,
  SysConfigGetResult,
  SysConfigSetArgs,
  SysConfigSetResult,
  SysConfigEntry,
} from "@humansandmachines/gsv/protocol";
import { USER_OVERRIDABLE_PREFIXES } from "../config";
import { canOwnerRunAsAccount } from "../account-access";
import { canReadConfigKey } from "../config-access";

function parseUserConfigKey(key: string): { uid: number; sub: string } | null {
  const match = /^users\/(\d+)\/(.+)$/.exec(key);
  if (!match) return null;
  const uid = Number(match[1]);
  if (!Number.isSafeInteger(uid) || uid < 0) return null;
  return { uid, sub: match[2] };
}

function isUserOverridableConfigSubkey(sub: string): boolean {
  return USER_OVERRIDABLE_PREFIXES.some((p) => sub.startsWith(p));
}

function canManageUserConfig(ctx: KernelContext, targetUid: number): boolean {
  const identity = requirePrincipal(ctx).account;
  if (identity.uid === 0) return true;
  const target = ctx.auth.getPasswdByUid(targetUid);
  if (!target) return false;
  return canOwnerRunAsAccount(ctx.auth, resolveCallerOwnerUid(ctx), target, false);
}

function canRead(ctx: KernelContext, key: string): boolean {
  const uid = requirePrincipal(ctx).account.uid;
  if (uid === 0) return true;
  if (key.startsWith("config/")) return canReadConfigKey(uid, key);
  if (canReadConfigKey(uid, key)) return true;

  const parsed = parseUserConfigKey(key);
  if (!parsed || !isUserOverridableConfigSubkey(parsed.sub)) return false;
  return canManageUserConfig(ctx, parsed.uid);
}

function canWrite(ctx: KernelContext, key: string): boolean {
  const uid = requirePrincipal(ctx).account.uid;
  if (uid === 0) return true;
  const parsed = parseUserConfigKey(key);
  if (!parsed || !isUserOverridableConfigSubkey(parsed.sub)) return false;
  return canManageUserConfig(ctx, parsed.uid);
}

function shouldDeleteBlankUserOverride(key: string, value: string): boolean {
  const parsed = parseUserConfigKey(key);
  return parsed !== null &&
    isUserOverridableConfigSubkey(parsed.sub) &&
    value.trim().length === 0;
}

export function handleSysConfigGet(
  args: SysConfigGetArgs,
  ctx: KernelContext,
): SysConfigGetResult {
  const uid = requirePrincipal(ctx).account.uid;
  const config = ctx.config;
  const key = args.key;

  if (key === undefined || key === "") {
    const visible = (uid === 0
      ? config.list("")
      : [
          ...config.list("config/"),
          ...config.list("users/"),
        ]).filter((entry) => canRead(ctx, entry.key));
    return { entries: visible };
  }

  const exact = config.get(key);
  if (exact !== null) {
    if (!canRead(ctx, key)) {
      throw new Error(`Permission denied: cannot read ${key}`);
    }
    return { entries: [{ key, value: exact }] };
  }

  const prefix = key.endsWith("/") ? key : key + "/";
  const listed = config.list(prefix);

  const entries: SysConfigEntry[] = [];
  for (const entry of listed) {
    if (canRead(ctx, entry.key)) {
      entries.push(entry);
    }
  }

  if (entries.length === 0 && !key.includes("/")) {
    const scoped = config.list(key);
    for (const entry of scoped) {
      if (canRead(ctx, entry.key)) {
        entries.push(entry);
      }
    }
  }

  return { entries };
}

export async function handleSysConfigSet(
  args: SysConfigSetArgs,
  ctx: KernelContext,
): Promise<SysConfigSetResult> {
  const principal = requirePrincipal(ctx);
  const uid = principal.account.uid;

  if (!args.key) {
    throw new Error("sys.config.set requires a key");
  }
  const copyFromKey = args.copyFromKey?.trim() ?? "";
  if ((args.value === undefined || args.value === null) && !copyFromKey) {
    throw new Error("sys.config.set requires a value");
  }

  if (!canWrite(ctx, args.key)) {
    if (uid !== 0 && args.key.startsWith("config/")) {
      throw new Error(`Permission denied: only root can set system config (${args.key})`);
    }
    const parsed = parseUserConfigKey(args.key);
    if (uid !== 0 && parsed && !canManageUserConfig(ctx, parsed.uid)) {
      throw new Error(`Permission denied: cannot write another user's config (${args.key})`);
    }
    const sub = parsed?.sub ?? args.key;
    throw new Error(
      `Permission denied: key "${sub}" is not user-overridable (allowed prefixes: ${USER_OVERRIDABLE_PREFIXES.join(", ")})`,
    );
  }

  if (copyFromKey && !canRead(ctx, copyFromKey)) {
    throw new Error(`Permission denied: cannot read ${copyFromKey}`);
  }

  const value = copyFromKey
    ? ctx.config.get(copyFromKey)
    : String(args.value);
  if (value === null) {
    throw new Error(`Config source not found: ${copyFromKey}`);
  }
  if (shouldDeleteBlankUserOverride(args.key, value)) {
    ctx.config.delete(args.key);
    return { ok: true };
  }

  ctx.config.set(args.key, value);
  if (principal.kind === "human" && !ctx.processId && uid >= 1000
    && args.key === `users/${uid}/ui/welcome_card_seen` && value === "1") {
    routeFirstRunToChosenMessenger(ctx, uid);
    if (ctx.welcome.activate(uid)) await ctx.reconcileResponsibilityWake(uid);
  }
  return { ok: true };
}

/**
 * The first run ends with where the person wants to message Ship. A messenger choice makes that
 * messenger's DM Ship's private destination, so the greeting lands there before anyone has written
 * from it; web and Desktop leave routing to the client that is open. Pairing alone decides nothing.
 */
function routeFirstRunToChosenMessenger(ctx: KernelContext, uid: number): void {
  const chosen = ctx.config.get(`users/${uid}/ui/preferred_surface`);
  if (chosen === null || chosen === "web" || chosen === "desktop") return;
  const link = ctx.adapters.identityLinks.list(uid)
    .filter((entry) => entry.adapter === chosen)
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  const surface = link ? identityLinkDirectSurface(link) : null;
  if (!link || !surface) return;
  ctx.adapters.privateDestinations.recordActivity(uid, {
    kind: "adapter", adapter: link.adapter, accountId: link.accountId, actorId: link.actorId, surface,
  }, `first-run:${uid}`, Date.now());
}
