/**
 * sys.config.get / sys.config.set syscall handlers.
 *
 * Thin wrappers around ConfigStore with key-level permission checks.
 *
 * Key format mirrors ConfigStore internals:
 *   "config/ai/provider"     → system-wide AI provider
 *   "config/shell/timeout_ms" → system-wide shell timeout
 *   "users/1000/ai/model"    → per-user AI model override
 *
 * Permission model:
 *   Read:  root reads all; non-root reads own users/{uid}/* and only non-sensitive config/*
 *   Write: root writes all; non-root writes only users/{uid}/{overridable}/*
 */

import type { KernelContext } from "../context";
import type {
  SysConfigGetArgs,
  SysConfigGetResult,
  SysConfigSetArgs,
  SysConfigSetResult,
  SysConfigEntry,
} from "../../syscalls/system";
import { USER_OVERRIDABLE_PREFIXES } from "../config";
import { canReadConfigKey } from "../config-access";

function canWrite(uid: number, key: string): boolean {
  if (uid === 0) return true;
  if (!key.startsWith(`users/${uid}/`)) return false;
  const sub = key.slice(`users/${uid}/`.length);
  return USER_OVERRIDABLE_PREFIXES.some((p) => sub.startsWith(p));
}

export function handleSysConfigGet(
  args: SysConfigGetArgs,
  ctx: KernelContext,
): SysConfigGetResult {
  const uid = ctx.identity!.process.uid;
  const config = ctx.config;
  const key = args.key;

  if (key === undefined || key === "") {
    const visible = (uid === 0
      ? config.list("")
      : [
          ...config.list("config/"),
          ...config.list(`users/${uid}/`),
        ]).filter((entry) => canReadConfigKey(uid, entry.key));
    return { entries: visible };
  }

  const exact = config.get(key);
  if (exact !== null) {
    if (!canReadConfigKey(uid, key)) {
      throw new Error(`Permission denied: cannot read ${key}`);
    }
    return { entries: [{ key, value: exact }] };
  }

  const prefix = key.endsWith("/") ? key : key + "/";
  const listed = config.list(prefix);

  const entries: SysConfigEntry[] = [];
  for (const entry of listed) {
    if (canReadConfigKey(uid, entry.key)) {
      entries.push(entry);
    }
  }

  if (entries.length === 0 && !key.includes("/")) {
    const scoped = config.list(key);
    for (const entry of scoped) {
      if (canReadConfigKey(uid, entry.key)) {
        entries.push(entry);
      }
    }
  }

  return { entries };
}

export function handleSysConfigSet(
  args: SysConfigSetArgs,
  ctx: KernelContext,
): SysConfigSetResult {
  const uid = ctx.identity!.process.uid;

  if (!args.key || typeof args.key !== "string") {
    throw new Error("sys.config.set requires a key");
  }
  if (args.value === undefined || args.value === null) {
    throw new Error("sys.config.set requires a value");
  }

  if (!canWrite(uid, args.key)) {
    if (uid !== 0 && args.key.startsWith("config/")) {
      throw new Error(`Permission denied: only root can set system config (${args.key})`);
    }
    if (uid !== 0 && args.key.startsWith("users/") && !args.key.startsWith(`users/${uid}/`)) {
      throw new Error(`Permission denied: cannot write another user's config (${args.key})`);
    }
    const sub = args.key.startsWith(`users/${uid}/`)
      ? args.key.slice(`users/${uid}/`.length)
      : args.key;
    throw new Error(
      `Permission denied: key "${sub}" is not user-overridable (allowed prefixes: ${USER_OVERRIDABLE_PREFIXES.join(", ")})`,
    );
  }

  ctx.config.set(args.key, String(args.value));
  return { ok: true };
}
