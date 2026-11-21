import { deploymentDomains, type PublicDeploymentConfig } from "../services/deployment";

/** A handle (one DNS label) or a Ship's host name. */
const INVITE_TARGET = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;

/**
 * A person's invitation link. It carries no secret and never expires: whoever opens it creates a
 * Ship, or signs in to theirs, and sends the person an ordinary message request. It names a hosted
 * Ship by its handle on the operator's signup page and any other Ship by its host; without operator
 * signup it is the Ship's address, which shows its public profile.
 */
export function contactInviteUrl(shipOrigin: string, presentation: PublicDeploymentConfig): string {
  if (!presentation.signupUrl) return new URL(shipOrigin).origin;
  const host = new URL(shipOrigin).host;
  const domain = deploymentDomains(presentation).find((candidate) => host.endsWith(`.${candidate}`));
  const url = new URL(presentation.signupUrl);
  url.searchParams.set("invite", domain ? host.slice(0, -domain.length - 1) : host);
  return url.href;
}

/**
 * The person an invitation link's `invite` value names, as signup shows them, and their profile's address,
 * where a Ship sends its request. A handle names a Ship on `primaryDomain`; null when the value names
 * no one usable.
 */
export function contactInviteFrom(value: string | null | undefined, primaryDomain: string | undefined): { name: string; profile: string } | null {
  const target = value?.trim().toLowerCase();
  if (!target || !INVITE_TARGET.test(target)) return null;
  if (target.includes(".")) return { name: target, profile: `https://${target}` };
  return primaryDomain ? { name: `@${target}`, profile: `https://${target}.${primaryDomain}` } : null;
}
