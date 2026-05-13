import type { KernelClientLike, PackageViewerBinding } from "@gsv/package/backend";
import type {
  AccessToken,
  AdministrationState,
  AdministrationViewer,
  ApplyConfigArgs,
  ConfigEntry,
  ConsumeLinkCodeArgs,
  CreateAccessTokenArgs,
  CreateAccessTokenResult,
  CreateIdentityLinkArgs,
  CreatedAccessToken,
  IdentityLink,
  RemoveIdentityLinkArgs,
  RevokeAccessTokenArgs,
  TokenKind,
} from "../app/features/settings/types";

type ViewerRuntime = {
  viewer?: PackageViewerBinding;
};

type ConfigPayload = {
  entries?: Array<Record<string, unknown>>;
};

type TokenListPayload = {
  tokens?: Array<Record<string, unknown>>;
};

type LinkListPayload = {
  links?: Array<Record<string, unknown>>;
};

type CreatedTokenPayload = {
  token?: Record<string, unknown>;
};

export async function loadAdministrationState(
  kernel: KernelClientLike,
  runtime: ViewerRuntime,
): Promise<AdministrationState> {
  const [configResult, tokenResult, linkResult] = await Promise.all([
    kernel.request("sys.config.get", {}) as Promise<ConfigPayload>,
    kernel.request("sys.token.list", {}) as Promise<TokenListPayload>,
    kernel.request("sys.link.list", {}) as Promise<LinkListPayload>,
  ]);
  const configEntries = normalizeConfigEntries(Array.isArray(configResult.entries) ? configResult.entries : []);
  return {
    viewer: resolveViewer(runtime),
    configEntries,
    configValues: Object.fromEntries(configEntries.map((entry) => [entry.key, entry.value])),
    tokens: (Array.isArray(tokenResult.tokens) ? tokenResult.tokens : [])
      .map(normalizeToken)
      .sort((left, right) => right.createdAt - left.createdAt),
    links: (Array.isArray(linkResult.links) ? linkResult.links : [])
      .map(normalizeLink)
      .sort((left, right) => right.createdAt - left.createdAt),
  };
}

export async function applyConfigEntries(
  kernel: KernelClientLike,
  runtime: ViewerRuntime,
  args: ApplyConfigArgs,
): Promise<AdministrationState> {
  for (const entry of args.entries ?? []) {
    await kernel.request("sys.config.set", {
      key: normalizeRequired(entry.key, "key"),
      value: entry.value ?? "",
    });
  }
  return loadAdministrationState(kernel, runtime);
}

export async function createAccessToken(
  kernel: KernelClientLike,
  runtime: ViewerRuntime,
  args: CreateAccessTokenArgs,
): Promise<CreateAccessTokenResult> {
  const result = await kernel.request("sys.token.create", {
    kind: normalizeTokenKind(args.kind),
    label: normalizeOptional(args.label),
    allowedDeviceId: normalizeOptional(args.allowedDeviceId),
    expiresAt: typeof args.expiresAt === "number" ? args.expiresAt : undefined,
    ...(args.kind === "node" ? { allowedRole: "driver" } : {}),
  }) as CreatedTokenPayload;

  return {
    state: await loadAdministrationState(kernel, runtime),
    token: normalizeCreatedToken(result.token ?? {}),
  };
}

export async function revokeAccessToken(
  kernel: KernelClientLike,
  runtime: ViewerRuntime,
  args: RevokeAccessTokenArgs,
): Promise<AdministrationState> {
  await kernel.request("sys.token.revoke", {
    tokenId: normalizeRequired(args.tokenId, "tokenId"),
    reason: normalizeOptional(args.reason),
  });
  return loadAdministrationState(kernel, runtime);
}

export async function consumeIdentityLinkCode(
  kernel: KernelClientLike,
  runtime: ViewerRuntime,
  args: ConsumeLinkCodeArgs,
): Promise<AdministrationState> {
  await kernel.request("sys.link.consume", {
    code: normalizeRequired(args.code, "code"),
  });
  return loadAdministrationState(kernel, runtime);
}

export async function createIdentityLink(
  kernel: KernelClientLike,
  runtime: ViewerRuntime,
  args: CreateIdentityLinkArgs,
): Promise<AdministrationState> {
  await kernel.request("sys.link", {
    adapter: normalizeRequired(args.adapter, "adapter").toLowerCase(),
    accountId: normalizeRequired(args.accountId, "accountId"),
    actorId: normalizeRequired(args.actorId, "actorId"),
  });
  return loadAdministrationState(kernel, runtime);
}

export async function removeIdentityLink(
  kernel: KernelClientLike,
  runtime: ViewerRuntime,
  args: RemoveIdentityLinkArgs,
): Promise<AdministrationState> {
  await kernel.request("sys.unlink", {
    adapter: normalizeRequired(args.adapter, "adapter").toLowerCase(),
    accountId: normalizeRequired(args.accountId, "accountId"),
    actorId: normalizeRequired(args.actorId, "actorId"),
  });
  return loadAdministrationState(kernel, runtime);
}

function resolveViewer(runtime: ViewerRuntime): AdministrationViewer {
  const uid = typeof runtime.viewer?.uid === "number" ? runtime.viewer.uid : 0;
  const username = typeof runtime.viewer?.username === "string" && runtime.viewer.username.trim().length > 0
    ? runtime.viewer.username
    : uid === 0 ? "root" : "user";
  return {
    uid,
    username,
    canEditSystemConfig: uid === 0,
    canEditUserAiConfig: true,
    userAiPrefix: `users/${uid}/ai/`,
  };
}

function normalizeConfigEntries(entries: Array<Record<string, unknown>>): ConfigEntry[] {
  return entries
    .map((entry) => ({
      key: String(entry.key ?? ""),
      value: String(entry.value ?? ""),
      scopeLabel: parseScopeLabel(String(entry.key ?? "")),
      pathLabel: parsePathLabel(String(entry.key ?? "")),
    }))
    .filter((entry) => entry.key.length > 0)
    .sort((left, right) => left.key.localeCompare(right.key));
}

function normalizeToken(token: Record<string, unknown>): AccessToken {
  return {
    tokenId: String(token.tokenId ?? ""),
    uid: asNumber(token.uid, 0),
    kind: normalizeTokenKind(token.kind),
    label: asNullableString(token.label),
    tokenPrefix: String(token.tokenPrefix ?? ""),
    allowedRole: asNullableString(token.allowedRole),
    allowedDeviceId: asNullableString(token.allowedDeviceId),
    createdAt: asNumber(token.createdAt, 0),
    lastUsedAt: asNullableNumber(token.lastUsedAt),
    expiresAt: asNullableNumber(token.expiresAt),
    revokedAt: asNullableNumber(token.revokedAt),
    revokedReason: asNullableString(token.revokedReason),
  };
}

function normalizeCreatedToken(token: Record<string, unknown>): CreatedAccessToken {
  return {
    tokenId: String(token.tokenId ?? ""),
    token: String(token.token ?? ""),
    tokenPrefix: String(token.tokenPrefix ?? ""),
    uid: asNumber(token.uid, 0),
    kind: normalizeTokenKind(token.kind),
    label: asNullableString(token.label),
    allowedRole: asNullableString(token.allowedRole),
    allowedDeviceId: asNullableString(token.allowedDeviceId),
    createdAt: asNumber(token.createdAt, 0),
    expiresAt: asNullableNumber(token.expiresAt),
  };
}

function normalizeLink(link: Record<string, unknown>): IdentityLink {
  return {
    adapter: String(link.adapter ?? ""),
    accountId: String(link.accountId ?? ""),
    actorId: String(link.actorId ?? ""),
    uid: asNumber(link.uid, 0),
    createdAt: asNumber(link.createdAt, 0),
    linkedByUid: asNumber(link.linkedByUid, 0),
  };
}

function normalizeTokenKind(value: unknown): TokenKind {
  return value === "node" || value === "service" ? value : "user";
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

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
