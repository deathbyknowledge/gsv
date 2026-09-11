/** A human-issued invitation can enroll one machine peer, including a browser target. */
export type DevicePairing = {
  id: string;
  username: string;
  targetId: string;
  label: string;
  createdAt: number;
  expiresAt: number;
  state: "pending" | "paired" | "cancelled" | "expired";
};

export type SysPairCreateArgs = {
  /** Persist a fresh UUID and random secret before sending, so creation can be retried. */
  id: string;
  secret: string;
  targetId: string;
  label: string;
  /** Explicitly enroll the caller's existing place again, retaining its stable ID. */
  replace?: boolean;
};
export type SysPairCreateResult = { pairing: DevicePairing };
export type SysPairListArgs = {};
export type SysPairListResult = { pairings: DevicePairing[] };
export type SysPairCancelArgs = { id: string };
export type SysPairCancelResult = { pairing: DevicePairing };
export type SysPairRedeemArgs = {
  id: string;
  secret: string;
  /** A random device credential persisted by the receiving client before redemption. */
  credential: string;
};
export type SysPairRedeemResult = {
  pairing: DevicePairing;
  tokenId: string;
};
