import type { ProcessIdentity } from "@gsv/protocol/syscalls/system";
import type { SyscallName } from "../syscalls";
import type { FsAccessPolicy, FsWriteOperation } from "../fs/gsv-fs";
import { normalizePath, resolveUserPath } from "../fs/utils";

export type LocalUserAuthority = {
  kind: "local-user";
};

export type RemoteSocialAuthority = {
  kind: "remote-social";
  peerHandle: string;
  peerDid?: string;
  threadId?: string;
  messageId?: string;
  sandboxRoot: string;
};

export type ProcessAuthority = LocalUserAuthority | RemoteSocialAuthority;

export const LOCAL_PROCESS_AUTHORITY: LocalUserAuthority = { kind: "local-user" };
export const LOCAL_PROCESS_AUTHORITY_JSON = JSON.stringify(LOCAL_PROCESS_AUTHORITY);

const REMOTE_SOCIAL_ALLOWED_SYSCALLS = new Set<string>([
  "ai.config",
  "ai.tools",
  "fs.read",
  "fs.search",
  "fs.write",
  "fs.edit",
  "shell.exec",
  "social.identity.get",
  "social.profile.get",
  "social.instance.get",
  "social.user.list",
  "social.contact.public.list",
  "social.package.list",
  "social.package.release.list",
  "social.vouch.list",
  "social.news.list",
  "social.thread.create",
  "social.thread.list",
  "social.thread.get",
  "social.message.send",
  "social.message.status.list",
  "social.message.status.get",
  "social.message.status.update",
]);

const REMOTE_SOCIAL_VISIBLE_TOOL_SYSCALLS = new Set<string>([
  "fs.read",
  "fs.search",
  "fs.write",
  "fs.edit",
  "shell.exec",
]);

const REMOTE_SOCIAL_DENIED_FS_OPS = new Set<FsWriteOperation>([
  "delete",
  "move",
  "metadata",
]);

export function remoteSocialProcessAuthority(input: {
  peerHandle: string;
  peerDid?: string;
  threadId?: string;
  messageId?: string;
}): RemoteSocialAuthority {
  const peerHandle = normalizeAuthorityHandle(input.peerHandle);
  return compactAuthority({
    kind: "remote-social",
    peerHandle,
    peerDid: input.peerDid,
    threadId: input.threadId,
    messageId: input.messageId,
    sandboxRoot: remoteSocialSandboxRoot(peerHandle),
  });
}

export function parseProcessAuthority(value: unknown): ProcessAuthority {
  if (!value || typeof value !== "object") {
    return LOCAL_PROCESS_AUTHORITY;
  }
  const record = value as Record<string, unknown>;
  if (record.kind === "remote-social" && typeof record.peerHandle === "string") {
    const peerHandle = normalizeAuthorityHandle(record.peerHandle);
    return compactAuthority({
      kind: "remote-social",
      peerHandle,
      peerDid: typeof record.peerDid === "string" ? record.peerDid : undefined,
      threadId: typeof record.threadId === "string" ? record.threadId : undefined,
      messageId: typeof record.messageId === "string" ? record.messageId : undefined,
      sandboxRoot: typeof record.sandboxRoot === "string"
        ? normalizePath(record.sandboxRoot)
        : remoteSocialSandboxRoot(peerHandle),
    });
  }
  return LOCAL_PROCESS_AUTHORITY;
}

export function parseProcessAuthorityJson(value: string | null | undefined): ProcessAuthority {
  if (!value) {
    return LOCAL_PROCESS_AUTHORITY;
  }
  try {
    return parseProcessAuthority(JSON.parse(value));
  } catch {
    return LOCAL_PROCESS_AUTHORITY;
  }
}

export function serializeProcessAuthority(authority: ProcessAuthority | undefined): string {
  return JSON.stringify(parseProcessAuthority(authority));
}

export function processAuthorityKey(authority: ProcessAuthority | undefined): string {
  const parsed = parseProcessAuthority(authority);
  if (parsed.kind === "local-user") {
    return "local-user";
  }
  return [
    "remote-social",
    parsed.peerHandle,
    parsed.peerDid ?? "",
    parsed.threadId ?? "",
  ].join(":");
}

export function isRemoteSocialAuthority(
  authority: ProcessAuthority | undefined,
): authority is RemoteSocialAuthority {
  return authority?.kind === "remote-social";
}

export function isSyscallToolVisibleForAuthority(
  authority: ProcessAuthority | undefined,
  syscall: SyscallName | string,
): boolean {
  if (!isRemoteSocialAuthority(authority)) {
    return true;
  }
  return REMOTE_SOCIAL_VISIBLE_TOOL_SYSCALLS.has(syscall);
}

export function authorizeProcessSyscall(
  authority: ProcessAuthority | undefined,
  syscall: SyscallName | string,
  args: unknown,
  identity?: ProcessIdentity,
): string | null {
  if (!isRemoteSocialAuthority(authority)) {
    return null;
  }

  const record = isRecord(args) ? args : {};
  const target = typeof record.target === "string" ? record.target.trim() : "";
  if (target && target !== "gsv") {
    return "Remote social authority can only target gsv";
  }
  if (syscall === "shell.exec" && typeof record.sessionId === "string" && record.sessionId.trim()) {
    return "Remote social authority cannot attach to device shell sessions";
  }

  if (!REMOTE_SOCIAL_ALLOWED_SYSCALLS.has(syscall)) {
    return `Remote social authority cannot call ${syscall}`;
  }

  if ((syscall === "fs.write" || syscall === "fs.edit") && identity) {
    const path = typeof record.path === "string" ? record.path : "";
    if (!path) {
      return `${syscall} requires a path`;
    }
    const resolved = resolveUserPath(path, identity.home, identity.cwd);
    if (!isPathInside(resolved, authority.sandboxRoot)) {
      return `Remote social writes are limited to ${authority.sandboxRoot}`;
    }
  }

  if (syscall.startsWith("social.")) {
    return authorizeRemoteSocialSyscall(authority, syscall, record);
  }

  return null;
}

export function fsAccessPolicyForAuthority(
  authority: ProcessAuthority | undefined,
  identity: ProcessIdentity,
): FsAccessPolicy | undefined {
  if (!isRemoteSocialAuthority(authority)) {
    return undefined;
  }
  return {
    canWrite(path, operation) {
      if (REMOTE_SOCIAL_DENIED_FS_OPS.has(operation)) {
        return `Remote social authority cannot ${operation} files`;
      }
      const resolved = resolveUserPath(path, identity.home, identity.cwd);
      if (!isPathInside(resolved, authority.sandboxRoot)) {
        return `Remote social writes are limited to ${authority.sandboxRoot}`;
      }
      return null;
    },
  };
}

export function remoteSocialSandboxRoot(peerHandle: string): string {
  return `/var/social/${sanitizePathSegment(peerHandle)}`;
}

function authorizeRemoteSocialSyscall(
  authority: RemoteSocialAuthority,
  syscall: string,
  args: Record<string, unknown>,
): string | null {
  if (syscall === "social.thread.create") {
    return requirePeerHandle(authority, args.peerHandle, "peerHandle");
  }
  if (syscall === "social.thread.list") {
    return requirePeerHandle(authority, args.peerHandle, "peerHandle");
  }
  if (syscall === "social.thread.get" && authority.threadId && args.threadId !== authority.threadId) {
    return `Remote social authority is limited to thread ${authority.threadId}`;
  }
  if (syscall === "social.message.send") {
    const peerDenied = requirePeerHandle(authority, args.toHandle, "toHandle");
    if (peerDenied) {
      return peerDenied;
    }
    if (authority.threadId && args.threadId !== undefined && args.threadId !== authority.threadId) {
      return `Remote social authority is limited to thread ${authority.threadId}`;
    }
    return null;
  }
  if (syscall === "social.message.status.list") {
    return requirePeerHandle(authority, args.peerHandle, "peerHandle");
  }
  if (
    (syscall === "social.message.status.get" || syscall === "social.message.status.update") &&
    authority.messageId &&
    args.messageId !== authority.messageId
  ) {
    return `Remote social authority is limited to message ${authority.messageId}`;
  }
  if (
    syscall === "social.profile.get" ||
    syscall === "social.instance.get" ||
    syscall === "social.user.list" ||
    syscall === "social.contact.public.list" ||
    syscall === "social.package.list" ||
    syscall === "social.package.release.list" ||
    syscall === "social.vouch.list" ||
    syscall === "social.news.list"
  ) {
    return args.handle === undefined ? null : requirePeerHandle(authority, args.handle, "handle");
  }
  return null;
}

function requirePeerHandle(
  authority: RemoteSocialAuthority,
  value: unknown,
  field: string,
): string | null {
  if (typeof value !== "string" || !value.trim()) {
    return `Remote social authority requires ${field}=${authority.peerHandle}`;
  }
  return normalizeAuthorityHandle(value) === authority.peerHandle
    ? null
    : `Remote social authority is limited to ${authority.peerHandle}`;
}

function isPathInside(path: string, root: string): boolean {
  const normalizedPath = normalizePath(path);
  const normalizedRoot = normalizePath(root);
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}

function normalizeAuthorityHandle(handle: string): string {
  return handle.trim().toLowerCase();
}

function sanitizePathSegment(value: string): string {
  const sanitized = normalizeAuthorityHandle(value)
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || "peer";
}

function compactAuthority(authority: RemoteSocialAuthority): RemoteSocialAuthority {
  return Object.fromEntries(
    Object.entries(authority).filter(([, value]) => value !== undefined),
  ) as RemoteSocialAuthority;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
