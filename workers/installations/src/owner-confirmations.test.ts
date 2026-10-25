import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { OwnerConfirmationRequest } from "@humansandmachines/gsv/services/owner-confirmations";
import {
  forgetOwnerConfirmations,
  OWNER_CONFIRMATION_RESEND_MS,
  OWNER_CONFIRMATION_TTL_MS,
  OWNER_CONFIRMATION_WINDOW_MS,
  OwnerConfirmations,
  OwnerConfirmationsEntrypoint,
} from "./owner-confirmations";
import { AccountStore } from "./store";

const db = env.INSTALLATIONS_DB;
const SECRET = "owner-confirmation-test-secret-0123456789";
const CHANGE = "a".repeat(64);
const OTHER_CHANGE = "b".repeat(64);
const NOW = 1_800_000_000_000;

beforeEach(async () => {
  await db.prepare("DELETE FROM owner_confirmations").run();
});

describe("confirming a change by email", () => {
  it("emails the owner a code for one change, keeps only a keyed hash of it, and takes it once", async () => {
    const ship = await activeShip();
    const mail = mailbox();
    const confirmations = entrypoint("kernel-owner-confirmation", mail);
    const sent = await confirmations.requestOwnerConfirmation(request(ship.installationId));
    expect(sent).toEqual({ status: "sent", to: `${ship.email.slice(0, 1)}•••@example.com`, expiresAt: expect.any(Number), retryAt: expect.any(Number) });
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]).toMatchObject({ to: ship.email, subject: "Your Ship recovery sheet code", from: { email: "ship@example.com", name: "Ship" } });
    const code = codeIn(mail.sent[0]!.text ?? "");
    expect(mail.sent[0]!.text).toContain("Enter this code in Ship to make your recovery sheet:");

    const rows = await db.prepare("SELECT * FROM owner_confirmations").all<ConfirmationRow>();
    expect(rows.results).toHaveLength(1);
    expect(JSON.stringify(rows.results)).not.toContain(code);
    expect(rows.results[0]!.code_verifier).toMatch(/^[0-9a-f]{64}$/);

    const check = { installationId: ship.installationId, purpose: "recovery-sheet" as const, subjectHash: CHANGE, code };
    expect(await confirmations.confirmOwnerConfirmation(check)).toEqual({ status: "confirmed" });
    expect(await confirmations.confirmOwnerConfirmation(check)).toEqual({ status: "expired" });
  });

  it("confirms only the change its code was sent for", async () => {
    const ship = await activeShip();
    const store = new OwnerConfirmations(db, SECRET);
    const issued = await store.issue(subject(ship.installationId), NOW);
    if (issued.status !== "issued") throw new Error("expected a code");
    expect(await store.confirm({ ...subject(ship.installationId), subjectHash: OTHER_CHANGE, code: issued.code }, NOW)).toEqual({ status: "wrong", attemptsLeft: 4 });
    expect(await store.confirm({ ...subject(ship.installationId), code: issued.code }, NOW)).toEqual({ status: "confirmed" });
  });

  it("uses a code up after five wrong tries, even for the right code after them", async () => {
    const ship = await activeShip();
    const store = new OwnerConfirmations(db, SECRET);
    const issued = await store.issue(subject(ship.installationId), NOW);
    if (issued.status !== "issued") throw new Error("expected a code");
    const wrong = issued.code === "000000" ? "000001" : "000000";
    const results = [];
    for (let attempt = 0; attempt < 5; attempt += 1) results.push(await store.confirm({ ...subject(ship.installationId), code: wrong }, NOW));
    expect(results).toEqual([
      { status: "wrong", attemptsLeft: 4 }, { status: "wrong", attemptsLeft: 3 }, { status: "wrong", attemptsLeft: 2 },
      { status: "wrong", attemptsLeft: 1 }, { status: "expired" },
    ]);
    expect(await store.confirm({ ...subject(ship.installationId), code: issued.code }, NOW)).toEqual({ status: "expired" });
  });

  it("counts parallel wrong tries one by one", async () => {
    const ship = await activeShip();
    const store = new OwnerConfirmations(db, SECRET);
    const issued = await store.issue(subject(ship.installationId), NOW);
    if (issued.status !== "issued") throw new Error("expected a code");
    const wrong = issued.code === "000000" ? "000001" : "000000";
    await Promise.all(Array.from({ length: 8 }, () => store.confirm({ ...subject(ship.installationId), code: wrong }, NOW)));
    expect(await db.prepare("SELECT failed_attempts FROM owner_confirmations").first("failed_attempts")).toBe(5);
    expect(await store.confirm({ ...subject(ship.installationId), code: issued.code }, NOW)).toEqual({ status: "expired" });
  });

  it("lets a code expire after ten minutes", async () => {
    const ship = await activeShip();
    const store = new OwnerConfirmations(db, SECRET);
    const issued = await store.issue(subject(ship.installationId), NOW);
    if (issued.status !== "issued") throw new Error("expected a code");
    expect(issued.expiresAt).toBe(NOW + OWNER_CONFIRMATION_TTL_MS);
    expect(await store.confirm({ ...subject(ship.installationId), code: issued.code }, issued.expiresAt)).toEqual({ status: "expired" });
  });

  it("sends a code at most once a minute and five times an hour, and only the newest one works", async () => {
    const ship = await activeShip();
    const store = new OwnerConfirmations(db, SECRET);
    const first = await store.issue(subject(ship.installationId), NOW);
    expect(first).toMatchObject({ status: "issued", retryAt: NOW + OWNER_CONFIRMATION_RESEND_MS });
    expect(await store.issue(subject(ship.installationId), NOW + 1_000)).toEqual({ status: "wait", retryAt: NOW + OWNER_CONFIRMATION_RESEND_MS });
    const issued = [first];
    for (let send = 1; send < 5; send += 1) issued.push(await store.issue(subject(ship.installationId), NOW + send * OWNER_CONFIRMATION_RESEND_MS));
    expect(issued.map((code) => code.status)).toEqual(["issued", "issued", "issued", "issued", "issued"]);
    expect(issued[4]).toMatchObject({ retryAt: NOW + OWNER_CONFIRMATION_WINDOW_MS });
    expect(await store.issue(subject(ship.installationId), NOW + 30 * 60_000)).toEqual({ status: "wait", retryAt: NOW + OWNER_CONFIRMATION_WINDOW_MS });

    const at = NOW + 4 * OWNER_CONFIRMATION_RESEND_MS;
    if (first.status !== "issued" || issued[4]!.status !== "issued") throw new Error("expected codes");
    const earlier = await store.confirm({ ...subject(ship.installationId), code: first.code }, at);
    expect(earlier.status === "confirmed").toBe(first.code === issued[4]!.code);
    expect(await store.confirm({ ...subject(ship.installationId), code: issued[4]!.code }, at)).toEqual({ status: "confirmed" });
  });

  it("forgets codes once they can neither be used nor pace a send", async () => {
    const ship = await activeShip();
    await new OwnerConfirmations(db, SECRET).issue(subject(ship.installationId), NOW);
    expect(await forgetOwnerConfirmations(db, NOW + OWNER_CONFIRMATION_WINDOW_MS - 1)).toBe(0);
    expect(await forgetOwnerConfirmations(db, NOW + OWNER_CONFIRMATION_WINDOW_MS)).toBe(1);
  });
});

describe("the Kernel's confirmation binding", () => {
  it("answers not-configured when this Accounts sends no email, so the change needs no code", async () => {
    const ship = await activeShip();
    const confirmations = entrypoint("kernel-owner-confirmation", null);
    expect(await confirmations.requestOwnerConfirmation(request(ship.installationId))).toEqual({ status: "not-configured" });
    expect(await confirmations.confirmOwnerConfirmation({ ...subject(ship.installationId), code: "123456" })).toEqual({ status: "expired" });
    expect(await confirmations.notifyOwner(notice(ship.installationId, "made"))).toEqual({ sent: false });
  });

  it("answers no-address when the owner has no verified email, and sends nothing", async () => {
    const ship = await activeShip(false);
    const mail = mailbox();
    const confirmations = entrypoint("kernel-owner-confirmation", mail);
    expect(await confirmations.requestOwnerConfirmation(request(ship.installationId))).toEqual({ status: "no-address" });
    expect(await confirmations.notifyOwner(notice(ship.installationId, "made"))).toEqual({ sent: false });
    expect(mail.sent).toEqual([]);
  });

  it("throws when the email can't go out, and the code it held can't be used", async () => {
    const ship = await activeShip();
    const failing = { sent: [], send: async () => { throw new Error(`refused for ${ship.email}`); } };
    const confirmations = entrypoint("kernel-owner-confirmation", failing);
    const failure = await confirmations.requestOwnerConfirmation(request(ship.installationId)).then(() => null, String);
    expect(failure).toContain("Accounts couldn't email the confirmation code");
    expect(failure).not.toContain(ship.email);
    expect(await db.prepare("SELECT COUNT(*) AS open FROM owner_confirmations WHERE closed_at IS NULL").first("open")).toBe(0);
  });

  it("emails the owner each change with its sheet code", async () => {
    const ship = await activeShip();
    const mail = mailbox();
    const confirmations = entrypoint("kernel-owner-confirmation", mail);
    for (const change of ["made", "replaced", "removed"] as const) {
      expect(await confirmations.notifyOwner(notice(ship.installationId, change))).toEqual({ sent: true });
    }
    expect(mail.sent.map((message) => message.subject)).toEqual([
      "A recovery sheet was made for @ada.ship.test",
      "A new recovery sheet was made for @ada.ship.test",
      "The recovery sheet for @ada.ship.test was removed",
    ]);
    expect(mail.sent[0]!.text).toMatch(/^On \d{1,2} [A-Z][a-z]+ \d{4} at \d{2}:\d{2} UTC, someone signed in to your Ship made a recovery sheet with sheet code K7Q-P2M\./);
    expect(mail.sent[0]!.text).toContain("If it wasn’t, reply within 3 days and we’ll undo it.");
    expect(mail.sent.every((message) => message.to === ship.email)).toBe(true);
  });

  it.each([undefined, "kernel-report"])("refuses a binding whose authority is %s", async (authority) => {
    const ship = await activeShip();
    const confirmations = entrypoint(authority, mailbox());
    await expect(confirmations.requestOwnerConfirmation(request(ship.installationId))).rejects.toThrow("Owner confirmation authority is required");
    await expect(confirmations.confirmOwnerConfirmation({ ...subject(ship.installationId), code: "123456" })).rejects.toThrow("Owner confirmation authority is required");
    await expect(confirmations.notifyOwner(notice(ship.installationId, "made"))).rejects.toThrow("Owner confirmation authority is required");
  });
});

type ConfirmationRow = {
  id: string;
  installation_id: string;
  purpose: string;
  code_verifier: string;
  failed_attempts: number;
  created_at: number;
  expires_at: number;
  closed_at: number | null;
  confirmed_at: number | null;
};
type Mailbox = { sent: EmailMessageBuilder[]; send(message: EmailMessage | EmailMessageBuilder): Promise<EmailSendResult> };

function mailbox(): Mailbox {
  const box: Mailbox = {
    sent: [],
    async send(message) {
      if (!("subject" in message)) throw new Error("Expected composed mail");
      box.sent.push(message);
      return { messageId: "sent" };
    },
  };
  return box;
}

function codeIn(text: string): string {
  const code = /\b([0-9]{6})\b/.exec(text)?.[1];
  if (!code) throw new Error("The email holds no code");
  return code;
}

function subject(installationId: string) {
  return { installationId, purpose: "recovery-sheet" as const, subjectHash: CHANGE };
}

function request(installationId: string): OwnerConfirmationRequest {
  return { ...subject(installationId), change: "made", ship: "ada.ship.test" };
}

function notice(installationId: string, change: "made" | "replaced" | "removed") {
  return { installationId, purpose: "recovery-sheet" as const, change, ship: "ada.ship.test", sheetCode: "K7Q-P2M" };
}

async function activeShip(verified = true): Promise<{ installationId: string; email: string }> {
  const accounts = new AccountStore(db, "example.com");
  const id = crypto.randomUUID();
  const email = `${id}@example.com`;
  const principal = await accounts.createPrincipal({ email, displayName: "owner", verified: true });
  const { installationId } = await accounts.reserveInstallation({ principalId: principal.id, operationId: `create-${id}`, handle: `c${id.slice(0, 8)}` });
  await db.prepare("UPDATE installations SET state = 'active' WHERE id = ?").bind(installationId).run();
  if (!verified) await db.prepare("UPDATE principals SET email_verified_at = NULL WHERE id = ?").bind(principal.id).run();
  return { installationId, email };
}

/** The entrypoint as the Kernel's binding sees it, with this authority and this mail, or none. */
function entrypoint(authority: string | undefined, mail: Mailbox | null): OwnerConfirmationsEntrypoint {
  const ctx = createExecutionContext();
  Object.defineProperty(ctx, "props", { value: authority === undefined ? undefined : { authority } });
  const mailEnv = mail ? { OWNER_EMAIL: mail, GSV_OWNER_EMAIL_FROM: "ship@example.com", GSV_OWNER_AUTH_SECRET: SECRET } : {};
  // SAFETY: The entrypoint reads only its binding props, the Accounts database and the owner mail settings.
  return new OwnerConfirmationsEntrypoint(ctx as never, { ...env, ...mailEnv } as never);
}
