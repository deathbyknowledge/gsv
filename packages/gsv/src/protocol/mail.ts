import type { BinaryBody } from "./body";
import type { ManagedMailSummary } from "./managed";

export type ManagedMailAddress = {
  address: string;
  name?: string;
};

export type ManagedMailAttachmentMetadata = {
  mimeType: string;
  size: number;
  filename?: string;
  disposition?: "attachment" | "inline";
  contentId?: string;
};

/**
 * Mail no person wrote to the Ship: an automatic reply such as an out-of-office
 * (`Auto-Submitted: auto-replied`), or a report that a message couldn't be delivered.
 */
export type ManagedMailAutomatic = "reply" | "delivery-report";

export type ManagedInboundMailMetadata = {
  version: 1;
  intakeId: string;
  digest: string;
  receivedAt: number;
  rawSize: number;
  envelope: {
    from: string;
    to: string;
  };
  rfcMessageId?: string;
  sentAt?: number;
  from?: ManagedMailAddress;
  to: ManagedMailAddress[];
  cc: ManagedMailAddress[];
  replyTo: ManagedMailAddress[];
  subject?: string;
  text?: string;
  html?: string;
  attachments: ManagedMailAttachmentMetadata[];
  /** Absent for mail a person wrote. A Gateway that predates it rejects the field. */
  automatic?: ManagedMailAutomatic;
};

export type ManagedInboundMailAccepted = {
  messageId: string;
};

export type ManagedInboundMailCompletion = {
  version: 1;
  intakeId: string;
  messageId: string;
  summary: ManagedMailSummary;
};

export type ManagedOutboundMailState =
  | "queued"
  | "accepted"
  | "failed"
  | "unknown";

export type ManagedOutboundMailReference = {
  version: 1;
  outboundId: string;
  fingerprint: string;
};

export type ManagedOutboundMailLookup = {
  outboundId: string;
};

export type ManagedOutboundMailCommand =
  | (ManagedOutboundMailReference & { installationId: string })
  | (ManagedOutboundMailLookup & { version: 2; installationId: string });

/** The message a reply answers, quoted below the reply as mail clients do. */
export type ManagedOutboundMailQuote = {
  /** The original sender as the mailbox shows them, e.g. `Mike <mike@example.com>`. */
  from: string;
  /** When the original was sent, or received when it carried no date. */
  sentAt: number;
  /** The owner's IANA timezone, for the "On …, Mike wrote:" line. */
  timeZone: string;
  /** Plain text, already cut to the quote limit. */
  text: string;
};

export type ManagedOutboundMailDraft = ManagedOutboundMailReference & {
  from: string;
  /**
   * The recipient, or the list of To recipients. The Kernel sends a list
   * whenever a message has several recipients or copies, which a Worker that
   * predates them refuses rather than dropping anyone.
   */
  to: string | string[];
  cc?: string[];
  subject: string;
  bodyDigest: string;
  textSize: number;
  createdAt: number;
  replyToMessageId?: string;
  inReplyTo?: string;
  references?: string;
  /**
   * Presentation the Kernel derives when the adapter claims the message: the
   * owner's current name for the From line, and the quoted original of a
   * reply. Neither is part of the fingerprinted intent.
   */
  fromName?: string;
  quote?: ManagedOutboundMailQuote;
};

export type ManagedOutboundMailClaim = {
  draft: ManagedOutboundMailDraft;
  body: BinaryBody;
};

export type ManagedOutboundMailCompletion = ManagedOutboundMailReference & {
  state: Exclude<ManagedOutboundMailState, "queued">;
  providerMessageId?: string;
  errorCode?: string;
};

export type ManagedOutboundMailClaimOutcome =
  | ({ status: "ready" } & ManagedOutboundMailClaim)
  | {
      status: "settled";
      completion: ManagedOutboundMailCompletion;
    }
  | {
      status: "rejected";
      errorCode: "reference_mismatch";
    };

export type ManagedMailStorageState = "pending" | "stored";

export type ManagedMailSummaryState =
  | "pending"
  | "running"
  | "notifying"
  | "deferred"
  | "complete";

export type ManagedMailIntakeDiagnostic = {
  intakeId: string;
  digest: string;
  receivedAt: number;
  rawSize: number;
  storageState: ManagedMailStorageState;
  summaryState: ManagedMailSummaryState;
  storageAttempts: number;
  summaryAttempts: number;
  completionAttempts: number;
  messageId?: string;
  storedAt?: number;
  completedAt?: number;
};

export type ListManagedMailIntakesInput = {
  cursor?: string;
  limit?: number;
};

export type ManagedMailIntakePage = {
  items: ManagedMailIntakeDiagnostic[];
  cursor?: string;
};

export type {
  ManagedMailGatewayService,
  MailService as ManagedMailService,
} from "../services/mail";
