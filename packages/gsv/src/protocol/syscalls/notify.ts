/** What an owner is told about on their messenger. Each kind has a default the owner or their Ship may change. */
export type NoticeKind = "contact.request" | "contact.message" | "contact.invite.accepted";

/** Where a kind's notices go: `messenger` is the owner's private messenger, `none` sends nothing. */
export type NoticeDelivery = "none" | "messenger";

export type NoticeRule = {
  kind: NoticeKind;
  notify: NoticeDelivery;
  /** What applies while no one has changed the kind. */
  defaultNotify: NoticeDelivery;
  /** Who last changed the kind; absent while its default applies. */
  changedBy?: "person" | "ship";
  updatedAtMs?: number;
};

export type NotifyRuleListArgs = Record<string, never>;
export type NotifyRuleListResult = { rules: NoticeRule[] };

export type NotifyRuleSetArgs = { kind: NoticeKind; notify: NoticeDelivery };
export type NotifyRuleSetResult = { rule: NoticeRule };

export type NotifyRuleResetArgs = { kind: NoticeKind };
export type NotifyRuleResetResult = { rule: NoticeRule };
