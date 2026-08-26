export type EntitlementValue = boolean | number | string;

export type EntitlementSnapshot = {
  version: 1;
  installationId: string;
  revision: string;
  values: Record<string, EntitlementValue>;
  issuedAt: number;
  refreshAfter: number;
  expiresAt: number;
};

export type GetEntitlementsInput = {
  version: 1;
  installationId: string;
};

/** Read-only policy contract consumed by managed services. */
export interface EntitlementsService {
  getEntitlements(input: GetEntitlementsInput): Promise<EntitlementSnapshot>;
}
