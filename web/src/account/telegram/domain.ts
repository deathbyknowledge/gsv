import type {
  ManagedTelegramClaimInspection,
  ManagedTelegramInstallation,
} from "./types";

const MAX_CLAIM_LENGTH = 2_048;

export function claimFromHash(hash: string): string | null {
  if (!hash.startsWith("#")) return null;
  const claim = new URLSearchParams(hash.slice(1)).get("claim");
  if (
    !claim
    || claim.length > MAX_CLAIM_LENGTH
    || claim.trim() !== claim
    || /\s/.test(claim)
  ) {
    return null;
  }
  return claim;
}

export function locationWithoutHash(
  location: Pick<Location, "pathname" | "search">,
): string {
  return `${location.pathname}${location.search}`;
}

export function initialInstallationId(
  inspection: ManagedTelegramClaimInspection,
  previousId?: string,
): string | null {
  if (
    previousId
    && inspection.installations.some(
      (installation) => installation.installationId === previousId,
    )
  ) {
    return previousId;
  }
  return inspection.installations.length === 1
    ? inspection.installations[0].installationId
    : null;
}

export function telegramIdentity(
  claim: ManagedTelegramClaimInspection["claim"],
): { primary: string; secondary?: string } {
  if (claim.actorName && claim.actorHandle) {
    return { primary: claim.actorName, secondary: claim.actorHandle };
  }
  if (claim.actorName) return { primary: claim.actorName };
  if (claim.actorHandle) return { primary: claim.actorHandle };
  return { primary: "Your Telegram account" };
}

export function installationHostname(
  installation: ManagedTelegramInstallation,
): string {
  return new URL(installation.canonicalOrigin).hostname;
}
