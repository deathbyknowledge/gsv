import { z } from "zod";
import { ProductEmailConsent, PRODUCT_EMAIL_WORDING_VERSION, type ProductEmailPreference } from "./product-email";
import { readJsonObject } from "./http";
import { InstallationOwnerAuthStore, OwnerAuthError, type OwnerAuthErrorCode } from "./owner-auth-store";
import { InstallationOwnerStore } from "./owner-store";
import { InstallationSignup, type PendingSetup } from "./signup";
import { sendOwnerVerification } from "./owner-verification";
import { parseBaseDomain } from "./domain";

const secret = z.string().regex(/^[a-f0-9]{64}$/);
const challenge = z.strictObject({ challengeId: z.string().uuid(), browserSecret: secret, email: z.string().max(254), resend: z.boolean().optional(), productEmails: z.strictObject({ optedIn: z.boolean(), locale: z.enum(["en", "es", "pt-BR"]), wordingVersion: z.literal(PRODUCT_EMAIL_WORDING_VERSION) }).optional() });
const verification = z.strictObject({ challengeId: z.string().uuid(), browserSecret: secret, sessionSecret: secret, code: z.string().regex(/^\d{6}$/) });
const handle = z.string().trim().toLowerCase().max(63);
const cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "Authorization, Content-Type", "cache-control": "no-store" };
type OwnerApiReply = (Awaited<ReturnType<typeof sendOwnerVerification>> & { productEmailSaved?: boolean })
  | { email: string; expiresAt: number }
  | { email: string; expiresAt: number; spaceDomain: string; spaces: Awaited<ReturnType<InstallationOwnerStore["spaces"]>>; setups: PendingSetup[]; signupEnabled: boolean; invites: never[] }
  | Awaited<ReturnType<InstallationSignup["prepare"]>>
  | { ok: true } | { available: boolean } | ProductEmailPreference
  | { error: string; code?: OwnerAuthErrorCode | "signed_out" | "space_exists"; retryAt?: number };

/** Explicit bearer authentication; browser cookies never authorize this native API. */
export class InstallationOwnerApi {
  constructor(private readonly auth: InstallationOwnerAuthStore, private readonly owners: InstallationOwnerStore,
    private readonly signup: InstallationSignup, private readonly mail: SendEmail, private readonly from: string,
    private readonly origin: string, private readonly baseDomain: string, private readonly productEmails?: ProductEmailConsent) {}

  async handle(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/owner/api/")) return null;
    const json = (value: OwnerApiReply, status = 200) => Response.json(value, { status, headers: cors });
    if (url.origin !== this.origin) return json({ error: "Not found" }, 404);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    try {
      if (request.method === "POST" && url.pathname === "/owner/api/code") {
        const input = challenge.parse(await readJsonObject(request));
        const result = await sendOwnerVerification(this.auth, this.mail, this.from, {
          ...input, purpose: "login", ip: request.headers.get("cf-connecting-ip") ?? "local",
        });
        let productEmailSaved: boolean | undefined;
        if (input.productEmails) {
          productEmailSaved = false;
          try {
            if (this.productEmails) {
              if (input.productEmails.optedIn) await this.productEmails.stage(input.challengeId, input.productEmails.locale, input.productEmails.wordingVersion, Date.now(), request.headers.get("cf-connecting-ip") ?? undefined);
              else await this.productEmails.cancelIntent(input.challengeId);
              productEmailSaved = true;
            }
          } catch { /* Verification remains usable when the optional preference store is unavailable. */ }
        }
        return json({ ...result, productEmailSaved }, result.deliveryStatus === "sent" ? 200 : result.deliveryStatus === "sending" ? 202 : 503);
      }
      if (request.method === "POST" && url.pathname === "/owner/api/verify") {
        const input = verification.parse(await readJsonObject(request));
        const receipt = await this.auth.verify({ ...input, purpose: "login" });
        // Consent delivery is optional. A durable intent can be completed by the scheduled reconciler.
        await this.productEmails?.verified(receipt).catch(() => {});
        return json({ email: receipt.email, expiresAt: receipt.sessionExpiresAt });
      }
      const token = request.headers.get("authorization")?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
      const session = token ? await this.auth.session(token) : null;
      if (!session || !token) return json({ error: "Sign in to continue.", code: "signed_out" }, 401);
      if (url.pathname === "/owner/api/product-email") {
        if (!this.productEmails) return json({ error: "Product email preferences are unavailable." }, 503);
        if (request.method === "GET") { await this.productEmails.associate(session); return json(await this.productEmails.preference(session.email)); }
        if (request.method === "POST") {
          const input = z.strictObject({ optedIn: z.boolean(), revision: z.number().int().nonnegative(), locale: z.enum(["en", "es", "pt-BR"]), wordingVersion: z.string() }).parse(await readJsonObject(request));
          return json(await this.productEmails.set(session, input.optedIn, input.revision, input.locale, input.wordingVersion, Date.now(), request.headers.get("cf-connecting-ip") ?? undefined));
        }
      }
      if (request.method === "GET" && url.pathname === "/owner/api/session") {
        const [spaces, setups] = await Promise.all([this.owners.spaces(session.principalId), this.signup.pending(session.principalId)]);
        return json({ email: session.email, expiresAt: session.expiresAt, spaceDomain: parseBaseDomain(this.baseDomain), spaces, setups, signupEnabled: this.signup.enabled, invites: [] });
      }
      if (request.method === "POST" && url.pathname === "/owner/api/logout") {
        await this.auth.logout(token);
        return json({ ok: true });
      }
      // Older Desktop releases can still sign in; signup requires the new code-free client.
      if (url.pathname.startsWith("/owner/api/invites/")) return json({ error: "Update Ship to create your Ship." }, 410);
      if (request.method === "GET" && url.pathname === "/owner/api/handle") {
        return json({ available: await this.signup.available(handle.parse(url.searchParams.get("value") ?? "")) });
      }
      if (request.method === "POST" && url.pathname === "/owner/api/spaces") {
        const input = z.strictObject({ operationId: z.string().min(1).max(128), handle }).parse(await readJsonObject(request));
        return json(await this.signup.prepare(input.operationId, session.principalId, input.handle));
      }
      return json({ error: "Not found" }, 404);
    } catch (error) {
      if (error instanceof OwnerAuthError) {
        const message = error.code === "invalid" ? "Check the code and try again." : error.code === "expired" ? "This code has expired. Request a new one."
          : error.code === "rate_limited" ? "Wait before requesting another code." : error.code === "locked" ? "Too many attempts. Request a new code."
          : error.code === "credential_unavailable" ? "Use your existing sign-in method."
          : error.code === "email_restricted" ? "Use another email address to sign up." : "Could not verify. Try again.";
        return json({ error: message, code: error.code, retryAt: error.retryAt }, error.code === "rate_limited" ? 429 : 400);
      }
      if (error instanceof Error && error.message === "handle is invalid") {
        return json({ error: "Use letters, numbers or hyphens. Start and end with a letter or number." }, 400);
      }
      if (error instanceof Error && error.message.startsWith("You already have a Ship")) {
        return json({ error: error.message, code: "space_exists" }, 409);
      }
      const message = error instanceof Error && /^(handle is |Ship activation is unavailable|Ship activation failed|Registration is currently closed)/.test(error.message)
        ? error.message : error instanceof z.ZodError ? "Check the details and try again." : "Could not activate your Ship. Try again.";
      return json({ error: message }, 400);
    }
  }
}
