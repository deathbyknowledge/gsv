import { createAvatar } from "@dicebear/core";
import * as botttsNeutral from "@dicebear/bottts-neutral";

const avatarCache = new Map<string, string>();

function agentAvatarDataUri(seed: string): string {
  const normalizedSeed = seed.trim() || "agent";
  const cached = avatarCache.get(normalizedSeed);
  if (cached) {
    return cached;
  }
  const dataUri = createAvatar(botttsNeutral, {
    seed: normalizedSeed,
    size: 48,
    radius: 18,
  }).toDataUri();
  avatarCache.set(normalizedSeed, dataUri);
  return dataUri;
}

export function AgentAvatar({ seed, label }: { seed: string; label: string }) {
  return (
    <span class="agent-avatar" title={label} aria-label={label}>
      <img src={agentAvatarDataUri(seed)} alt="" draggable={false} />
    </span>
  );
}
