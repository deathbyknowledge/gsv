export type AppClientSessionContext = {
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

export type IssuedAppClientSession = AppClientSessionContext & {
  secret: string;
};
