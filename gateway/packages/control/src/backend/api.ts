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
  ControlSection,
  ControlSectionId,
  ControlState,
  CreateLinkArgs,
  CreateTokenArgs,
  CreateTokenResult,
  RevokeTokenArgs,
  SaveEntryArgs,
  UnlinkArgs,
} from "../app/types";

const SECTION_META: Array<{
  id: ControlSectionId;
  title: string;
  description: string;
}> = [
  {
    id: "ai",
    title: "AI",
    description: "Provider, model, and inference-related defaults.",
  },
  {
    id: "shell",
    title: "Shell",
    description: "Execution behavior, limits, and environment settings.",
  },
  {
    id: "server",
    title: "Server",
    description: "Gateway and runtime configuration visible to the system.",
  },
  {
    id: "auth",
    title: "Auth",
    description: "Authentication, linking, and account-bound controls.",
  },
];

export async function loadState(kernel: KernelClientLike): Promise<ControlState> {
  const [configResult, tokenResult, linkResult] = await Promise.all([
    kernel.request("sys.config.get", {} as Record<string, never>) as Promise<SysConfigGetResult>,
    kernel.request("sys.token.list", {} as Record<string, never>) as Promise<SysTokenListResult>,
    kernel.request("sys.link.list", {} as Record<string, never>) as Promise<SysLinkListResult>,
  ]);

  const rawEntries = normalizeConfigEntries(configResult.entries);
  const sectionMap = new Map<ControlSectionId, ControlConfigEntry[]>(
    SECTION_META.map((section) => [section.id, []]),
  );
  for (const entry of rawEntries) {
    if (entry.sectionId) {
      sectionMap.get(entry.sectionId)?.push(entry);
    }
  }

  const sections: ControlSection[] = SECTION_META.map((section) => ({
    id: section.id,
    title: section.title,
    description: section.description,
    entries: (sectionMap.get(section.id) ?? []).sort(compareConfigEntries),
    addPrefix: `config/${section.id}/`,
  }));

  return {
    sections,
    rawEntries,
    tokens: [...tokenResult.tokens].sort((left, right) => right.createdAt - left.createdAt),
    links: [...linkResult.links].sort((left, right) => right.createdAt - left.createdAt),
  };
}

export async function saveEntry(
  kernel: KernelClientLike,
  args: SaveEntryArgs,
): Promise<ControlState> {
  const key = normalizeRequired(args.key, "key");
  await kernel.request("sys.config.set", {
    key,
    value: args.value ?? "",
  });
  return loadState(kernel);
}

export async function createToken(
  kernel: KernelClientLike,
  args: CreateTokenArgs,
): Promise<CreateTokenResult> {
  const result = await kernel.request("sys.token.create", {
    kind: args.kind,
    label: normalizeOptional(args.label),
    allowedDeviceId: normalizeOptional(args.allowedDeviceId),
    expiresAt: args.expiresAt ?? undefined,
  }) as SysTokenCreateResult;

  return {
    state: await loadState(kernel),
    token: normalizeCreatedToken(result.token),
  };
}

export async function revokeToken(
  kernel: KernelClientLike,
  args: RevokeTokenArgs,
): Promise<ControlState> {
  await kernel.request("sys.token.revoke", {
    tokenId: normalizeRequired(args.tokenId, "tokenId"),
    reason: normalizeOptional(args.reason),
  });
  return loadState(kernel);
}

export async function consumeLinkCode(
  kernel: KernelClientLike,
  args: ConsumeLinkCodeArgs,
): Promise<ControlState> {
  await kernel.request("sys.link.consume", {
    code: normalizeRequired(args.code, "code"),
  });
  return loadState(kernel);
}

export async function createLink(
  kernel: KernelClientLike,
  args: CreateLinkArgs,
): Promise<ControlState> {
  await kernel.request("sys.link", {
    adapter: normalizeRequired(args.adapter, "adapter").toLowerCase(),
    accountId: normalizeRequired(args.accountId, "accountId"),
    actorId: normalizeRequired(args.actorId, "actorId"),
  });
  return loadState(kernel);
}

export async function unlink(
  kernel: KernelClientLike,
  args: UnlinkArgs,
): Promise<ControlState> {
  await kernel.request("sys.unlink", {
    adapter: normalizeRequired(args.adapter, "adapter").toLowerCase(),
    accountId: normalizeRequired(args.accountId, "accountId"),
    actorId: normalizeRequired(args.actorId, "actorId"),
  });
  return loadState(kernel);
}

export async function applyRawConfig(
  kernel: KernelClientLike,
  args: ApplyRawConfigArgs,
): Promise<ControlState> {
  for (const entry of args.entries) {
    await kernel.request("sys.config.set", {
      key: normalizeRequired(entry.key, "key"),
      value: entry.value ?? "",
    });
  }
  return loadState(kernel);
}

function normalizeConfigEntries(entries: SysConfigEntry[]): ControlConfigEntry[] {
  return [...entries]
    .map((entry) => {
      const parsed = parseConfigKey(entry.key);
      return {
        key: entry.key,
        value: entry.value,
        scopeLabel: parsed.scopeLabel,
        sectionId: parsed.sectionId,
        fieldLabel: parsed.fieldLabel,
      } satisfies ControlConfigEntry;
    })
    .sort(compareConfigEntries);
}

function parseConfigKey(key: string): {
  scopeLabel: string;
  sectionId: ControlSectionId | null;
  fieldLabel: string;
} {
  const parts = key.split("/").filter(Boolean);
  if (parts[0] === "config" && parts.length >= 3) {
    const sectionId = normalizeSectionId(parts[1]);
    return {
      scopeLabel: "system",
      sectionId,
      fieldLabel: parts.slice(2).join(" / "),
    };
  }

  if (parts[0] === "users" && parts.length >= 4) {
    const uid = parts[1];
    const sectionId = normalizeSectionId(parts[2]);
    return {
      scopeLabel: `user ${uid}`,
      sectionId,
      fieldLabel: parts.slice(3).join(" / "),
    };
  }

  return {
    scopeLabel: "other",
    sectionId: null,
    fieldLabel: key,
  };
}

function normalizeSectionId(value: string): ControlSectionId | null {
  return SECTION_META.some((section) => section.id === value)
    ? (value as ControlSectionId)
    : null;
}

function compareConfigEntries(left: ControlConfigEntry, right: ControlConfigEntry): number {
  return left.key.localeCompare(right.key);
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
