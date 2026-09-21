import type { ApproachSummary } from "../approaches";
import type { ActorRef } from "../social";

export type ApproachCreateArgs = {
  profileUrl: string;
  recipient: ActorRef;
  profileRevision: number;
  displayName: string;
  text: string;
  idempotencyKey: string;
};
export type ApproachGetArgs = { approachId: string };
export type ApproachResult = { approach: ApproachSummary };
export type ApproachListArgs = {
  direction: "incoming" | "outgoing";
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
};
export type ApproachRetryArgs = { approachId: string; expectedRevision: number };
