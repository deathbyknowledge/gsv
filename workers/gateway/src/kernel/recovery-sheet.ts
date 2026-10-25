import {
  bodyToText,
  recoverySheetCode,
  type AtprotoRecoveryGetResult,
  type AtprotoRecoverySetArgs,
  type AtprotoRecoverySetResult,
  type BinaryBody,
  type RecoverySheet,
} from "@humansandmachines/gsv/protocol";
import type { OwnerConfirmationChange } from "@humansandmachines/gsv/services/owner-confirmations";
import { exceptionDiagnostics } from "@humansandmachines/gsv/telemetry";
import { z } from "zod";
import { raceWithAbort } from "../shared/abort";
import { withRepository } from "./atproto";
import { principalOf, type KernelContext } from "./context";

const SHEET_KEY = "recovery_sheet_v1";
const PASSWORD_ATTEMPTS_KEY = "recovery_sheet_password_attempts_v1";
export const RECOVERY_PASSWORD_ATTEMPT_LIMIT = 5;
export const RECOVERY_PASSWORD_WINDOW_MS = 15 * 60 * 1000;
/** A password and a code fit easily; a body any larger is refused unread. */
const CONFIRMATION_MAX_BYTES = 4096;

const sheetKeySchema = z.string().regex(/^did:key:z[1-9A-HJ-NP-Za-km-z]{40,64}$/);
const confirmationSchema = z.strictObject({
  password: z.string().min(1).max(1024),
  code: z.string().regex(/^[0-9]{6}$/).optional(),
});

type MadeSheet = { key: string; madeAt: number };
type ListedKey = { ownerRecoveryKey: string | null; pending: boolean };

/**
 * The sheet this Ship made, and the password attempts its changes took,
 * beside the Kernel where no syscall reaches them.
 */
export class RecoverySheetStore {
  constructor(private readonly storage: DurableObjectStorage) {}

  made(): MadeSheet | null {
    return this.storage.kv.get<MadeSheet>(SHEET_KEY) ?? null;
  }

  remember(key: string | null, now: number): void {
    if (key === null) this.storage.kv.delete(SHEET_KEY);
    else this.storage.kv.put(SHEET_KEY, { key, madeAt: now });
  }

  /**
   * Takes one password attempt before the password is checked, so tries made
   * in parallel can't pass the limit. Returns when the next is free, or null
   * when this one was.
   */
  takeAttempt(now: number): number | null {
    const recent = this.attempts(now);
    if (recent.length >= RECOVERY_PASSWORD_ATTEMPT_LIMIT) return recent[0]! + RECOVERY_PASSWORD_WINDOW_MS;
    this.storage.kv.put(PASSWORD_ATTEMPTS_KEY, [...recent, now]);
    return null;
  }

  /** A right password gives its attempt back, so only wrong ones count. */
  returnAttempt(takenAt: number): void {
    const recent = this.attempts(takenAt);
    const taken = recent.indexOf(takenAt);
    if (taken >= 0) recent.splice(taken, 1);
    this.storage.kv.put(PASSWORD_ATTEMPTS_KEY, recent);
  }

  private attempts(now: number): number[] {
    return (this.storage.kv.get<number[]>(PASSWORD_ATTEMPTS_KEY) ?? []).filter((at) => at > now - RECOVERY_PASSWORD_WINDOW_MS);
  }
}

/** Whether the Ship has an identity for a sheet to keep, and the sheet it lists. */
export async function handleRecoveryGet(ctx: KernelContext): Promise<AtprotoRecoveryGetResult> {
  signedInPerson(ctx);
  const unavailable = { available: false, identity: null, sheet: null };
  if (!ctx.env.PDS || !ctx.env.INSTALLATION_OWNER_CONFIRMATIONS) return unavailable;
  const [account, listed] = await withRepository(ctx, (repository) =>
    raceWithAbort(Promise.all([repository.account(), repository.ownerRecoveryKey()]), ctx.requestSignal));
  if (!account || !listed) return unavailable;
  return { available: true, identity: { did: account.did, handle: account.handle }, sheet: await sheetView(listed, ctx) };
}

/**
 * Makes, replaces or removes the sheet once the person's password, from the
 * request body, and the code Accounts emailed them check out. The password
 * alone is enough only where Accounts sends no email at all.
 */
export async function handleRecoverySet(
  args: AtprotoRecoverySetArgs,
  ctx: KernelContext,
  body: BinaryBody | undefined,
): Promise<AtprotoRecoverySetResult> {
  const person = signedInPerson(ctx);
  const key = args?.key === null ? null : sheetKeySchema.parse(args?.key);
  if (!body) throw new Error("atproto.recovery.set requires the password as its request body");
  const confirmation = confirmationSchema.parse(JSON.parse(await bodyToText(body, CONFIRMATION_MAX_BYTES, ctx.requestSignal)));
  const confirmations = ctx.env.INSTALLATION_OWNER_CONFIRMATIONS;
  if (!ctx.env.PDS || !confirmations) throw new Error("Recovery sheets aren't available on this deployment");

  const now = Date.now();
  const retryAt = ctx.recoverySheet.takeAttempt(now);
  if (retryAt !== null) return { status: "refused", reason: "attempts", retryAt };
  if (!(await ctx.auth.authenticate(person.username, confirmation.password)).ok) return { status: "refused", reason: "password" };
  ctx.recoverySheet.returnAttempt(now);

  return await withRepository(ctx, async (repository) => {
    const [account, listed] = await raceWithAbort(Promise.all([repository.account(), repository.ownerRecoveryKey()]), ctx.requestSignal);
    if (!account || !listed) throw new Error("This Ship has no identity on the open network yet");
    const changing = key !== listed.ownerRecoveryKey;
    if (changing) {
      const subject = {
        installationId: ctx.installationId,
        purpose: "recovery-sheet" as const,
        subjectHash: await changeHash(listed.ownerRecoveryKey, key),
      };
      if (confirmation.code === undefined) {
        const requested = await confirmations.requestOwnerConfirmation({
          ...subject, change: changeOf(listed.ownerRecoveryKey, key), ship: account.handle,
        });
        if (requested.status === "sent") return { status: "code-sent", to: requested.to, expiresAt: requested.expiresAt, retryAt: requested.retryAt };
        if (requested.status === "wait") return { status: "refused", reason: "wait", retryAt: requested.retryAt };
        if (requested.status === "no-address") return { status: "refused", reason: "no-address" };
        // `not-configured`: this deployment's Accounts sends no email, so the password alone confirms the change.
      } else {
        const checked = await confirmations.confirmOwnerConfirmation({ ...subject, code: confirmation.code });
        if (checked.status === "wrong") return { status: "refused", reason: "code", attemptsLeft: checked.attemptsLeft };
        if (checked.status === "expired") return { status: "refused", reason: "code-expired" };
      }
    }
    // The host's work, once accepted, finishes even if the person goes away. It
    // also finishes a confirmed change the directory hasn't taken yet.
    await repository.setOwnerRecoveryKey(key);
    // A retry finishing an earlier call's change announces it, unless that call did.
    const from = changing ? listed.ownerRecoveryKey : ctx.recoverySheet.made()?.key ?? null;
    if (from !== key) {
      ctx.recoverySheet.remember(key, now);
      const sheetCode = await recoverySheetCode((key ?? from)!);
      try {
        await confirmations.notifyOwner({
          installationId: ctx.installationId, purpose: "recovery-sheet", change: changeOf(from, key), ship: account.handle, sheetCode,
        });
      } catch (error) {
        // The change stands, and Settings shows it.
        console.error("[Recovery sheet] the change notice failed:", exceptionDiagnostics(error));
      }
    }
    return { status: "done", sheet: await sheetView({ ownerRecoveryKey: key, pending: false }, ctx) };
  });
}

/** The signed-in person, in their own session: never a process, a tool, an app, a messenger or root. */
function signedInPerson(ctx: KernelContext) {
  const principal = principalOf(ctx);
  const human = ctx.auth.getHumanAccount();
  if (principal?.kind !== "human" || !human || principal.account.uid !== human.uid || !ctx.connection || ctx.processId
    || ctx.toolOwner || ctx.peer?.transport.kind !== "websocket" || ctx.peer.provenance.kind !== "credential") {
    throw new Error("Only the person signed in to this Ship can see or change its recovery sheet");
  }
  const session = ctx.connection.state;
  if (session.step !== "connected" || (session.credentialEpoch ?? 0) !== ctx.auth.credentialEpoch(human.uid)) {
    throw new Error("Your sign-in changed; sign in again");
  }
  return human;
}

async function sheetView(listed: ListedKey, ctx: KernelContext): Promise<RecoverySheet | null> {
  if (listed.ownerRecoveryKey === null) return null;
  const made = ctx.recoverySheet.made();
  return {
    code: await recoverySheetCode(listed.ownerRecoveryKey),
    madeAt: made?.key === listed.ownerRecoveryKey ? made.madeAt : null,
    pending: listed.pending,
  };
}

function changeOf(from: string | null, to: string | null): OwnerConfirmationChange {
  if (to === null) return "removed";
  return from === null ? "made" : "replaced";
}

/** Names exactly what a change does, so its code confirms that change and no other. */
async function changeHash(from: string | null, to: string | null): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify({ from, to })));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
