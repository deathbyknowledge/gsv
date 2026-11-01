/** Things that happen to an owner. Each kind has a default the owner or their Ship may change. */
export type NoticeKind =
  | "contact.request"
  | "contact.message"
  | "contact.invite.accepted"
  | "mail.received"
  | "machine.added"
  | "adapter.connected"
  | "adapter.auth_required";

/** Where a kind's notices go: `messenger` is the owner's private messenger, `none` sends nothing. */
export type NoticeDelivery = "none" | "messenger";

/** What Ship does about a kind: nothing, record it without starting a run, or start a run. */
export type ShipOutcome = "none" | "context" | "wake";

export type NoticeRule = {
  kind: NoticeKind;
  notify: NoticeDelivery;
  ship: ShipOutcome;
  /** What applies while no one has changed the kind. */
  defaultNotify: NoticeDelivery;
  defaultShip: ShipOutcome;
  /** The outcomes this kind allows; a contact's words never start a run on their own. */
  shipChoices: ShipOutcome[];
  /** Who last changed the kind; absent while its default applies. */
  changedBy?: "person" | "ship";
  updatedAtMs?: number;
};

export type NotifyRuleListArgs = Record<string, never>;
export type NotifyRuleListResult = { rules: NoticeRule[] };

export type NotifyRuleSetArgs = { kind: NoticeKind; notify?: NoticeDelivery; ship?: ShipOutcome };
export type NotifyRuleSetResult = { rule: NoticeRule };

export type NotifyRuleResetArgs = { kind: NoticeKind };
export type NotifyRuleResetResult = { rule: NoticeRule };
