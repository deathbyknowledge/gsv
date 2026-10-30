import type { ApproachSummary } from "../approaches";

export type ApproachCreateArgs = {
  /** The recipient's DID, from the profile its sender read. */
  did: string;
  /** The CID of that profile record; the request names the version its sender read. */
  profileCid: string;
  /** The sender's name, as the recipient will see it. */
  displayName: string;
  text: string;
  idempotencyKey: string;
  /** Local owner's choice for new messages once the request is accepted. */
  shipHandlesMessages?: boolean;
};
export type ApproachGetArgs = { approachId: string };
export type ApproachResult = { approach: ApproachSummary };
export type ApproachListArgs = {
  direction: "incoming" | "outgoing";
  status?: "active" | "history";
  before?: { createdAtMs: number; id: string };
  limit?: number;
};
export type ApproachListResult = {
  approaches: ApproachSummary[];
  next?: { createdAtMs: number; id: string };
};
export type ApproachDecideArgs = {
  approachId: string;
  expectedRevision: number;
  decision: "accept" | "decline" | "withdraw";
  /** Local owner's choice when accepting; ignored for decline and withdraw. */
  shipHandlesMessages?: boolean;
};
export type ApproachRetryArgs = { approachId: string; expectedRevision: number };

/**
 * Why a person reports a message request. Each maps to a com.atproto.moderation
 * reason: spam to reasonSpam, harassment to reasonRude, impersonation to
 * reasonMisleading, sexual to reasonSexual and other to reasonOther.
 */
export const REQUEST_REPORT_CATEGORIES = ["spam", "harassment", "impersonation", "sexual", "other"] as const;
export type RequestReportCategory = typeof REQUEST_REPORT_CATEGORIES[number];

/**
 * Reports an incoming message request to the person's operator and declines it
 * if it is still waiting. The report names the sender by DID and handle, with
 * the category and when the request arrived; their name and message go only
 * with `includeMessage`, exactly as the person saw them.
 */
export type ApproachReportArgs = {
  approachId: string;
  category: RequestReportCategory;
  includeMessage: boolean;
};
