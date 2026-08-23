export type ManagedInstallationState =
  | "reserved"
  | "provisioning"
  | "trialing"
  | "active"
  | "past_due"
  | "restricted"
  | "cancelled"
  | "retained"
  | "deleting"
  | "deleted";

export type ManagedInstallationIdentity = {
  installationId: string;
  handle: string;
  canonicalOrigin: string;
};

export type InstallationDirectoryResult =
  | ({ found: true; state: ManagedInstallationState } & ManagedInstallationIdentity)
  | { found: false };

/** Resolves public routing metadata to an immutable installation identity. */
export interface InstallationDirectoryService {
  resolveHostname(hostname: string): Promise<InstallationDirectoryResult>;
  resolveInstallation(
    installationId: string,
  ): Promise<InstallationDirectoryResult>;
}
