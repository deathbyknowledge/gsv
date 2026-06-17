import type { ExtendedStat } from "../../../fs/gsv-fs";
import type { KernelContext } from "../../../kernel/context";
import type { ProcessIdentity } from "@humansandmachines/gsv/protocol";

// Remove this once https://github.com/vercel-labs/just-bash/pull/150 is merged
export function formatMode(mode: number, isDirectory: boolean): string {
  const type = isDirectory ? "d" : "-";
  const bits = [
    mode & 0o400 ? "r" : "-", mode & 0o200 ? "w" : "-", mode & 0o100 ? "x" : "-",
    mode & 0o040 ? "r" : "-", mode & 0o020 ? "w" : "-", mode & 0o010 ? "x" : "-",
    mode & 0o004 ? "r" : "-", mode & 0o002 ? "w" : "-", mode & 0o001 ? "x" : "-",
  ];
  return type + bits.join("");
}

export function formatDate(d: Date): string {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const mon = months[d.getMonth()];
  const day = String(d.getDate()).padStart(2, " ");
  const now = new Date();
  const sixMonthsAgo = new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000);
  if (d > sixMonthsAgo) {
    const h = String(d.getHours()).padStart(2, "0");
    const m = String(d.getMinutes()).padStart(2, "0");
    return `${mon} ${day} ${h}:${m}`;
  }
  return `${mon} ${day}  ${d.getFullYear()}`;
}

export function humanSize(bytes: number): string {
  if (bytes < 1024) return String(bytes);
  if (bytes < 1024 * 1024) {
    const k = bytes / 1024;
    return k < 10 ? `${k.toFixed(1)}K` : `${Math.round(k)}K`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    const m = bytes / (1024 * 1024);
    return m < 10 ? `${m.toFixed(1)}M` : `${Math.round(m)}M`;
  }
  const g = bytes / (1024 * 1024 * 1024);
  return g < 10 ? `${g.toFixed(1)}G` : `${Math.round(g)}G`;
}

export function classifyIndicator(st: ExtendedStat): string {
  if (st.isDirectory) return "/";
  if (st.isSymbolicLink) return "@";
  if ((st.mode & 0o111) !== 0) return "*";
  return "";
}

export type NameCache = { uid: Map<number, string>; gid: Map<number, string> };

export function loadNameCache(ctx: KernelContext, identity: ProcessIdentity): NameCache {
  const uid = new Map<number, string>();
  const gid = new Map<number, string>();
  uid.set(identity.uid, identity.username);
  uid.set(0, "root");
  gid.set(0, "root");

  for (const e of ctx.auth.getPasswdEntries()) {
    uid.set(e.uid, e.username);
  }
  for (const e of ctx.auth.getGroupEntries()) {
    gid.set(e.gid, e.name);
  }

  return { uid, gid };
}

export function resolveOwner(cache: NameCache, fileUid: number, fileGid: number): { owner: string; group: string } {
  return {
    owner: cache.uid.get(fileUid) ?? String(fileUid),
    group: cache.gid.get(fileGid) ?? String(fileGid),
  };
}
