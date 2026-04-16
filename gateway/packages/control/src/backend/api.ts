import type { KernelClientLike } from "@gsv/package/worker";
import type {
  SysConfigEntry,
  SysConfigGetResult,
  SysLinkListResult,
  SysTokenCreateResult,
  SysTokenListResult,
} from "../../../../src/syscalls/system";
import type {
  ApplyRawConfigArgs,
  ConsumeLinkCodeArgs,
  ControlConfigEntry,
  ControlCreatedToken,
  ControlState,
  ControlViewer,
  CreateLinkArgs,
  CreateTokenArgs,
  CreateTokenResult,
  RevokeTokenArgs,
  SaveEntryArgs,
  UnlinkArgs,
} from "../app/types";

type RuntimeContextLike = {
  appFrame?: {
    uid?: number;
    username?: string;
  };
};

export async function loadState(kernel: KernelClientLike, runtime: unknown): Promise<ControlState> {
  const viewer = resolveViewer(runtime);
  const [configResult, tokenResult, linkResult] = await Promise.all([
    kernel.request("sys.config.get", {} as Record<string, never>) as Promise<SysConfigGetResult>,
    kernel.request("sys.token.list", {} as Record<string, never>) as Promise<SysTokenListResult>,
    kernel.request("sys.link.list", {} as Record<string, never>) as Promise<SysLinkListResult>,
  ]);

  const configEntries = normalizeConfigEntries(configResult.entries);

  return {
    viewer,
    configEntries,
    configValues: Object.fromEntries(configEntries.map((entry) => [entry.key, entry.value])),
    tokens: [...tokenResult.tokens].sort((left, right) => right.createdAt - left.createdAt),
    links: [...linkResult.links].sort((left, right) => right.createdAt - left.createdAt),
  };
}

export async function saveEntry(
  kernel: KernelClientLike,
  runtime: unknown,
  args: SaveEntryArgs,
): Promise<ControlState> {
  await kernel.request("sys.config.set", {
    key: normalizeRequired(args.key, "key"),
    value: args.value ?? "",
  });
  return loadState(kernel, runtime);
}

export async function createToken(
  kernel: KernelClientLike,
  runtime: unknown,
  args: CreateTokenArgs,
): Promise<CreateTokenResult> {
  const result = await kernel.request("sys.token.create", {
    kind: args.kind,
    label: normalizeOptional(args.label),
    allowedDeviceId: normalizeOptional(args.allowedDeviceId),
    expiresAt: args.expiresAt ?? undefined,
  }) as SysTokenCreateResult;

  return {
    state: await loadState(kernel, runtime),
    token: normalizeCreatedToken(result.token),
  };
}

export async function revokeToken(
  kernel: KernelClientLike,
  runtime: unknown,
  args: RevokeTokenArgs,
): Promise<ControlState> {
  await kernel.request("sys.token.revoke", {
    tokenId: normalizeRequired(args.tokenId, "tokenId"),
    reason: normalizeOptional(args.reason),
  });
  return loadState(kernel, runtime);
}

export async function consumeLinkCode(
  kernel: KernelClientLike,
  runtime: unknown,
  args: ConsumeLinkCodeArgs,
): Promise<ControlState> {
  await kernel.request("sys.link.consume", {
    code: normalizeRequired(args.code, "code"),
  });
  return loadState(kernel, runtime);
}

export async function createLink(
  kernel: KernelClientLike,
  runtime: unknown,
  args: CreateLinkArgs,
): Promise<ControlState> {
  await kernel.request("sys.link", {
    adapter: normalizeRequired(args.adapter, "adapter").toLowerCase(),
    accountId: normalizeRequired(args.accountId, "accountId"),
    actorId: normalizeRequired(args.actorId, "actorId"),
  });
  return loadState(kernel, runtime);
}

export async function unlink(
  kernel: KernelClientLike,
  runtime: unknown,
  args: UnlinkArgs,
): Promise<ControlState> {
  await kernel.request("sys.unlink", {
    adapter: normalizeRequired(args.adapter, "adapter").toLowerCase(),
    accountId: normalizeRequired(args.accountId, "accountId"),
    actorId: normalizeRequired(args.actorId, "actorId"),
  });
  return loadState(kernel, runtime);
}

export async function applyRawConfig(
  kernel: KernelClientLike,
  runtime: unknown,
  args: ApplyRawConfigArgs,
): Promise<ControlState> {
  for (const entry of args.entries) {
    await kernel.request("sys.config.set", {
      key: normalizeRequired(entry.key, "key"),
      value: entry.value ?? "",
    });
  }
  return loadState(kernel, runtime);
}

function normalizeConfigEntries(entries: SysConfigEntry[]): ControlConfigEntry[] {
  return [...entries]
    .map((entry) => ({
      key: entry.key,
      value: entry.value,
      scopeLabel: parseScopeLabel(entry.key),
      pathLabel: parsePathLabel(entry.key),
    }))
    .sort((left, right) => left.key.localeCompare(right.key));
}

function resolveViewer(runtime: unknown): ControlViewer {
  const appFrame = (runtime as RuntimeContextLike | null)?.appFrame;
  const uid = typeof appFrame?.uid === "number" ? appFrame.uid : 0;
  const username = typeof appFrame?.username === "string" ? appFrame.username : uid === 0 ? "root" : "user";
  return {
    uid,
    username,
    canEditSystemConfig: uid === 0,
    canEditUserAiConfig: true,
    userAiPrefix: `users/${uid}/ai/`,
  };
}

function parseScopeLabel(key: string): string {
  const parts = key.split("/").filter(Boolean);
  if (parts[0] === "config") {
    return "system";
  }
  if (parts[0] === "users" && parts.length >= 2) {
    return `user ${parts[1]}`;
  }
  return "other";
}

function parsePathLabel(key: string): string {
  const parts = key.split("/").filter(Boolean);
  if (parts[0] === "config") {
    return parts.slice(1).join(" / ");
  }
  if (parts[0] === "users" && parts.length >= 3) {
    return parts.slice(2).join(" / ");
  }
  return key;
}

function normalizeCreatedToken(token: SysTokenCreateResult["token"]): ControlCreatedToken {
  return {
    tokenId: token.tokenId,
    token: token.token,
    tokenPrefix: token.tokenPrefix,
    uid: token.uid,
    kind: token.kind,
    label: token.label,
    allowedRole: token.allowedRole,
    allowedDeviceId: token.allowedDeviceId,
    createdAt: token.createdAt,
    expiresAt: token.expiresAt,
  };
}

function normalizeRequired(value: string | undefined, field: string): string {
  const normalized = (value ?? "").trim();
  if (!normalized) {
    throw new Error(`${field} is required`);
  }
  return normalized;
}

function normalizeOptional(value: string | undefined): string | undefined {
  const normalized = (value ?? "").trim();
  return normalized.length > 0 ? normalized : undefined;
}
