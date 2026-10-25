import { contactDisplayName, type ApproachCreateArgs, type ApproachSummary, type PublicProfile, type ContactSummary, type ConversationInboxEntry } from "@humansandmachines/gsv/protocol";
import { randomId } from "../../../services/ids";
import { publicDeployment } from "../../../services/deployment";
import { deploymentDomains, type PublicDeploymentConfig } from "@humansandmachines/gsv/services/deployment";
import { t, type TextKey } from "../../../i18n/locale";

export type ApproachDraft = {
  url: string;
  profile: PublicProfile | null;
  displayName: string | null;
  text: string;
  shipHandlesMessages: boolean | null;
  intent: ApproachCreateArgs | null;
};

export function emptyApproachDraft(url = ""): ApproachDraft {
  return { url, profile: null, displayName: null, text: "", shipHandlesMessages: null, intent: null };
}

export function profileAddress(value: string, deployment: PublicDeploymentConfig = publicDeployment()): string | null {
  const text = value.trim();
  const handle = text.replace(/^@/, "").toLowerCase();
  if (/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(handle)) return deployment.primaryDomain ? `https://${handle}.${deployment.primaryDomain}/profile` : null;
  if (!text || (!/^https?:\/\//i.test(text) && !text.includes("."))) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) && !/^https?:\/\//i.test(text)) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return null;
    // A bare handle or host names the profile page it serves.
    if (url.pathname === "/") url.pathname = "/profile";
    return url.href;
  } catch { return null; }
}

/** A handle as People shows it: short for a Ship on this deployment's own domains, whole for one elsewhere. */
export function handleLabel(handle: string, deployment: PublicDeploymentConfig = publicDeployment()): string {
  const domain = deploymentDomains(deployment)
    .sort((left, right) => right.length - left.length)
    .find((candidate) => handle === candidate || handle.endsWith(`.${candidate}`));
  const short = domain ? handle.slice(0, -(domain.length + 1)) : "";
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(short) ? `@${short}` : handle;
}

/** A contact's profile page; only a handle that names their DID back leads to one. */
export function contactProfileUrl(contact: Pick<ContactSummary, "remoteHandle">): string | null {
  return contact.remoteHandle ? `https://${contact.remoteHandle}/profile` : null;
}

/** What People hands Ship when asked to help with a contact: who they are and, when known, where their profile is. */
export function contactAsk(contact: ContactSummary, task: string): string {
  const name = contactDisplayName(contact);
  const profile = contactProfileUrl(contact);
  const subject = profile ? `Help me with ${JSON.stringify(name)}'s Ship profile: ${profile}` : `Help me with my contact ${JSON.stringify(name)}.`;
  return `${subject}\n\n${task.replaceAll("{name}", contact.remoteHandle ? `${name} (${contact.remoteHandle})` : name)}`;
}

export function approachSendIntent(draft: ApproachDraft): ApproachCreateArgs {
  if (!draft.profile) throw new Error(t("people.compose.openFirst"));
  if (draft.shipHandlesMessages === null) throw new Error(t("people.handling.required"));
  const displayName = (draft.displayName ?? "").trim();
  const previous = draft.intent;
  if (previous && previous.did === draft.profile.did && previous.profileCid === draft.profile.cid
    && previous.displayName === displayName && previous.text === draft.text.trim()
    && previous.shipHandlesMessages === draft.shipHandlesMessages) return previous;
  return { did: draft.profile.did, profileCid: draft.profile.cid,
    displayName, text: draft.text.trim(), shipHandlesMessages: draft.shipHandlesMessages, idempotencyKey: randomId() };
}

/** A request's status; while the person's whole Ship is taken down, that is why its delivery or connection failed. */
export function approachStatus(request: ApproachSummary, shipTakenDown: boolean): TextKey {
  if (request.state === "blocked") return "people.status.blocked";
  if (request.state === "declined") return "people.status.declined";
  if (request.state === "withdrawn") return "people.status.withdrawn";
  if (request.state === "expired") return "people.status.expired";
  if (request.connection === "failed") return shipTakenDown ? "people.status.shipTakenDown" : "people.status.connectionFailed";
  if (request.connection === "connecting") return "people.status.connecting";
  if (request.connection === "connected" || request.state === "accepted") return "people.status.accepted";
  if (request.delivery === "failed") return shipTakenDown ? "people.status.shipTakenDown" : "people.status.deliveryFailed";
  if (request.state === "preparing") return "people.status.preparing";
  if (request.direction === "incoming") return "people.status.awaitingDecision";
  return request.delivery === "received" ? "people.status.received" : "people.status.sending";
}

export function requestMayRetry(request: ApproachSummary): boolean {
  return request.direction === "incoming" ? request.connection === "failed"
    : ["pending", "preparing"].includes(request.state) && request.delivery === "failed";
}

export function inboxPreview(contact: ContactSummary, entry?: ConversationInboxEntry): string {
  if (contact.blocked) return t("people.contactBlocked");
  if (contact.state === "revoked") return t("people.preview.ended");
  if (!entry?.preview) return contact.preferences?.muted ? t("people.preview.muted") : contact.remoteHandle ? handleLabel(contact.remoteHandle) : "";
  const preview = entry.preview;
  return messagePreview(preview, preview.text || t("people.message.attachments", { count: preview.attachmentCount }));
}

/** The preview's text, led by its author when that is you, your Ship or their Ship. */
export function messagePreview(preview: NonNullable<ConversationInboxEntry["preview"]>, text: string): string {
  return preview.author.kind === "user" ? t("people.preview.you", { text }) : preview.author.kind === "process" ? t("people.preview.yourShip", { text })
    : preview.provenance?.kind === "process" ? t("people.preview.theirShip", { text }) : text;
}
