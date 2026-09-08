import type { ProcHistoryEventAudience } from "../events";

export type SignalWatchArgs = {
  signal: string;
  processId?: string;
  /** Exact visible target; mutually exclusive with processId. */
  targetId?: string;
  /** Target event audience; defaults to person. Process signal watches keep their existing behavior. */
  audience?: ProcHistoryEventAudience;
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
