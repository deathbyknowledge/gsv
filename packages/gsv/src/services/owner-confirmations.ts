import { z } from "zod";

/** What the Kernel asks an installation's owner to confirm; each purpose has its own emails. */
export const OWNER_CONFIRMATION_PURPOSES = ["recovery-sheet"] as const;
export type OwnerConfirmationPurpose = typeof OWNER_CONFIRMATION_PURPOSES[number];

/** A recovery sheet change, as the emails describe it. */
export const OWNER_CONFIRMATION_CHANGES = ["made", "replaced", "removed"] as const;
export type OwnerConfirmationChange = typeof OWNER_CONFIRMATION_CHANGES[number];

/**
 * Who can still undo a change, for the 72 hours the directory allows, which
 * the notice tells the owner:
 * - `operator`: the operator's recovery key, which the identity lists above the host's key that signed the change;
 * - `previous-sheet`: only the sheet the change replaced or removed;
 * - `none`: nothing.
 */
export const OWNER_NOTICE_UNDOS = ["operator", "previous-sheet", "none"] as const;
export type OwnerNoticeUndo = typeof OWNER_NOTICE_UNDOS[number];

const installationIdSchema = z.string().min(1).max(160);
const purposeSchema = z.enum(OWNER_CONFIRMATION_PURPOSES);
/** The SHA-256, in hex, of exactly what the change does; a code confirms that change and no other. */
const subjectHashSchema = z.string().regex(/^[0-9a-f]{64}$/);
const changeSchema = z.enum(OWNER_CONFIRMATION_CHANGES);
/** Milliseconds since the epoch. */
const timeSchema = z.number().int().nonnegative();
/** The Ship's hostname on the open network, which the emails name it by. */
const shipSchema = z.string().max(253).regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/);

export const ownerConfirmationRequestSchema = z.strictObject({
  installationId: installationIdSchema,
  purpose: purposeSchema,
  subjectHash: subjectHashSchema,
  change: changeSchema,
  ship: shipSchema,
});
export type OwnerConfirmationRequest = z.infer<typeof ownerConfirmationRequestSchema>;

export const ownerConfirmationCheckSchema = z.strictObject({
  installationId: installationIdSchema,
  purpose: purposeSchema,
  subjectHash: subjectHashSchema,
  /** The code the owner typed, as the email shows it. */
  code: z.string().regex(/^[0-9]{6}$/),
});
export type OwnerConfirmationCheck = z.infer<typeof ownerConfirmationCheckSchema>;

export const ownerNoticeSchema = z.strictObject({
  installationId: installationIdSchema,
  purpose: purposeSchema,
  change: changeSchema,
  ship: shipSchema,
  /** The public sheet code of the sheet made, or of the one removed. */
  sheetCode: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{3}$/),
  undo: z.enum(OWNER_NOTICE_UNDOS),
});
export type OwnerNotice = z.infer<typeof ownerNoticeSchema>;

/**
 * - `sent`: the owner's email holds a code now; `to` names the address masked.
 * - `wait`: a code went out too recently, or too many did this hour; ask again at `retryAt`.
 * - `no-address`: the installation's owner has no verified email address.
 * - `not-configured`: this Accounts sends no email at all, a fact of its deployment.
 *
 * A transient failure throws instead.
 */
export const ownerConfirmationRequestResultSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("sent"), to: z.string().min(1).max(320), expiresAt: timeSchema, retryAt: timeSchema }),
  z.strictObject({ status: z.literal("wait"), retryAt: timeSchema }),
  z.strictObject({ status: z.literal("no-address") }),
  z.strictObject({ status: z.literal("not-configured") }),
]);
export type OwnerConfirmationRequestResult = z.infer<typeof ownerConfirmationRequestResultSchema>;

/**
 * - `confirmed`: the code was right, and is used up.
 * - `wrong`: the code isn't the one sent for this change.
 * - `expired`: no code is open for it: it expired, was used, was replaced by a newer one, or took five wrong tries.
 */
export const ownerConfirmationCheckResultSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("confirmed") }),
  z.strictObject({ status: z.literal("wrong"), attemptsLeft: z.number().int().nonnegative() }),
  z.strictObject({ status: z.literal("expired") }),
]);
export type OwnerConfirmationCheckResult = z.infer<typeof ownerConfirmationCheckResultSchema>;

/**
 * Bound only to the Kernel, with deployment-owned authority; the Kernel names
 * its own installation. Accounts emails the installation's owner a code for
 * one exact change and checks it. The code leaves Accounts only in that email,
 * and Accounts keeps only a keyed hash of it.
 */
export interface InstallationOwnerConfirmationService {
  requestOwnerConfirmation(input: OwnerConfirmationRequest): Promise<OwnerConfirmationRequestResult>;
  confirmOwnerConfirmation(input: OwnerConfirmationCheck): Promise<OwnerConfirmationCheckResult>;
  /** Emails the owner that a change was made; `sent` is false when there's no address or no email. */
  notifyOwner(input: OwnerNotice): Promise<{ sent: boolean }>;
}
