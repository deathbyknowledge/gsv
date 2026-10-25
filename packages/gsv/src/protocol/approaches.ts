export type ApproachState = "preparing" | "pending" | "accepting" | "accepted" | "declined" | "withdrawn" | "expired" | "blocked";
export type ApproachDeliveryState = "queued" | "received" | "failed" | "unconfirmed";

/** A message request: someone who read a public profile asking to talk. */
export type ApproachSummary = {
  id: string;
  direction: "incoming" | "outgoing";
  /** The request as its sender's Ship names it. */
  requestId: string;
  /** The other person's DID. */
  peerDid: string;
  /** Their handle, shown only once it and their DID name each other. */
  peerHandle?: string;
  displayName: string;
  conversationId: string;
  messageSequence?: number;
  state: ApproachState;
  revision: number;
  delivery: ApproachDeliveryState;
  createdAtMs: number;
  updatedAtMs: number;
  expiresAtMs: number;
  acceptedAtMs?: number;
  /** When the person reported this incoming request to their operator. */
  reportedAtMs?: number;
  contactId?: string;
  connection?: "connecting" | "connected" | "failed";
};
