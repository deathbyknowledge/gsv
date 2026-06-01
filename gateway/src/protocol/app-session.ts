export type AppSessionState = "active" | "detached" | "closing" | "closed" | "expired";

export type AppSessionClientContext = {
  sessionId: string;
  clientId: string;
  uid: number;
  username: string;
  packageId: string;
  packageName: string;
  entrypointName: string;
  routeBase: string;
  rpcBase: string;
  createdAt: number;
  expiresAt: number;
  lastUsedAt?: number | null;
};

export type AppSessionContext = {
  sessionId: string;
  uid: number;
  username: string;
  packageId: string;
  packageName: string;
  entrypointName: string;
  routeBase: string;
  createdAt: number;
  expiresAt: number;
  lastUsedAt?: number | null;
  state: AppSessionState;
  clients: AppSessionClientContext[];
};

export type AppClientSessionContext = AppSessionClientContext;

export type IssuedAppClientSession = AppClientSessionContext & {
  secret: string;
};

export function buildAppClientRouteBase(sessionId: string, clientId: string): string {
  return `/apps/sessions/${encodeURIComponent(sessionId)}/clients/${encodeURIComponent(clientId)}`;
}

export function buildAppClientRpcBase(sessionId: string, clientId: string): string {
  return `${buildAppClientRouteBase(sessionId, clientId)}/socket`;
}

export function buildAppRunnerName(uid: number, packageId: string): string {
  return `app:${uid}:${packageId}`;
}
