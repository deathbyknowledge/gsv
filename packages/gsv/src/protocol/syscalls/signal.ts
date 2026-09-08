import type { ProcHistoryEventAudience } from "../events";

export type SignalWatchArgs = {
  signal: "target.status";
  /** Exact visible target that produces the registered connection event. */
  targetId: string;
  /** Target event audience; defaults to person. */
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
