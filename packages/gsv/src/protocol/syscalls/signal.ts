export type SignalWatchOwner = {
  appSessionId: string;
  clientId: string;
};

export type SignalWatchArgs = {
  signal: string;
  processId?: string;
  key?: string;
  state?: unknown;
  owner?: SignalWatchOwner;
  once?: boolean;
  ttlMs?: number;
};

export type SignalWatchResult = {
  watchId: string;
  created: boolean;
  createdAt: number;
  expiresAt: number | null;
};

export type SignalUnwatchArgs =
  | { watchId: string; key?: never; owner?: SignalWatchOwner }
  | { watchId?: never; key: string; owner?: SignalWatchOwner };

export type SignalUnwatchResult = {
  removed: number;
};
