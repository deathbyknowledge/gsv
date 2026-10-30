export type ManagedMailSummaryCategory =
  | "personal"
  | "work"
  | "transactional"
  | "newsletter"
  | "spam"
  | "suspicious"
  | "other";

export type MailSendArgs = {
  text: string;
  deliveryId: string;
  to?: string;
  subject?: string;
  replyToMessageId?: string;
};

export type MailSendResult =
  | {
      ok: true;
      deliveryId: string;
      outboundId: string;
      state: "queued" | "accepted" | "failed" | "unknown";
      from: string;
      to: string;
      subject: string;
      errorCode?: string;
      replayed: boolean;
    }
  | {
      ok: false;
      error: string;
      retryable: boolean;
      deliveryId?: string;
      outboundId?: string;
    };

export type MailStatusArgs = {
  deliveryId: string;
};

export type MailOutboundStatus = {
  deliveryId: string;
  outboundId: string;
  state: "staging" | "queued" | "accepted" | "failed" | "unknown";
  from: string;
  to: string;
  subject: string;
  createdAt: number;
  queuedAt: number | null;
  completedAt: number | null;
  providerMessageId?: string;
  errorCode?: string;
};

export type MailStatusResult = {
  outbound: MailOutboundStatus | null;
};

export type MailMessageSummary = {
  messageId: string;
  receivedAt: number;
  sentAt: number | null;
  from: string;
  subject: string | null;
  /** Filled in shortly after the message arrives; null until then. */
  summary: string | null;
  category: ManagedMailSummaryCategory | null;
  requiresAttention: boolean | null;
  attachmentCount: number;
};

export type MailListArgs = {
  /** 1 to 200; 50 by default. */
  limit?: number;
  /** The `next` value of the previous page. */
  before?: string;
};

export type MailPage = {
  /** Newest first. */
  messages: MailMessageSummary[];
  /** Pass as `before` for the next older page; absent on the last page. */
  next?: string;
};

export type MailListResult = MailPage;

export type MailSearchArgs = MailListArgs & {
  /** Words that must all appear, each matched as a word prefix. */
  query: string;
};

export type MailSearchResult = MailPage;

export type MailReadArgs = {
  /** A message id, or an unambiguous prefix of one. */
  messageId: string;
};

export type MailReadResult = {
  message: MailMessageSummary & {
    to: string[];
    cc: string[];
    replyTo: string[];
    attachments: { filename?: string; mimeType: string; size: number }[];
    /** The plain-text rendering, headers first. */
    text: string;
    /** True when `text` was cut short; read `textPath` for all of it. */
    truncated: boolean;
    textPath: string;
    rawPath: string;
  };
};
