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
