import { z } from "zod";

const identity = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$/);

export const installationResetPreparationSchema = z.strictObject({
  version: z.literal(1),
  operationId: identity,
  previousInstallationId: identity,
  replacementInstallationId: identity,
}).refine((input) => input.previousInstallationId !== input.replacementInstallationId, {
  message: "A reset must use a new installation identity",
});

export type InstallationResetPreparation = z.infer<typeof installationResetPreparationSchema>;

export const installationResetPreparedSchema = installationResetPreparationSchema.safeExtend({
  state: z.literal("prepared"),
});

export type InstallationResetPrepared = z.infer<typeof installationResetPreparedSchema>;

/** Bound only to Accounts, after it durably retires the old installation. */
export interface InstallationResetService {
  /**
   * Prepare service-owned replacement state and fence the retired identity.
   * Persist the exact operation before acknowledging it. Replays must return
   * the same receipt without copying policy again or overwriting later changes.
   * This does not authorize erasing the retired installation's data.
   */
  prepareInstallationReset(input: InstallationResetPreparation): Promise<InstallationResetPrepared>;
}

export const installationDeletionRequestSchema = z.strictObject({
  version: z.literal(1),
  operationId: identity,
  installationId: identity,
});
export type InstallationDeletionRequest = z.infer<typeof installationDeletionRequestSchema>;

export const installationDeletionReceiptSchema = installationDeletionRequestSchema.extend({
  phase: z.enum(["pending", "quiescing", "quiesced", "erasing", "live-erased", "erased"]),
  updatedAt: z.number().int().nonnegative(),
  pendingResources: z.number().int().nonnegative(),
  outcome: z.enum(["progress", "complete", "retry", "missing-inventory", "missing-owner", "retention-pending"]),
  retryAfterMs: z.number().int().nonnegative().optional(),
  retainedCopies: z.array(z.strictObject({
    id: identity,
    kind: z.enum(["logs", "backup", "cache", "provider"]),
    expiresAt: z.number().int().nonnegative().nullable(),
  })),
}).refine((receipt) => receipt.phase !== "erased"
  || (receipt.pendingResources === 0 && receipt.retainedCopies.length === 0 && receipt.outcome === "complete"), {
  message: "Erasure requires every resource and retained copy to be cleared",
});
export type InstallationDeletionReceipt = z.infer<typeof installationDeletionReceiptSchema>;

/**
 * Bound only to Accounts after it has closed admission for the immutable identity.
 * Every owner persists its operation, inventory and cursor. Calls resume the same
 * operation; a missing response is never an erasure acknowledgment. A minimal
 * tombstone survives erasure to reject late writes and reuse of the identity.
 */
export interface InstallationDeletionService {
  quiesceInstallation(input: InstallationDeletionRequest): Promise<InstallationDeletionReceipt>;
  eraseInstallation(input: InstallationDeletionRequest): Promise<InstallationDeletionReceipt>;
  installationDeletionStatus(input: InstallationDeletionRequest): Promise<InstallationDeletionReceipt>;
}
