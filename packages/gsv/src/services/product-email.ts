/** An explicit signup choice or an operator-confirmed import of earlier choices. */
export type ProductEmailSubscription = {
  requestId: string;
  emailAddress: string;
  recordedAt: number;
  consentedAt: number | null;
  source: "ship-signup" | "ship-existing-user-backfill";
  consentBasis: "signup-checkbox" | "operator-confirmed-existing-opt-ins";
  wordingVersion: string | null;
  locale: string | null;
  importId: string | null;
  ipAddress?: string;
};

/** Operators supply an optional implementation; provider status and suppression stay there. */
export interface ProductEmailService {
  subscribe(input: ProductEmailSubscription): Promise<void>;
}
