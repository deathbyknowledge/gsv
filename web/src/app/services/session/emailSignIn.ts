import type { GSVClient } from "@humansandmachines/gsv/client";
import { createPairingSecret, createSessionCredential, SESSION_CREDENTIAL_PATTERN, type ResultOf } from "@humansandmachines/gsv/protocol";
import { z } from "zod";

const STORAGE = "gsv.ui.email-sign-in.v1";
/** As long as its code lasts: Accounts counts from the first send, and sending the code again does not extend it. */
const ATTEMPT_MS = 10 * 60 * 1000;
const attemptSchema = z.strictObject({
  id: z.uuid(), secret: z.string().regex(/^[a-f0-9]{64}$/), credential: z.string().regex(SESSION_CREDENTIAL_PATTERN),
  email: z.string().min(1).max(254), createdAt: z.number(),
  /** The Ship it signs in to: Desktop signs in to several from one app, which shares this storage. */
  url: z.string(),
  /** When the Ship last answered that it sent the code, which is after Accounts sent it. */
  sentAt: z.number().optional(),
});
const failureSchema = z.object({ details: z.object({ signIn: z.enum(["invalid", "expired", "locked", "unavailable"]) }) });

export type EmailSignInAttempt = z.infer<typeof attemptSchema>;
export type EmailSignInFailure = z.infer<typeof failureSchema>["details"]["signIn"];
type RequestClient = Pick<GSVClient, "requestOnce">;

/**
 * The attempt this browser started. It is kept in local storage, so the button in the email finishes signing in from
 * another tab of the same browser, and a lost answer can be retried with the same secret and credential.
 */
export function readEmailSignInAttempt(url: string): EmailSignInAttempt | null {
  try {
    const saved = window.localStorage.getItem(STORAGE);
    const attempt = saved ? attemptSchema.parse(JSON.parse(saved)) : null;
    return attempt && attempt.url === url && emailSignInAttemptLive(attempt) ? attempt : null;
  } catch {
    return null;
  }
}

/** Saved before anything is sent; a browser that cannot keep it cannot sign in this way. */
export function createEmailSignInAttempt(email: string, url: string): EmailSignInAttempt {
  const attempt = { id: crypto.randomUUID(), secret: createPairingSecret(), credential: createSessionCredential(), email: email.trim(), createdAt: Date.now(), url };
  window.localStorage.setItem(STORAGE, JSON.stringify(attempt));
  return attempt;
}

/** Whether the attempt's code can still be used. It was made before its first send, so this ends no later than the code. */
export function emailSignInAttemptLive(attempt: EmailSignInAttempt): boolean {
  return attempt.createdAt > Date.now() - ATTEMPT_MS;
}

/** The attempt after the Ship answered that its code was sent; a browser that cannot keep this still has it in memory. */
export function recordEmailSignInSent(attempt: EmailSignInAttempt): EmailSignInAttempt {
  const sent = { ...attempt, sentAt: Date.now() };
  try { window.localStorage.setItem(STORAGE, JSON.stringify(sent)); } catch {}
  return sent;
}

export function forgetEmailSignInAttempt(): void {
  try { window.localStorage.removeItem(STORAGE); } catch {}
}

export async function sendEmailSignInCode(client: RequestClient, url: string, attempt: EmailSignInAttempt, resend = false): Promise<void> {
  await client.requestOnce(url, "account.signin.start", { id: attempt.id, secret: attempt.secret, email: attempt.email, ...(resend ? { resend: true } : undefined) });
}

export async function redeemEmailSignIn(client: RequestClient, url: string, attempt: EmailSignInAttempt, code: string): Promise<ResultOf<"account.signin.redeem">> {
  return client.requestOnce(url, "account.signin.redeem", { id: attempt.id, secret: attempt.secret, code: code.replace(/\s/g, ""), credential: attempt.credential, label: "gsv-ui-session" });
}

/** Why the Ship refused a sign-in, from the reason it attaches; any other failure has its own message. */
export function emailSignInFailure(error: Error): EmailSignInFailure | null {
  const parsed = failureSchema.safeParse(error);
  return parsed.success ? parsed.data.details.signIn : null;
}

/** The email's button opens `#signin=<id>&code=<code>`; the code leaves the address at once. */
export function takeEmailSignInLink(): { id: string; code: string } | null {
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const id = fragment.get("signin");
  if (id === null) return null;
  window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`);
  const code = fragment.get("code") ?? "";
  return /^\d{6}$/.test(code) ? { id, code } : null;
}
