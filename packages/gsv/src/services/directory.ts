export type InstallationState =
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

export type InstallationIdentity = {
  installationId: string;
  handle: string;
  canonicalOrigin: string;
};

export type InstallationDirectoryResult =
  | ({
    found: true;
    state: InstallationState;
    ownerSetupRecovery?: true;
    /**
     * Grows with every change of the installation's state. Accounts reports
     * it only while it tells the Gateway of each change, so a Kernel may keep
     * the state with the highest revision it has read instead of asking again.
     */
    stateRevision?: number;
  } & InstallationIdentity)
  | { found: false };

/** Resolves public routing metadata to an immutable installation identity. */
export interface InstallationDirectoryService {
  resolveHostname(hostname: string): Promise<InstallationDirectoryResult>;
  resolveInstallation(
    installationId: string,
  ): Promise<InstallationDirectoryResult>;
}

/** @deprecated Use InstallationState; retained for independently pinned consumers. */
export type ManagedInstallationState = InstallationState;
/** @deprecated Use InstallationIdentity; retained for independently pinned consumers. */
export type ManagedInstallationIdentity = InstallationIdentity;
