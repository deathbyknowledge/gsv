export type BillingSubscriptionState =
  | "pending"
  | "trialing"
  | "active"
  | "past_due"
  | "cancelled"
  | "restricted"
  | "retained";

export type BillingInstallation = {
  installationId: string;
  handle: string;
  canonicalOrigin: string;
  installationState:
    | "reserved"
    | "provisioning"
    | "trialing"
    | "active"
    | "past_due"
    | "restricted"
    | "cancelled"
    | "retained"
    | "deleting"
    | "deleted";
  operationState: "reserved" | "provisioning" | "complete" | "failed";
  subscription: null | {
    planKey: string;
    state: BillingSubscriptionState;
    currentPeriodEndsAt: number;
    cancelAtPeriodEnd: boolean;
    paidThrough: number | null;
    graceEndsAt: number | null;
    retentionEndsAt: number | null;
  };
};

export type BillingOverview = {
  offer: {
    planKey: string;
    currency: string;
    monthlyPriceMinor: number;
  };
  installations: BillingInstallation[];
};

export type HostedBillingSession = {
  url: string;
  expiresAt?: number;
};
