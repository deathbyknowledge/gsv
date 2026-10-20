import type { ApproachCreateArgs, ApproachSummary, PublicProfile, ContactSummary, ConversationInboxEntry } from "@humansandmachines/gsv/protocol";
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
    return url.href;
  } catch { return null; }
}

export function profileAddressLabel(origin: string, deployment: PublicDeploymentConfig = publicDeployment()): string {
  const { hostname, host, port } = new URL(origin);
  const domain = deploymentDomains(deployment)
    .sort((left, right) => right.length - left.length)
    .find((candidate) => hostname === candidate || hostname.endsWith(`.${candidate}`));
  const handle = domain ? hostname.slice(0, -(domain.length + 1)) : "";
  return !port && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(handle) ? `@${handle}` : host;
}

export function approachSendIntent(draft: ApproachDraft): ApproachCreateArgs {
  if (!draft.profile) throw new Error(t("people.compose.openFirst"));
  if (draft.shipHandlesMessages === null) throw new Error(t("people.handling.required"));
  const displayName = (draft.displayName ?? "").trim();
  const previous = draft.intent;
  if (previous && previous.profileUrl === draft.profile.url && previous.profileRevision === draft.profile.revision
    && previous.recipient.shipId === draft.profile.actor.shipId && previous.recipient.subjectId === draft.profile.actor.subjectId
    && previous.displayName === displayName && previous.text === draft.text.trim()
    && previous.shipHandlesMessages === draft.shipHandlesMessages) return previous;
  return { profileUrl: draft.profile.url, recipient: draft.profile.actor, profileRevision: draft.profile.revision,
    displayName, text: draft.text.trim(), shipHandlesMessages: draft.shipHandlesMessages, idempotencyKey: randomId() };
}

export function approachStatus(request: ApproachSummary): TextKey {
  if (request.state === "blocked") return "people.status.blocked";
  if (request.state === "declined") return "people.status.declined";
  if (request.state === "withdrawn") return "people.status.withdrawn";
  if (request.state === "expired") return "people.status.expired";
  if (request.connection === "failed") return "people.status.connectionFailed";
  if (request.connection === "connecting") return "people.status.connecting";
  if (request.connection === "connected" || request.state === "accepted") return "people.status.accepted";
  if (request.delivery === "failed") return "people.status.deliveryFailed";
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
  if (!entry?.preview) return contact.preferences?.muted ? t("people.preview.muted") : new URL(contact.remoteOrigin).host;
  const preview = entry.preview;
  return messagePreview(preview, preview.text || t("people.message.attachments", { count: preview.attachmentCount }));
}

/** The preview's text, led by its author when that is you, your Ship or their Ship. */
export function messagePreview(preview: NonNullable<ConversationInboxEntry["preview"]>, text: string): string {
  return preview.author.kind === "user" ? t("people.preview.you", { text }) : preview.author.kind === "process" ? t("people.preview.yourShip", { text })
    : preview.provenance?.kind === "process" ? t("people.preview.theirShip", { text }) : text;
}
