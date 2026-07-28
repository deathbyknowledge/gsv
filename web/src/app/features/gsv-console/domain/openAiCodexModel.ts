export const MODEL_PROVIDER_FIELD_KEY = "config/ai/provider";
export const MODEL_TRANSPORT_TARGET_KEY = "config/ai/transport_target";
export const OPENAI_CODEX_PROVIDER = "openai-codex";

type NetFetchTarget = {
  id: string;
  label?: string;
  online?: boolean;
  implements?: readonly string[];
};

export function isOpenAiCodexProvider(provider: string): boolean {
  return normalizeProviderValue(provider) === OPENAI_CODEX_PROVIDER;
}

export function normalizeProviderValue(provider: string): string {
  return provider.trim().toLowerCase();
}

export function normalizedTransportTargetValue(value: string): string {
  return value.trim() || "gsv";
}

export function firstAvailableFetchTargetId(targets: readonly NetFetchTarget[]): string | null {
  const [target] = targets
    .filter((candidate) =>
      candidate.id.trim().length > 0 &&
      candidate.online !== false &&
      targetImplementsCapability(candidate, "net.fetch")
    )
    .slice()
    .sort((left, right) => (left.label || left.id).localeCompare(right.label || right.id));
  return target?.id ?? null;
}

export function withOpenAiCodexTransportTargetDefault(
  drafts: Record<string, string>,
  preferredTargetId: string | null,
  targetWasSelected: boolean,
): Record<string, string> {
  if (
    targetWasSelected ||
    !preferredTargetId ||
    !isOpenAiCodexProvider(drafts[MODEL_PROVIDER_FIELD_KEY] ?? "") ||
    normalizedTransportTargetValue(drafts[MODEL_TRANSPORT_TARGET_KEY] ?? "") !== "gsv"
  ) {
    return drafts;
  }
  return {
    ...drafts,
    [MODEL_TRANSPORT_TARGET_KEY]: preferredTargetId,
  };
}

export function targetImplementsCapability(target: NetFetchTarget, capability: string): boolean {
  return (target.implements ?? []).some((pattern) => {
    if (pattern === "*" || pattern === capability) {
      return true;
    }
    if (pattern.endsWith(".*")) {
      return capability.startsWith(pattern.slice(0, -1));
    }
    return false;
  });
}
