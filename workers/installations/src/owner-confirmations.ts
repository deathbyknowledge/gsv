import { WorkerEntrypoint } from "cloudflare:workers";
import {
  ownerConfirmationCheckSchema,
  ownerConfirmationRequestSchema,
  ownerNoticeSchema,
  type InstallationOwnerConfirmationService,
  type OwnerConfirmationCheck,
  type OwnerConfirmationCheckResult,
  type OwnerConfirmationRequest,
  type OwnerConfirmationRequestResult,
  type OwnerNotice,
} from "@humansandmachines/gsv/services/owner-confirmations";
import { ownerConfirmationEmail, ownerNoticeEmail } from "./owner-confirmation-email";
import { ownerEmailEnabled, type InstallationOwnerEnvironment } from "./owner-service";

export const OWNER_CONFIRMATION_TTL_MS = 10 * 60 * 1000;
export const OWNER_CONFIRMATION_RESEND_MS = 60 * 1000;
export const OWNER_CONFIRMATION_WINDOW_MS = 60 * 60 * 1000;
export const OWNER_CONFIRMATION_SEND_LIMIT = 5;
export const OWNER_CONFIRMATION_ATTEMPT_LIMIT = 5;
/** The largest multiple of a million a 32-bit draw can reach, so every code is equally likely. */
const CODE_DRAW_LIMIT = 4_294_000_000;

type Subject = Pick<OwnerConfirmationCheck, "installationId" | "purpose" | "subjectHash">;
type OpenConfirmation = { id: string; code_verifier: string; failed_attempts: number; expires_at: number };

/**
 * The codes Accounts emails an installation's owner to confirm one exact change
 * the Kernel asks about. A code names its change, works once, and is kept only
 * as a keyed hash.
 */
export class OwnerConfirmations {
  private readonly key: Promise<CryptoKey>;

  constructor(private readonly db: D1Database, secret: string) {
    this.key = crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  }

  /** Issues a fresh code in place of any open one, unless a code went out too recently. */
  async issue(subject: Subject, now: number): Promise<{ status: "issued"; id: string; code: string; expiresAt: number; retryAt: number } | { status: "wait"; retryAt: number }> {
    const id = `confirmation_${crypto.randomUUID()}`;
    const code = randomCode();
    const expiresAt = now + OWNER_CONFIRMATION_TTL_MS;
    const [inserted] = await this.db.batch([
      this.db.prepare(`INSERT INTO owner_confirmations (id, installation_id, purpose, code_verifier, created_at, expires_at)
        SELECT ?, ?, ?, ?, ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM owner_confirmations WHERE installation_id = ? AND purpose = ? AND created_at > ?)
          AND (SELECT COUNT(*) FROM owner_confirmations WHERE installation_id = ? AND purpose = ? AND created_at > ?) < ${OWNER_CONFIRMATION_SEND_LIMIT}`)
        .bind(id, subject.installationId, subject.purpose, await this.verifier(id, subject, code), now, expiresAt,
          subject.installationId, subject.purpose, now - OWNER_CONFIRMATION_RESEND_MS,
          subject.installationId, subject.purpose, now - OWNER_CONFIRMATION_WINDOW_MS),
      this.db.prepare(`UPDATE owner_confirmations SET closed_at = ?
        WHERE installation_id = ? AND purpose = ? AND id != ? AND closed_at IS NULL
          AND EXISTS (SELECT 1 FROM owner_confirmations WHERE id = ?)`)
        .bind(now, subject.installationId, subject.purpose, id, id),
    ]);
    const retryAt = await this.nextSendAt(subject, now);
    if (inserted!.meta.changes !== 1) return { status: "wait", retryAt };
    return { status: "issued", id, code, expiresAt, retryAt };
  }

  /** Closes a code whose email didn't go out, so it can't be used. */
  async close(id: string, now: number): Promise<void> {
    await this.db.prepare("UPDATE owner_confirmations SET closed_at = ? WHERE id = ? AND closed_at IS NULL").bind(now, id).run();
  }

  /** Checks a code against the newest open code for the change, using it up when it's right. */
  async confirm(check: OwnerConfirmationCheck, now: number): Promise<OwnerConfirmationCheckResult> {
    const open = await this.db.prepare(`SELECT id, code_verifier, failed_attempts, expires_at FROM owner_confirmations
      WHERE installation_id = ? AND purpose = ? AND closed_at IS NULL ORDER BY created_at DESC LIMIT 1`)
      .bind(check.installationId, check.purpose).first<OpenConfirmation>();
    if (!open || open.expires_at <= now || open.failed_attempts >= OWNER_CONFIRMATION_ATTEMPT_LIMIT) return { status: "expired" };
    const verifier = await this.verifier(open.id, check, check.code);
    const live = `id = ? AND closed_at IS NULL AND failed_attempts < ${OWNER_CONFIRMATION_ATTEMPT_LIMIT} AND expires_at > ?`;
    const [, used] = await this.db.batch([
      this.db.prepare(`UPDATE owner_confirmations SET failed_attempts = failed_attempts + 1 WHERE ${live} AND code_verifier != ?`)
        .bind(open.id, now, verifier),
      this.db.prepare(`UPDATE owner_confirmations SET closed_at = ?, confirmed_at = ? WHERE ${live} AND code_verifier = ?`)
        .bind(now, now, open.id, now, verifier),
    ]);
    if (used!.meta.changes === 1) return { status: "confirmed" };
    const after = await this.db.prepare("SELECT failed_attempts, closed_at FROM owner_confirmations WHERE id = ?")
      .bind(open.id).first<{ failed_attempts: number; closed_at: number | null }>();
    const attemptsLeft = OWNER_CONFIRMATION_ATTEMPT_LIMIT - (after?.failed_attempts ?? OWNER_CONFIRMATION_ATTEMPT_LIMIT);
    return after?.closed_at === null && attemptsLeft > 0 ? { status: "wrong", attemptsLeft } : { status: "expired" };
  }

  private async nextSendAt(subject: Subject, now: number): Promise<number> {
    const sends = await this.db.prepare(`SELECT COUNT(*) AS count, MIN(created_at) AS first, MAX(created_at) AS last
      FROM owner_confirmations WHERE installation_id = ? AND purpose = ? AND created_at > ?`)
      .bind(subject.installationId, subject.purpose, now - OWNER_CONFIRMATION_WINDOW_MS)
      .first<{ count: number; first: number | null; last: number | null }>();
    if (!sends || sends.last === null || sends.first === null) return now;
    return Math.max(now, sends.last + OWNER_CONFIRMATION_RESEND_MS,
      sends.count >= OWNER_CONFIRMATION_SEND_LIMIT ? sends.first + OWNER_CONFIRMATION_WINDOW_MS : now);
  }

  private async verifier(id: string, subject: Subject, code: string): Promise<string> {
    const message = JSON.stringify(["owner-confirmation", id, subject.installationId, subject.purpose, subject.subjectHash, code]);
    const signature = await crypto.subtle.sign("HMAC", await this.key, new TextEncoder().encode(message));
    return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
}

/** Forgets codes once they can neither be used nor pace another send. */
export async function forgetOwnerConfirmations(db: D1Database, now = Date.now()): Promise<number> {
  const result = await db.prepare("DELETE FROM owner_confirmations WHERE created_at <= ?").bind(now - OWNER_CONFIRMATION_WINDOW_MS).run();
  return result.meta.changes;
}

/** The Kernel's binding to its installation owner's confirmations; only that binding's authority reaches it. */
export class OwnerConfirmationsEntrypoint extends WorkerEntrypoint<InstallationOwnerEnvironment, { authority: "kernel-owner-confirmation" }>
  implements InstallationOwnerConfirmationService {
  async requestOwnerConfirmation(input: OwnerConfirmationRequest): Promise<OwnerConfirmationRequestResult> {
    this.requireAuthority();
    const request = ownerConfirmationRequestSchema.parse(input);
    if (!ownerEmailEnabled(this.env)) return { status: "not-configured" };
    const email = await ownerEmail(this.env.INSTALLATIONS_DB, request.installationId);
    if (!email) return { status: "no-address" };
    const now = Date.now();
    const confirmations = new OwnerConfirmations(this.env.INSTALLATIONS_DB, this.env.GSV_OWNER_AUTH_SECRET!);
    const issued = await confirmations.issue(request, now);
    if (issued.status === "wait") return issued;
    try {
      await this.send(email, ownerConfirmationEmail(request.change, issued.code, issued.expiresAt, now));
    } catch {
      // Delivery errors can contain addresses and mail bodies. Only expose the outcome.
      await confirmations.close(issued.id, Date.now());
      throw new Error("Accounts couldn't email the confirmation code");
    }
    return { status: "sent", to: maskEmail(email), expiresAt: issued.expiresAt, retryAt: issued.retryAt };
  }

  async confirmOwnerConfirmation(input: OwnerConfirmationCheck): Promise<OwnerConfirmationCheckResult> {
    this.requireAuthority();
    const check = ownerConfirmationCheckSchema.parse(input);
    if (!ownerEmailEnabled(this.env)) return { status: "expired" };
    return await new OwnerConfirmations(this.env.INSTALLATIONS_DB, this.env.GSV_OWNER_AUTH_SECRET!).confirm(check, Date.now());
  }

  async notifyOwner(input: OwnerNotice): Promise<{ sent: boolean }> {
    this.requireAuthority();
    const notice = ownerNoticeSchema.parse(input);
    if (!ownerEmailEnabled(this.env)) return { sent: false };
    const email = await ownerEmail(this.env.INSTALLATIONS_DB, notice.installationId);
    if (!email) return { sent: false };
    try {
      await this.send(email, ownerNoticeEmail(notice, Date.now()));
    } catch {
      // Delivery errors can contain addresses and mail bodies. Only expose the outcome.
      throw new Error("Accounts couldn't email the notice");
    }
    return { sent: true };
  }

  private requireAuthority(): void {
    if (this.ctx.props?.authority !== "kernel-owner-confirmation") throw new Error("Owner confirmation authority is required");
  }

  private async send(to: string, email: { subject: string; text: string; html: string }): Promise<void> {
    const message: EmailMessageBuilder = { from: { email: this.env.GSV_OWNER_EMAIL_FROM!, name: "Ship" }, to, ...email };
    if (this.env.GSV_OWNER_EMAIL_REPLY_TO) message.replyTo = this.env.GSV_OWNER_EMAIL_REPLY_TO;
    await this.env.OWNER_EMAIL!.send(message);
  }
}

/** The verified address of the installation's owner, or null when they have none. */
async function ownerEmail(db: D1Database, installationId: string): Promise<string | null> {
  const owner = await db.prepare(`SELECT p.primary_email AS email FROM installations i JOIN principals p ON p.id = i.owner_principal_id
    WHERE i.id = ? AND p.state = 'active' AND p.email_verified_at IS NOT NULL`).bind(installationId).first<{ email: string }>();
  return owner?.email ?? null;
}

/** Enough of an address for its owner to recognise it, such as `a•••@example.com`. */
function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  return `${email.slice(0, 1)}•••${email.slice(at)}`;
}

function randomCode(): string {
  const draw = new Uint32Array(1);
  do crypto.getRandomValues(draw); while (draw[0]! >= CODE_DRAW_LIMIT);
  return (draw[0]! % 1_000_000).toString().padStart(6, "0");
}
