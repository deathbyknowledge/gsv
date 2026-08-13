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
