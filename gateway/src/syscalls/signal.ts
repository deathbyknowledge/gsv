export type SignalWatchArgs = {
  signal: string;
  processId?: string;
  key?: string;
  state?: unknown;
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
  | { watchId: string; key?: never }
  | { watchId?: never; key: string };

export type SignalUnwatchResult = {
  removed: number;
};
