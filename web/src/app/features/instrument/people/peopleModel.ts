import type { ApproachCreateArgs, ApproachSummary, PublicProfile, ContactSummary, ConversationInboxEntry } from "@humansandmachines/gsv/protocol";
import { randomId } from "../../../services/ids";

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

export function profileAddress(value: string): string | null {
  const text = value.trim();
  const handle = text.replace(/^@/, "").toLowerCase();
  if (/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(handle)) return `https://${handle}.gsv.space/profile`;
  if (!text || (!/^https?:\/\//i.test(text) && !text.includes("."))) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) && !/^https?:\/\//i.test(text)) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}

export function profileAddressLabel(origin: string): string {
  const { hostname, host, port } = new URL(origin);
  const managed = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.gsv\.space$/.exec(hostname);
  return managed && !port ? `@${managed[1]}` : host;
}

export function approachSendIntent(draft: ApproachDraft): ApproachCreateArgs {
  if (!draft.profile) throw new Error("Open a profile before writing to someone");
  if (draft.shipHandlesMessages === null) throw new Error("Choose who should handle new messages");
  const displayName = (draft.displayName ?? "").trim();
  const previous = draft.intent;
  if (previous && previous.profileUrl === draft.profile.url && previous.profileRevision === draft.profile.revision
    && previous.recipient.shipId === draft.profile.actor.shipId && previous.recipient.subjectId === draft.profile.actor.subjectId
    && previous.displayName === displayName && previous.text === draft.text.trim()
    && previous.shipHandlesMessages === draft.shipHandlesMessages) return previous;
  return { profileUrl: draft.profile.url, recipient: draft.profile.actor, profileRevision: draft.profile.revision,
    displayName, text: draft.text.trim(), shipHandlesMessages: draft.shipHandlesMessages, idempotencyKey: randomId() };
}

export function approachStatus(request: ApproachSummary): string {
  if (request.state === "blocked") return "Blocked";
  if (request.state === "declined") return "Declined";
  if (request.state === "withdrawn") return "Withdrawn";
  if (request.state === "expired") return "Expired";
  if (request.connection === "failed") return "Connection needs a retry";
  if (request.connection === "connecting") return "Connecting…";
  if (request.connection === "connected" || request.state === "accepted") return "Accepted";
  if (request.delivery === "failed") return "Could not confirm receipt";
  if (request.state === "preparing") return "Preparing message…";
  if (request.direction === "incoming") return "Waiting for your decision";
  return request.delivery === "received" ? "Received · awaiting a reply" : "Sending…";
}

export function requestMayRetry(request: ApproachSummary): boolean {
  return request.direction === "incoming" ? request.connection === "failed"
    : ["pending", "preparing"].includes(request.state) && request.delivery === "failed";
}

export function inboxPreview(contact: ContactSummary, entry?: ConversationInboxEntry): string {
  if (contact.blocked) return "Blocked";
  if (contact.state === "revoked") return "Connection ended · history available";
  if (!entry?.preview) return contact.preferences?.muted ? "Muted" : new URL(contact.remoteOrigin).host;
  const preview = entry.preview;
  const author = messagePreviewPrefix(preview);
  return `${author}${preview.text || `${preview.attachmentCount} attachment${preview.attachmentCount === 1 ? "" : "s"}`}`;
}

export function messagePreviewPrefix(preview: NonNullable<ConversationInboxEntry["preview"]>): string {
  return preview.author.kind === "user" ? "You: " : preview.author.kind === "process" ? "Your Ship: "
    : preview.provenance?.kind === "process" ? "Their Ship: " : "";
}
