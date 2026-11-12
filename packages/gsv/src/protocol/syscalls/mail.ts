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
  /** One address or several. A reply derives its own. */
  to?: string | string[];
  /** Addresses to copy, on a new message or a reply. */
  cc?: string | string[];
  subject?: string;
  replyToMessageId?: string;
  /** With `replyToMessageId`, also copy everyone else the original was sent to. */
  replyAll?: boolean;
  /**
   * iCalendar text of an event this account organizes, with METHOD:REQUEST to
   * invite or update and METHOD:CANCEL to withdraw it. Mail apps show it as an
   * invitation. A repeating event comes whole, with the dates changed from it.
   * The message goes to the event's guests: without `to`, they become the
   * recipients; otherwise To and Cc, or a reply's recipients, must be them.
   */
  invite?: string;
};

/**
 * How an approval for `mail.send` shows its invite: the event as the owner reads
 * it, times like 2026-11-27T21:15:00+01:00[Europe/Amsterdam] in their time zone
 * and all-day events by their first and last day. A repeating event adds its rule,
 * the dates it skips, and the dates changed from it.
 */
export type MailInviteApproval = {
  method: "REQUEST" | "CANCEL";
  title?: string;
  allDay: boolean;
  start: string;
  end?: string;
  /**
   * The zone every time is in when it isn't the owner's: a repeating event's rule
   * counts days in its own zone (or UTC), so its times are shown there.
   */
  timeZone?: string;
  location?: string;
  repeats?: MailInviteRepeat;
  /** Dates the event skips, by the start each would have had. */
  skipped?: string[];
  /** Dates changed from the rule: the start each would have had, and when it happens now. */
  changed?: Array<{ from: string; start: string; end?: string }>;
};

/**
 * An invite's repeat rule (RFC 5545 RRULE) with what it leaves to the start written
 * out: a weekly rule's day, a monthly rule's day of the month, a yearly rule's date.
 */
export type MailInviteRepeat = {
  freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
  /** Every how many days, weeks, months or years. */
  interval: number;
  /** Weekdays such as MO, or within a month its 4th (4FR) or last (-1FR) one. */
  byDay?: string[];
  /** Days of the month, -1 for the last. */
  byMonthDay?: number[];
  byMonth?: number[];
  /** How many times it happens, counting the first. */
  count?: number;
  /** The last date or time it may start, as `start` reads. */
  until?: string;
};

export type MailSendResult =
  | {
      ok: true;
      deliveryId: string;
      outboundId: string;
      state: "queued" | "accepted" | "failed" | "unknown";
      from: string;
      /** Recipients separated by `, `, as in a To header. */
      to: string;
      /** Copied recipients in the same form; absent when none. */
      cc?: string;
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
  /** Recipients separated by `, `, as in a To header. */
  to: string;
  /** Copied recipients in the same form; absent when none. */
  cc?: string;
  subject: string;
  /** The message as written, in Markdown. */
  textPath: string;
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

export type MailSentArgs = MailListArgs;

export type MailSentResult = {
  /** Newest first. */
  outbound: MailOutboundStatus[];
  /** Pass as `before` for the next older page; absent on the last page. */
  next?: string;
};

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
