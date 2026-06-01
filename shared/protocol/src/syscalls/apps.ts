export type AppLaunchWindowHint = {
  title: string;
  width?: number;
  height?: number;
  minWidth?: number;
  minHeight?: number;
};

export type AppOpenArgs = {
  packageName: string;
  entrypointName?: string;
  clientId?: string;
  suffix?: string;
  search?: string;
  hash?: string;
};

export type AppAttachArgs = {
  sessionId: string;
  clientId?: string;
  suffix?: string;
  search?: string;
  hash?: string;
};

export type AppLaunchResult = {
  sessionId: string;
  packageId: string;
  packageName: string;
  entrypointName: string;
  routeBase: string;
  clientId: string;
  launchUrl: string;
  expiresAt: number;
  window: AppLaunchWindowHint;
};

export type AppListArgs = Record<string, never>;

export type AppSessionState = "active" | "detached" | "closing" | "closed" | "expired";
export type AppSessionClientState = "active" | "closed" | "expired";

export type AppSessionClientSummary = {
  clientId: string;
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number;
  state: AppSessionClientState;
};

export type AppSessionSummary = {
  sessionId: string;
  packageId: string;
  packageName: string;
  entrypointName: string;
  routeBase: string;
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number;
  state: AppSessionState;
  clients: AppSessionClientSummary[];
};

export type AppListResult = {
  sessions: AppSessionSummary[];
};

export type AppDetachArgs = {
  sessionId: string;
  clientId: string;
};

export type AppDetachResult = {
  detached: boolean;
};

export type AppCloseArgs = {
  sessionId: string;
};

export type AppCloseResult = {
  closed: boolean;
};
