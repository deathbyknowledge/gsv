import type { ApproachCreateArgs, ApproachSummary, PublicProfile } from "@humansandmachines/gsv/protocol";
import { randomId } from "../../../services/ids";

export type ApproachDraft = {
  url: string;
  profile: PublicProfile | null;
  displayName: string;
  text: string;
  intent: ApproachCreateArgs | null;
};

export function emptyApproachDraft(url = ""): ApproachDraft {
  return { url, profile: null, displayName: "", text: "", intent: null };
}

export function approachSendIntent(draft: ApproachDraft): ApproachCreateArgs {
  if (!draft.profile) throw new Error("Open a profile before writing to someone");
  const previous = draft.intent;
  if (previous && previous.profileUrl === draft.profile.url && previous.profileRevision === draft.profile.revision
    && previous.recipient.shipId === draft.profile.actor.shipId && previous.recipient.subjectId === draft.profile.actor.subjectId
    && previous.displayName === draft.displayName.trim() && previous.text === draft.text.trim()) return previous;
  return { profileUrl: draft.profile.url, recipient: draft.profile.actor, profileRevision: draft.profile.revision,
    displayName: draft.displayName.trim(), text: draft.text.trim(), idempotencyKey: randomId() };
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
