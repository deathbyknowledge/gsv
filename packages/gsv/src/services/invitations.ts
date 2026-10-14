export type SpaceInvitationAllowance = { total: number; reserved: number; used: number; available: number };
export type SpaceInvitationScope = { version: 1; installationId: string; contactInviteId: string };

/** Trusted Gateway binding. The Kernel supplies the installation and contact identity. */
export interface SpaceInvitationsService {
  getAllowance(input: { version: 1; installationId: string }): Promise<SpaceInvitationAllowance>;
  reserve(input: SpaceInvitationScope & { code: string; expiresAt: number }): Promise<void>;
  cancel(input: SpaceInvitationScope): Promise<void>;
  /** Called only after the Kernel verifies the recipient's signed Space identity. */
  accept(input: SpaceInvitationScope & { recipientOrigin: string }): Promise<void>;
}
