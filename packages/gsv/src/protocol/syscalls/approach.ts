import type { ApproachSummary } from "../approaches";
import type { ActorRef } from "../social";

export type ApproachCreateArgs = {
  profileUrl: string;
  recipient: ActorRef;
  profileRevision: number;
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
